# Giao thức api ↔ browser-worker (Redis, v0.1.29)

browser-worker (`apps/browser`, ảnh `deploy/images/browser.Dockerfile`, dịch vụ `browser`) là tiến trình duy nhất chạy
Chromium (Playwright). Như bridge: **không** truy cập PostgreSQL, **không** giữ khoá master, **không** gọi model. Chỉ ở
mạng nội bộ `browser` (không ra Internet); lối ra duy nhất là `browser-egress` (chỉ `CONNECT :443` tới tên miền nền tảng,
chặn IP nội bộ, ghim DNS). Mã hai phía: `apps/api/gh/social/protocol.py` = `apps/browser/ghb/protocol.py` (bản sao,
cùng vectơ thử).

## Khoá browser

Secret riêng `gh_browser_key` (32 byte hex/base64; `GH_BROWSER_KEY_FILE`), chung cho api, worker (arq) và browser-worker.
`genh` tự sinh (cài mới + mọi lệnh vận hành trên bản cài cũ). Khoá con = `sha256(key ‖ "gh-browser:" ‖ mục đích)`.

- **Chữ ký**: mọi thông điệp là JSON có `sig = base64url(HMAC-SHA256(khoá con, JSON chuẩn hoá mọi trường trừ sig))`
  (orjson, khoá sắp xếp). Mục đích: `job` · `result` · `control` · `input` · `frame`.
- **Phiên khi truyền**: `seal = base64(nonce[12] ‖ AES-256-GCM(khoá con "transport"))`, AAD `<org_id>:<account_id>`.
  API giải rồi mã hoá phong bì bằng khoá master (`gh.crypto.encrypt`, AAD `social:<org>:<account>`) vào
  `core.social_accounts.state_enc`. Worker chỉ giữ phiên trong RAM trong lúc chạy việc.

## api → worker

`gh:browser:jobs` (stream, nhóm `browser`), trường `m`:
`{v:1, id, kind: login|health|read, org_id, account_id, platform, domains[], nonce, exp, payload, sig}`

| kind | payload |
|---|---|
| `login` | `{ticket, login_url, timeout_s}` — không có phiên |
| `health` | `{state: <seal>}` |
| `read` | `{state: <seal>, what: ["notifications","inbox"], limits: {max_pages ≤ 40, max_items ≤ 30}}` |

Worker bỏ im lặng khi: sai chữ ký · `exp` đã qua · `SET gh:browser:nonce:<nonce> NX EX 3600` thất bại (dùng lại).
Khoá 1 việc / tài khoản: `SET gh:browser:lock:<account_id> <job_id> NX EX (timeout+120)` — bận → kết quả `failed BUSY`.

`gh:browser:control` (pub/sub, đã ký): `{type:"halt"}` → huỷ mọi việc, đóng trình duyệt ngay · `{type:"cancel", job_id}`.
`gh:browser:halt` (key): còn thì worker không chạy việc nào (kiểm trước mỗi bước).

## worker → api

`gh:browser:results` (stream, nhóm `api` — consumer trong tiến trình api), trường `m`:
`{v:1, job_id, account_id, org_id, type, data, state?: <seal>, ts, sig}`

| type | data |
|---|---|
| `started` | — |
| `login.done` | `{handle}` + `state` |
| `done` | read: `{items:[{kind, who, text, time, unread, link}], pages, page_state, cost}` + `state` (phiên làm mới) |
| `failed` / `login.failed` | `{code: CHECKPOINT|CAPTCHA|LOGGED_OUT|BLOCKED_URL|SELECTOR|LOGIN_TIMEOUT|CANCELLED|BUSY|ERROR}` |
| `halted` | — |

API: việc đã đóng (huỷ/dừng/hết hạn) → bỏ kết quả đến muộn (kể cả phiên). `CHECKPOINT`/`CAPTCHA` → tài khoản `paused`
+ chuông Owner; `LOGGED_OUT` → `needs_login`; 3 lỗi liên tiếp → `paused`. Nội dung đọc được làm sạch (ký tự điều khiển,
độ dài, link ngoài tên miền) + gắn cờ `suspicious`; với Gen luôn nằm trong khối DỮ LIỆU KHÔNG TIN CẬY.

`gh:browser:heartbeat` (key, TTL 45 s): `{version, at, running}`.

## Cửa sổ đăng nhập (chỉ lúc đăng nhập)

- Web mở `WS /api/v1/social/login/{ticket}` (chỉ đúng Owner đã mở vé; vé 32 byte, hết hạn 12 phút).
- Worker → `gh:browser:frames:<ticket>` (đã ký): `{t:"frame", data: <jpeg base64>, w, h}` (CDP `Page.startScreencast`,
  ≤ ~8 khung/giây) · `{t:"status", state: waiting|logged_in|cancelled|timeout, message}`. API chuyển cho web.
- Web → API → `gh:browser:input:<ticket>` (API lọc + ký): `mouse {action, x, y, button}` · `wheel {dx, dy, x, y}` ·
  `key {action, key ∈ danh sách}` · `text ≤ 256` · `nav back|reload` · `done` · `cancel`. Không lưu, không ghi log.
- Worker thấy đã đăng nhập (cookie `c_user`, không ở trang checkpoint/đăng nhập) → `login.done` kèm phiên.

## Ghi (v0.1.30 — chưa có)

Đăng/trả lời/nhắn đi qua đề xuất Gen → Owner Xác nhận (PIN) → permit ký bằng khoá browser (`gh/social/permit.py`,
`Adapter.write`). Bản v0.1.29 không có đường ghi nào.
