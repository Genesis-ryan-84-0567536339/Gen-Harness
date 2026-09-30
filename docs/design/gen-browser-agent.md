# Gen điều khiển mạng xã hội thay Boss (Đợt D3 — bản nháp thiết kế)

> Trạng thái: lát đầu (§5.1) ĐÃ LÀM ở **v0.1.29** theo quyết định Boss 30/09 ("có công cụ, dùng hay không do Owner quyết,
> cảnh báo rủi ro rõ"). Khác bản nháp: mã worker ở `apps/browser/ghb` (gói riêng, không có mã `gh`/DB); hàng đợi là Redis
> Stream đã ký HMAC thay cho arq (arq dùng pickle); migration `0021_v0129_social`; không có cờ `social.enabled` — thêm
> tài khoản + tích chấp nhận rủi ro là bật, "Dừng tất cả" là tắt; Owner-only dùng `require_owner` (không thêm quyền mới).
> Giao thức: `docs/api/browser-protocol.md`. Thay mục "D3 Playwright cho agent vòng ngoài" trong `docs/ROADMAP.md`.
> Nguồn đã đọc: `CLAUDE.md`, `docs/ROADMAP.md`, `docs/design/gen-v1.md` (§5, §10), `docs/design/gen-hub-link.md`,
> `apps/api/gh/gen/{jev,decider,engine,proposals}.py`, `apps/bridge/` + `docs/api/bridge-protocol.md`,
> `apps/api/gh/crypto.py`, `gh/worker.py`, `gh/chassis/objects.py`, `deploy/compose.yaml`.
> Chỉ là thiết kế — chưa có dòng code nào.

## 0. Tóm tắt cho Boss (đọc 30 giây)

- Mục tiêu: Gen đọc & tóm tắt tin nhắn/bình luận/thông báo trên mạng xã hội **của chính Boss**, soạn trả lời, đăng bài —
  **Boss bấm Xác nhận mới gửi** (như thẻ đề xuất hiện có).
- **Đi API chính thức trước** (Trang Facebook, Instagram chuyên nghiệp, Zalo OA, TikTok, LinkedIn, X): không lo bị khoá.
- **Trình duyệt tự động (Playwright) chỉ dùng cho tài khoản cá nhân** không có API. Mọi nền tảng lớn đều **cấm** tự động
  hoá kiểu này trong điều khoản → có rủi ro bị hạn chế/khoá tài khoản. Boss phải bấm "Tôi chấp nhận rủi ro" cho từng tài
  khoản (giống cách Zalo/WhatsApp cá nhân đang làm).
- Boss **tự đăng nhập** trong một cửa sổ trình duyệt hiện ngay trong Gen-Harness; hệ thống không lưu mật khẩu/mã 2FA,
  chỉ lưu phiên (cookie) đã mã hoá.
- **Bản đầu v0.1.28**: màn "Tài khoản mạng xã hội" + đăng nhập + Gen **chỉ đọc** thông báo/hộp tin của **1 nền tảng**
  (đề xuất Facebook cá nhân) rồi tóm tắt. Chưa gửi/đăng gì.
- Jev (đã có) làm việc rẻ & nhanh: phân loại từng tin (gấp/cần trả lời/quảng cáo), nhận biết trạng thái trang.
  Tóm tắt và soạn trả lời vẫn dùng model chính. Jev lỗi → tự rơi về model chính/quy tắc.

## 1. Luật cứng (không thương lượng)

1. **Chỉ tài khoản thật của Boss/công ty**, do chính chủ đăng nhập. **Không tạo tài khoản giả, tài khoản phụ, nick ảo**,
   không mua/thuê tài khoản, không đăng nhập hộ người khác.
2. **Không lách chống-bot**: không plugin "stealth", không giả vân tay trình duyệt, không xoay proxy/IP, không giải
   CAPTCHA tự động, không vượt checkpoint. Gặp CAPTCHA/checkpoint/"hoạt động bất thường" → **dừng tài khoản đó**, báo
   Boss, Boss tự xử lý trong cửa sổ trực tiếp. Giới hạn tốc độ "như người" ở §3.4 là để **dùng ít và lịch sự**, không
   phải để nguỵ trang.
3. **Mọi thao tác ghi** (đăng, trả lời, nhắn, thích, theo dõi, kết bạn, sửa hồ sơ) = **đề xuất** qua luồng
   Xác nhận/Sửa/Huỷ; nhạy cảm cần PIN; ghi Action Log. Không có chế độ "tự đăng".
4. Không spam, không nhắn hàng loạt người lạ, không cào dữ liệu người khác để bán/lập hồ sơ. Chỉ đọc những gì Boss
   tự thấy được khi đăng nhập.
5. Nội dung trang web là **dữ liệu không tin cậy** — không bao giờ là mệnh lệnh cho Gen (§3.6).

## 2. Từng nền tảng: API chính thức hay trình duyệt?

Tra cứu 30/09/2026 (web search; trang điều khoản gốc bị chặn mạng từ máy build nên dựa vào bản trích dẫn — ghi rõ).

| Nền tảng | API chính thức làm được gì | Tự động hoá trình duyệt — điều khoản & rủi ro | Đề xuất |
|---|---|---|---|
| **Facebook — Trang** | Pages API: đọc/đăng bài (`pages_manage_posts`), bình luận (`pages_manage_engagement`), Messenger của Trang (`pages_messaging`); phần lớn quyền cần App Review, riêng app ở chế độ phát triển dùng được cho chính admin [1][2] | Không cần | **API** |
| **Facebook — cá nhân** | Không có API đăng/đọc tin cho trang cá nhân (theo hiểu biết, *chưa kiểm lại 2026*) | Điều khoản Meta 3.2.3: "không được truy cập hoặc thu thập dữ liệu bằng phương tiện tự động (khi chưa được phép)", kể cả khi đã đăng nhập [3]. Rủi ro: checkpoint, khoá tạm/vĩnh viễn | **Trình duyệt**, chỉ đọc trước, tần suất thấp, Boss chấp nhận rủi ro |
| **Instagram** | Chỉ tài khoản **chuyên nghiệp** (Business/Creator): đọc/gửi DM (Messaging API), quản lý bình luận, đăng bài; Creator không cần gắn Trang FB; token ~60 ngày [4] | Cùng điều khoản Meta [3] | **API** (đổi sang tài khoản chuyên nghiệp — miễn phí); tài khoản cá nhân → trình duyệt, rủi ro như FB |
| **Zalo — OA** | OA API + webhook tin nhắn, ZNS gửi tin mẫu [5][6] | Không cần | **API** (nếu công ty có OA) |
| **Zalo — cá nhân** | Không có | Điều khoản Zalo cấm dùng phần mềm bên thứ ba chưa được cấp phép để truy cập dịch vụ [7]. **Đã có** bridge `zca-js` + `risk_accepted_by` | **Giữ bridge hiện có** — không làm lại bằng trình duyệt |
| **WhatsApp** | (Cloud API cho doanh nghiệp — *chưa kiểm tra trong đợt này*) | Bridge Baileys đã có | **Giữ bridge hiện có** |
| **TikTok** | Content Posting API: đăng video; app chưa qua kiểm duyệt chỉ đăng được chế độ riêng tư (SELF_ONLY), ≤5 người/24h [8]. Đọc bình luận/DM qua API: *chưa kiểm tra* | Điều khoản TikTok cấm bot/script/cào dữ liệu không chính thức; follow/like/comment/DM tự động có thể bị khoá [9] | **API** để đăng; đọc DM/bình luận → trình duyệt sau, rủi ro cao |
| **X (Twitter)** | Từ 2026 trả theo lượt: ~$0.015/bài đăng, $0.20 nếu có link, $0.005/bài đọc [10] | Cấm cào "dưới mọi hình thức" khi chưa có văn bản đồng ý; bồi thường ấn định $15.000/1 triệu bài/24h [11] | **API** (chi phí nhỏ với lượng dùng của Boss); không dùng trình duyệt |
| **LinkedIn** | Đăng bài/bình luận thay thành viên (`w_member_social`); **nhắn tin không có** API công khai; `r_member_social` đóng [12] | Mục 8.2 cấm bot/phương thức tự động để truy cập, gửi tin, bình luận, thích…; phát hiện cả trình duyệt headless [13]. **Rủi ro cao nhất** | **API** để đăng; đọc tin nhắn bằng trình duyệt chỉ khi Boss chấp nhận rủi ro cao |

Kết luận: **API trước ở mọi nơi có API**; trình duyệt chỉ cho FB/IG cá nhân (và sau này TikTok/LinkedIn phần đọc).
Tất cả cổng API đi chung một mô-đun `gh/social/` để Gen thấy một giao diện thống nhất, không phân biệt API hay trình duyệt.

## 3. Kiến trúc

```
Web: màn "Tài khoản mạng xã hội" ── WS luồng ảnh + phím/chuột (chỉ lúc đăng nhập) ──┐
     Gen (thẻ tóm tắt / thẻ đề xuất)                                               │
                │                                                                    │
apps/api  gh/social/ (routes, service, adapters API) ── arq queue "gh:browser" ──► browser-worker (container riêng)
          ├ lưu phiên mã hoá (khoá master)          ◄── kết quả + ảnh chụp/trace ──  Playwright + Chromium
          ├ Gen tool social.* (chỉ đọc)                                             không DB, không khoá master
          └ đề xuất ghi → Xác nhận → permit ký HMAC ──► worker chỉ ghi khi permit hợp lệ
                                                                      egress proxy (danh sách tên miền cho phép)
```

### 3.1 browser-worker (container mới)
- Ảnh `deploy/images/browser.Dockerfile` (gốc Playwright Python chính thức), dịch vụ `browser` trong `deploy/compose.yaml`.
  Chạy `arq gh.social.browser_worker.WorkerSettings` với `queue_name="gh:browser"` — tách khỏi worker chính.
- **Như bridge**: chỉ nói với Redis; **không** truy cập Postgres, **không** giữ `gh_master_key`, **không** gọi model.
  Nhận secret riêng `gh_browser_key` (mã hoá phiên khi truyền + ký permit — cùng kiểu `bridge-protocol.md`).
- Chạy user không root, `read_only` rootfs + tmpfs, giới hạn RAM/CPU (Chromium ~300–500 MB/ngữ cảnh — *ước tính,
  chưa đo*), `max_jobs=2`, không mount volume dữ liệu.
- Mạng: chỉ vào mạng nội bộ (redis) + một **proxy ra ngoài** chỉ cho phép tên miền của nền tảng đã bật
  (vd `facebook.com`, `fbcdn.net`, `messenger.com`); chặn IP nội bộ/riêng (giống ghim DNS Gen-hub v0.1.27).
- Mỗi việc mở **ngữ cảnh trình duyệt mới** từ phiên đã lưu, xong thì đóng; không giữ profile trên đĩa.

### 3.2 Đăng nhập (Boss tự làm)
1. Boss bấm **Thêm tài khoản** → chọn nền tảng → đọc cảnh báo điều khoản → bấm **Tôi chấp nhận rủi ro** (lưu
   `risk_accepted_by/at`) → nhập PIN.
2. Worker mở Chromium (headed trong Xvfb) tới trang đăng nhập chính thức. Ảnh màn hình được truyền về Gen-Harness bằng
   **CDP screencast** (`Page.startScreencast`, JPEG ~5–10 khung/giây) qua WS; chuột/phím của Boss gửi ngược bằng
   `Input.dispatch*`. (Phương án B: noVNC — nặng hơn, chỉ dùng nếu screencast lỗi.)
3. Boss tự gõ mật khẩu, 2FA, giải CAPTCHA nếu có. **Nói thẳng**: phím gõ đi qua kênh WS (TLS) tới worker như gõ bàn
   phím từ xa; hệ thống **không ghi log, không lưu** phím/khung hình lúc đăng nhập, không có ô nhập mật khẩu nào của ta.
4. Khi nhận ra đã vào trang chủ (quy tắc DOM của adapter) → worker lấy `storageState` (cookie + localStorage + IndexedDB),
   mã hoá bằng khoá truyền → API giải mã, **mã hoá phong bì bằng khoá master** (`gh/crypto.encrypt`, AAD =
   `org_id:account_id`) lưu `core.social_accounts.state_enc`. Phiên đăng nhập hết giờ sau 10 phút nếu Boss bỏ dở.
- **Kiểm sức khoẻ phiên**: job `social_health` 1 lần/ngày + trước mỗi việc: mở trang nhẹ, kiểm dấu hiệu đã đăng nhập.
  Hết hạn → trạng thái `needs_login`, chuông báo Boss, nút **Đăng nhập lại** (lặp bước 2–4).
- **Thu hồi**: nút **Gỡ tài khoản** (PIN) → xoá `state_enc`, huỷ việc đang chờ, ghi Action Log; nhắc Boss tự bấm
  "đăng xuất mọi thiết bị" trên nền tảng nếu muốn chắc chắn.

### 3.3 Hàng đợi & việc
- Loại việc (adapter mỗi nền tảng khai báo): đọc `read_notifications`, `read_inbox`, `read_comments`; ghi
  `post`, `reply_comment`, `send_dm`, `like`, `follow` (ghi chỉ từ v0.1.30).
- **Mỗi tài khoản chạy tối đa 1 việc cùng lúc**: khoá Redis `gh:browser:lock:<account_id>` (SET NX, hết hạn theo trần
  thời gian việc); việc sau xếp hàng.
- Mỗi việc lưu **ảnh chụp** các bước chính + **Playwright trace** (zip) vào `gh/chassis/objects` (volume `gh_objects`
  qua API — worker gửi về, không tự ghi); giữ 14 ngày (job dọn).

### 3.4 Giới hạn tốc độ (dùng ít, lịch sự)
- Mặc định mỗi tài khoản: đọc ≤ 6 lượt/ngày, ≤ 40 trang mở/lượt; nghỉ ngẫu nhiên 2–6 giây giữa thao tác; ghi ≤ 20/ngày,
  ≥ 60 giây giữa 2 lần ghi; không chạy 23:00–06:00. Owner chỉnh được **xuống**, không vượt trần cứng trong code.
- Đọc chỉ khi Boss hỏi Gen hoặc theo lịch Boss bật — không quét liên tục.

### 3.5 Ghi = đề xuất (tái dùng A4)
- Gen trả `{"kind":"propose","proposal":{"type":"social_post|social_reply|social_dm|social_like|social_follow", …}}` →
  `gh/gen/proposals.py` thêm các loại này; target registry `social.accounts` đánh dấu `sensitive` → **luôn cần PIN**.
- Thẻ đề xuất do hệ thống viết: tài khoản nào, gửi cho ai/bài nào, nguyên văn nội dung. Boss Xác nhận/Sửa/Huỷ.
- Xác nhận → API ký **permit** (như bridge): `{nonce, account_id, action, target_url_hash, body_sha256, exp}`; worker chỉ
  làm khi chữ ký đúng, chưa hết hạn, nội dung khớp hash, nonce dùng một lần. Không permit = không ghi, kể cả khi model
  bị lừa.
- Action Log: `social.read` (actor agent/gen, on_behalf_of), `gen.proposal_confirmed` với `detail.via="gen"`,
  `social.write` (kết quả + id ảnh chụp sau khi gửi).

### 3.6 Chống prompt injection từ nội dung trang
- Adapter trích **văn bản có cấu trúc** bằng selector cố định (người gửi, thời gian, nội dung, link) — không đưa HTML thô.
- Mọi nội dung vào model bọc bằng `wrap_untrusted()` sẵn có (`gh/gen/engine.py`); cắt ≤ 4 KB/mục.
- Model **không bao giờ** được chọn selector/URL tự do: bước "bấm gì tiếp" là chọn trong danh sách phần tử adapter liệt
  kê từ trang hiện tại (id phải vừa xuất hiện — như validator Gen v1). URL ngoài danh sách tên miền → chặn.
- Nội dung đòi "bỏ qua chỉ dẫn", "gửi mã", "chuyển tiền" → vẫn chỉ là dữ liệu; ghi chú cờ `suspicious` trên thẻ tóm tắt.

### 3.7 Công tắc dừng khẩn
- Nút **Dừng tất cả** (Owner, PIN) ở màn Tài khoản mạng xã hội + lệnh Gen: đặt `gh:browser:halt`; worker kiểm cờ trước
  **mỗi bước**, huỷ việc, đóng mọi trình duyệt; hàng đợi không nhận việc mới tới khi Owner bật lại.
- Dừng từng tài khoản: trạng thái `paused`.
- **Tự dừng**: phát hiện checkpoint/CAPTCHA/cảnh báo bất thường/đăng xuất bất ngờ, hoặc 3 lỗi liên tiếp → tài khoản
  `paused` + chuông báo Boss. Cờ tổng `social.enabled` (tắt mặc định).

## 4. Chọn model (Jev vs model chính)

Jev hiện chỉ làm **chọn 1 trong danh sách** (`JevClient.choose` → `Choice`), nên dùng đúng vào việc đó:

| Bước | Ai làm | Ghi chú |
|---|---|---|
| Trích nội dung trang | **Code** (selector adapter) | Không tốn model |
| Nhận biết trạng thái trang: `ok / need_login / checkpoint / captcha / empty / lỗi` | Quy tắc DOM trước; mơ hồ → **Jev** | Sai → mặc định an toàn = dừng |
| Phân loại từng tin/bình luận: `gấp / cần trả lời / thông tin / quảng cáo / rác` | **Jev** | Tái dùng `decider.classify` kiểu C1 |
| Bước kế tiếp: `cuộn thêm / mở mục X / dừng` | **Jev**, chọn trong danh sách adapter đưa | |
| Tóm tắt cho Boss, soạn trả lời/bài đăng | **Model chính** (`core.gen`, chuỗi Bộ não AI) | Chất lượng câu chữ |
| Đọc ảnh chụp khi selector hỏng | Model chính có thị giác (nếu có), không thì báo lỗi adapter | Hiếm |

- **Fallback**: `JevError`/chậm > 1,5 s/độ tin cậy < 0,5 → quy tắc tất định (phân loại) hoặc model chính (quyết định);
  không có model nào → vẫn trả danh sách thô không tóm tắt.
- **Cấu trúc chi phí** (chưa có số đo — mọi con số dưới đây là *ước tính để điền sau khi chạy thật*):
  `chi phí 1 lượt đọc ≈ N_mục × giá 1 lượt Jev + 1 lượt tóm tắt model chính (token vào ≈ N_mục × ~150) + 0 cho trích`.
  Số đo thật lấy từ `agent.model_calls` (đã ghi mỗi lượt gọi) + cột mới `browser_jobs.cost` — hiện trên thẻ việc.
- **Boss cần cung cấp**: khoá **OpenRouter** gắn vào nguồn model kind `system_one` (Agent & Model → Thêm nguồn Jev)
  — đã có sẵn từ v0.1.21. Không có Jev vẫn chạy được, chỉ chậm/đắt hơn chút.

## 5. Kế hoạch theo lát

| Bản | Lát | Nhìn thấy |
|---|---|---|
| **v0.1.28** | Hạ tầng + đăng nhập + **chỉ đọc** thông báo & danh sách hội thoại (xem trước) của **1 nền tảng** (mặc định Facebook cá nhân); Gen tóm tắt khi Boss hỏi | "Gen, Facebook có gì mới?" → thẻ tóm tắt + phân loại |
| v0.1.29 | **API**: Trang Facebook + Instagram chuyên nghiệp (Graph API, OAuth) — đọc bình luận/tin nhắn đổ vào Hộp thư ý nghĩa | Tin Trang/IG vào Hộp thư, không rủi ro khoá |
| v0.1.30 | **Ghi có xác nhận**: trả lời bình luận/đăng bài (API trước, trình duyệt cho FB cá nhân) qua đề xuất + PIN + permit | Boss bấm Xác nhận → đăng thật, có ảnh chụp |
| v0.1.31 | Zalo OA API; TikTok Content Posting API; LinkedIn đăng bài API | Đăng đa nền tảng từ 1 thẻ |
| sau | X API (trả theo lượt); IG/TikTok/LinkedIn cá nhân đọc bằng trình duyệt (từng nền tảng, Boss chấp nhận rủi ro riêng) | |

### 5.1 Chi tiết v0.1.28
- **Migration** `apps/api/migrations/versions/0021_v0128_social.py`:
  - `core.social_accounts(id, org_id, platform, mode['api'|'browser'], label, external_handle, status['pending_login'|
    'active'|'needs_login'|'paused'|'revoked'], state_enc bytea, state_updated_at, last_health jsonb,
    risk_accepted_by, risk_accepted_at, created_by, created_at, revoked_at)` + RLS theo org như bảng khác.
  - `agent.browser_jobs(id, org_id, account_id, kind, status['queued'|'running'|'done'|'failed'|'halted'], requested_by,
    via['gen'|'user'|'schedule'], result jsonb, artifacts jsonb, cost jsonb, error, created_at, started_at, finished_at)`.
  - Cờ `social.enabled` (tắt mặc định); vào `backup.py` (state_enc vẫn mã hoá).
- **API** `apps/api/gh/social/` (`routes.py, service.py, adapters/facebook.py, jobs.py, permit.py`), gắn `/api/v1/social`:
  - `GET/POST /social/accounts` · `POST /social/accounts/{id}/login` (PIN, trả vé WS) · `WS /social/login/{ticket}` ·
    `POST /social/accounts/{id}/check` · `POST /social/accounts/{id}/pause|resume` · `DELETE /social/accounts/{id}` (PIN)
  - `POST /social/jobs {account_id, kind}` · `GET /social/jobs/{id}` (kèm link ảnh chụp) · `POST /social/halt` /
    `DELETE /social/halt` (Owner, PIN). Quyền mới `social.read`, `social.manage` (Owner).
- **Worker trình duyệt** `apps/api/gh/social/browser_worker.py` + `deploy/images/browser.Dockerfile` + dịch vụ `browser`
  và proxy ra ngoài trong `deploy/compose.yaml`; secret `gh_browser_key` (`genh` sinh như `gh_bridge_key`).
- **Gen**: tool `social.summary {account_id?, kind}` trong `gh/gen/tools.py` (xếp việc, đợi ≤ 60 s, trả tóm tắt; lâu hơn
  → chuông khi xong); target `social.accounts` trong `packages/contracts/src/genTargets.ts`.
- **Web**: `apps/web/src/screens/social/SocialAccountsScreen.tsx` (danh sách, trạng thái, nút), `LoginViewer.tsx`
  (canvas nhận khung, gửi chuột/phím), mục menu "Tài khoản mạng xã hội".
- **Test**: pytest adapter Facebook trên **trang HTML mẫu lưu sẵn** (không gọi facebook.com trong CI), khoá 1 việc/tài
  khoản, halt giữa chừng, bọc untrusted, mã hoá phiên khứ hồi; vitest màn + viewer; e2e trên mock. Nghiệm thu thật: Boss
  đăng nhập tài khoản thật 1 lần.

## 6. Rủi ro & câu hỏi cho Boss

Rủi ro chính: **bị khoá tài khoản cá nhân** (điều khoản mọi nền tảng cấm tự động hoá — giảm bằng chỉ đọc, tần suất thấp,
tự dừng khi có cảnh báo; không loại bỏ được); giao diện nền tảng đổi làm hỏng selector (test trên trang mẫu + báo lỗi
adapter rõ ràng); lộ phiên đăng nhập (mã hoá bằng khoá master, worker không giữ khoá, thu hồi 1 nút); prompt injection
(§3.6 + permit).

1. **Nền tảng đầu tiên?** — Mặc định: **Facebook cá nhân**, chỉ đọc thông báo + danh sách hội thoại.
2. **Chấp nhận rủi ro khoá tài khoản cá nhân khi tự động hoá trình duyệt?** — Mặc định: **có, chỉ đọc**, Boss bấm chấp
   nhận từng tài khoản; ghi (đăng/trả lời) bằng trình duyệt để sau v0.1.30.
3. **Công ty có Trang Facebook / Instagram chuyên nghiệp / Zalo OA không?** — Mặc định: có thì làm **API** ở v0.1.29
   (an toàn hơn hẳn); Boss cần là admin Trang để cấp quyền.
4. **Gen tự đọc bao lâu một lần?** — Mặc định: **chỉ khi Boss hỏi + 2 lần/ngày (08:00, 17:00)**.
5. **X (Twitter) trả tiền theo lượt — có dùng không?** — Mặc định: **hoãn**, làm khi Boss cần.

## Nguồn
[1] Facebook Pages API — https://developers.facebook.com/documentation/pages-api ·
[2] Permissions Reference — https://developers.facebook.com/docs/permissions/ ·
[3] Meta Terms 3.2.3 & Automated Data Collection Terms — https://www.facebook.com/terms ,
https://www.facebook.com/legal/automated_data_collection_terms (trích qua kết quả tìm kiếm) ·
[4] Instagram APIs — https://developers.facebook.com/products/instagram/apis/ , https://zernio.com/blog/instagram-api ·
[5] Zalo OA API — https://developers.zalo.me/docs/api/official-account-api-230 ·
[6] ZNS API — https://developers.zalo.me/docs/zalo-notification-service/bat-dau/gioi-thieu-zalo-notification-service-api ·
[7] Điều khoản Zalo — https://zalo.vn/dieukhoan/ , https://vnexpress.net/vi-sao-zalo-bat-ngo-cap-nhat-dieu-khoan-su-dung-4999181.html ·
[8] TikTok Direct Post — https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post ·
[9] TikTok ToS — https://www.tiktok.com/legal/page/row/terms-of-service/en , https://instantdm.com/blog/is-tiktok-automation-allowed ·
[10] X API pricing (bên thứ ba) — https://postproxy.dev/blog/x-api-pricing-2026/ , https://www.outstand.so/blog/x-api-pricing ·
[11] X Terms — https://x.com/en/tos ·
[12] LinkedIn Community Management — https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview ·
[13] LinkedIn User Agreement 8.2 / Prohibited software — https://www.linkedin.com/help/linkedin/answer/a1341387 ,
https://contentin.io/blog/linkedin-mcp-terms-of-service/
