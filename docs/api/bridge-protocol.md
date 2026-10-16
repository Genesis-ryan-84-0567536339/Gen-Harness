# Giao thức Bridge ↔ lõi (Redis Streams)

Bridge (`apps/bridge`, Node 20) là tiến trình duy nhất nói chuyện với Zalo (`zca-js`) và WhatsApp (Baileys). Nó **không** truy cập PostgreSQL, **không** gọi LLM, **không** tự quyết định trả lời. Mọi trao đổi với lõi đi qua Redis Streams theo envelope chuẩn (`src/envelope.js`, khớp `gh/chassis/bus.py`):

```
event_id (UUIDv7) · type · org_id · correlation_id · actor ("bridge:<channel>") · occurred_at (ISO) · schema_version (1) · payload (JSON)
```

Bridge đọc stream bằng consumer group `bridge` (tên consumer = hostname), ack sau khi xử lý.

## Khoá bridge

Secret riêng `gh_bridge_key` (32 byte base64; `GH_BRIDGE_KEY_FILE` hoặc `GH_BRIDGE_KEY`), chung cho api, worker, bridge. Khoá master **không** được đưa cho bridge.

- **Mã hoá phiên khi truyền**: `AES-256-GCM(key = sha256(bridge_key ‖ "transport"))`, chuỗi `base64(nonce[12] ‖ ciphertext ‖ tag[16])`, AAD = `"<channel>:<session_id>"`. Lõi giải mã rồi mã hoá phong bì bằng khoá master vào `core.channel_sessions.credential_enc`; bridge chỉ giữ phiên trong RAM.
- **Permit gửi tin**: `base64url(JSON claims) + "." + base64url(HMAC-SHA256(key = sha256(bridge_key ‖ "permit"), phần trước dấu chấm))`.
  Claims: `{"nonce", "draft_id", "channel", "thread_id", "thread_type": "group"|"user", "body_sha256" (hex của text UTF-8), "exp" (epoch giây)}`.
  Bridge chỉ gửi khi: chữ ký đúng (so sánh hằng thời gian) · `exp` chưa qua · `channel`, `thread_id`, `thread_type` khớp lệnh · `sha256(text)` khớp · `SET gh:permit:used:<nonce> 1 NX EX 600` thành công (dùng một lần). Sai bất kỳ điều gì → không gửi, trả `send.result` `ok:false` kèm `error` (`PERMIT_INVALID|PERMIT_EXPIRED|PERMIT_MISMATCH|PERMIT_REUSED`).

## Lõi → bridge

`gh.bridge.control`
| type | payload |
|---|---|
| `session.login` | `{channel, session_id, credential: "<transport>"\|null}` — có credential: đăng nhập lại bằng phiên đã lưu; hỏng/hết hạn → `session.ended reason=expired`. `null`: sinh QR mới. |
| `session.logout` | `{channel, session_id}` — đăng xuất trên nền tảng, xoá phiên khỏi RAM, trả `session.ended reason=logged_out`. |
| `directory.sync` | `{channel, session_id}` — đồng bộ nhóm ngay. |

`gh.bridge.outbound`
| type | payload |
|---|---|
| `message.send` | `{channel, session_id, thread_id, thread_type, text, permit}` |

## Bridge → lõi

`gh.bridge.status`
| type | payload |
|---|---|
| `bridge.hello` | `{channels: ["zalo","whatsapp"], version}` — khi khởi động; lõi trả `session.login` cho mọi phiên đang `active` kèm credential. |
| `session.qr` | `{channel, session_id, image: "data:image/png;base64,…", expires_at}` — mỗi QR mới (QR hết hạn → bridge tự xin QR mới, tối đa 5 lần rồi `session.ended reason=expired`). WhatsApp: khi máy chủ gửi `companion_reg_refresh` cho thiết bị chưa ghép cặp, bridge luôn đổi khoá ghép cặp; nếu đã có mã đang hiện thì gửi lại ĐÚNG mã đó (cùng `expires_at`, không tính vào 5 mã), chưa có mã thì chỉ đổi khoá (mã đầu mang khoá mới). Mã WhatsApp dày (≈ 57 ô, mức sửa lỗi L, vùng trắng 4 ô, ảnh 640px) nên Console vẽ ảnh lớn: tới 320px, co theo bề rộng thẻ (không dùng khối 88px như Zalo). |
| `session.scanned` | `{channel, session_id, display_name?}` |
| `session.active` | `{channel, session_id, account: {id, name, phone?}, credential: "<transport>"}` |
| `session.credential` | `{channel, session_id, credential}` — phiên được làm mới (Baileys `creds.update`, gộp tối đa 1 lần / 5 giây). |
| `session.ended` | `{channel, session_id, reason: "expired"\|"logged_out"\|"error", error?}` — `error` là mã ngắn, Console đổi sang câu tiếng Việt thân thiện + «Chi tiết kỹ thuật»: `QR_EXPIRED` · `PAIRING_REJECTED` (401 khi đang ghép bằng QR) · `WA_NETWORK` / `WA_NO_QR_<mã>` (socket WhatsApp đóng 4 lần liên tiếp, cách nhau 2s·4s·8s, trước khi ra mã QR đầu tiên; riêng 403 không thử lại mà kết thúc ngay bằng `FORBIDDEN`) · `CREDENTIAL_REJECTED\|INVALID\|UNREADABLE` · `LOGGED_OUT_REMOTELY` · `CONNECTION_REPLACED` · `FORBIDDEN` · `MULTIDEVICE_MISMATCH` · `RECONNECT_FAILED` · `BRIDGE_KEY_MISSING` · `LOGIN_FAILED` · `NO_LOGIN_INFO` (Zalo quét xong nhưng không có thông tin đăng nhập) · `CHANNEL_UNAVAILABLE` (bridge không tạo được adapter của kênh). |
| `heartbeat` | `{channel, session_id, latency_ms, queued}` — mỗi 15 giây cho mỗi phiên đang hoạt động. Ngoài ra bridge đặt `gh:bridge:heartbeat` (TTL 45s) như giai đoạn 1. |
| `send.result` | `{nonce, draft_id, channel, ok, external_msg_id?, error?}` |

`gh.bridge.directory`
| type | payload |
|---|---|
| `groups` | `{channel, session_id, groups: [{external_id, name, member_count, members: [{external_id, name, phone?}]}]}` — khi đăng nhập xong, mỗi 30 phút, và khi có `directory.sync`. `members` có thể rỗng nếu nền tảng không cho lấy. |

`gh.bridge.inbound`
| type | payload |
|---|---|
| `message` | `{channel, session_id, external_msg_id, external_group_id\|null, group_name?, sender_external_id, sender_name, sender_phone?, occurred_at, kind: "text"\|"image"\|"file"\|"sticker"\|"reaction"\|"system"\|"other", body_text\|null, direction: "inbound"\|"outbound", mentions_self: bool, payload: {…nguyên văn từ thư viện…}}` |

## Chỉ nghe nhóm đã bật (khoá cứng)

Lõi giữ tập `gh:bridge:listen:<channel>` = mã nhóm phía nền tảng có `listen_mode` khác `off`/`paused`, và khoá `gh:bridge:listen_direct:<channel>` = `"1"` nếu Owner cho nghe tin 1-1. Bridge kiểm tra **trước khi** XADD: tin nhóm không thuộc tập → bỏ ngay (không lưu, không log nội dung). Lõi kiểm lần hai ở ingest. Tin của chính tài khoản (outbound) cũng theo luật này.

## Ánh xạ thư viện (theo bridge của dự án cũ)

- **Zalo** `zca-js`: `new Zalo({selfListen: true, imageMetadataGetter})`; phiên đã lưu → `zalo.login(credential)`; mới → `zalo.loginQR({}, cb)` với `LoginQRCallbackEventType.QRCodeGenerated` (`evt.data.image` base64 PNG), `QRCodeScanned`, `GotLoginInfo` (`evt.data` = credential `{imei, cookie, userAgent}`), `QRCodeExpired`/`QRCodeDeclined` → `evt.actions.retry()` hoặc `abort()`. Tin: `api.listener.on('message', msg)` — `msg.threadId`, `msg.type` (`ThreadType.Group|User`), `msg.data.uidFrom`, `msg.data.dName`, `msg.data.msgId`, `msg.data.ts`, `msg.data.content` (chuỗi hoặc object), `msg.data.mentions`, `msg.isSelf`. Nhóm: `api.getAllGroups()` → `gridVerMap`; `api.getGroupInfo(ids).gridInfoMap[id]` (`name`, `totalMember`, `memVerList`). Gửi: `api.sendMessage({msg}, threadId, ThreadType)`.
- **WhatsApp** Baileys (ghim chính xác `7.0.0-rc14` — bản mới nhất trên npm; không dùng `^`): `version` lấy từ `fetchLatestWaWebVersion()` (GET sw.js của web.whatsapp.com, nhớ 30 phút, không bao giờ cũ hơn bản đóng gói) với user-agent TỰ NHẬN `Gen-Harness-bridge/<phiên bản bridge>` và `sec-fetch-site: cross-site` — ghi đè mặc định giả Chrome của Baileys (luật cứng: không né chống bot); WhatsApp từ chối hay lỗi thì để thư viện dùng bản đóng gói. `makeWASocket({version, auth, printQRInTerminal: false, logger: pino silent})`, trạng thái xác thực giữ trong RAM (`initAuthCreds` + `BufferJSON`) và tuần tự hoá thành credential; `connection.update` (`qr` → PNG data URL bằng `qrcode`, `connection === 'open'`, `DisconnectReason.loggedOut`), `messages.upsert` (`type === 'notify'`; text `m.message.conversation` hoặc `extendedTextMessage.text`; nhóm khi `remoteJid` kết thúc `@g.us`, người gửi `m.key.participant`, `m.pushName`, `m.key.fromMe`), `groupFetchAllParticipating()`, `sock.sendMessage(jid, {text})`.
