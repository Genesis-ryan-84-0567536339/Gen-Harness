# Bàn giao Gen-Harness — hiện trạng + việc dở (cập nhật 17/10/2026, bản v0.1.65 — gộp v0.1.63 + v0.1.64 + v0.1.65)

File này nay chỉ ghi **hiện trạng + việc dở** (tên cũ `HANDOFF-v0.1.1.md` giữ nguyên vì mã nguồn có chú thích trỏ tới).
Lịch sử từng bản nằm ở [CHANGELOG.md](../../CHANGELOG.md) (3–5 dòng/bản) và `docs/releases/vX.Y.Z.md` (chi tiết, chuyển nguyên từ HANDOFF cũ):
mục "Lỗi cần sửa", "Chia việc", "Kiểm tra tích hợp" của v0.1.1/v0.1.2 nay ở [v0.1.1.md](../releases/v0.1.1.md) và [v0.1.2.md](../releases/v0.1.2.md);
chú thích trong mã trỏ "HANDOFF mục vX.Y.Z" thì đọc tệp `docs/releases/vX.Y.Z.md` tương ứng.
Tiến độ, bản phản ứng (hotfix) và **mục Nợ**: [ROADMAP](../ROADMAP.md). Vận hành hằng ngày: [runbook](../runbook.md).
Ghi chú vận hành riêng của Sếp (máy, tài khoản, địa chỉ, việc riêng) nằm ở repo Brain › Project/gen-harness (riêng tư) — không ghi vào repo công khai này.

## Hợp đồng chung

Còn hiệu lực từ v0.1.1 (vai trò DB, volume, gói hồ sơ); chi tiết đầy đủ ở [v0.1.1.md](../releases/v0.1.1.md).

- **Vai trò DB**: `api`/`worker` kết nối bằng vai trò `gh_app` (không superuser, không BYPASSRLS) qua `GH_DATABASE_URL`, mật khẩu `GH_APP_DB_PASSWORD`.
  `GH_ADMIN_DATABASE_URL` → superuser `gh` (migrate, backup, bundle, bảo trì phân vùng); rỗng ⇒ dùng `GH_DATABASE_URL` (`Settings.admin_database_url`).
  Migration 0014 tạo/ALTER `gh_app` với mật khẩu lấy từ env lúc migrate. `migrate` là dịch vụ duy nhất chạy bằng superuser.
- **Tệp**: `GH_OBJECTS_DIR=/var/lib/gh/objects` (volume `gh_objects`, gắn vào api + worker; tài liệu + sao lưu). Không còn MinIO/S3.
- **Postgres tuning**: `GH_PG_SHARED_BUFFERS`, `GH_PG_EFFECTIVE_CACHE_SIZE`, `GH_PG_WORK_MEM`, `GH_PG_MAINTENANCE_WORK_MEM` (genh tính từ RAM, ghi overlay env).
- **Khoá**: `gh_master_key` (mã hoá bí mật ứng dụng), `gh_bridge_key`, `gh_browser_key` (genh sinh); `GH_BACKUP_KEY` riêng cho sao lưu (backup cũ vẫn đọc bằng khoá master).
  Khoá chỉ nằm trên máy này ⇒ phải có `genh export` hoặc `genh offsite` ra ổ khác (README › Dành cho Boss).
- **Gói hồ sơ `.ghbundle`**: Python tạo/đọc (`python -m gh.bundle export|import`), Go chỉ chuyển bytes; mật khẩu qua `GH_BUNDLE_PASSWORD` (≥ 12 ký tự);
  mã thoát `0` ok · `2` sai mật khẩu/gói hỏng · `3` không tương thích · `1` lỗi khác; mã hoá lại mọi bí mật bằng khoá master máy đích.

## Hiện trạng (v0.1.65)

Bản mới nhất **v0.1.65** (17/10/2026, `VERSION` = v0.1.65) là **bản gộp ba bản lớn** theo quyết định Sếp 17/10 (một lần `genh update`; không có bản v0.1.63/v0.1.64 riêng): **v0.1.63** hộp riêng Antigravity `agy-box` + proxy lối ra `agy-egress` (container không khoá master/DB/Redis/volume; mỗi vai một chỗ chạy agy; "nguồn AI dùng được" một hàm `providers.readiness`; cổng phát hành `check_agy_box_isolation.py` + `e2e_agy_box.sh`; [v0.1.63.md](../releases/v0.1.63.md)) · **v0.1.64** Telegram 2 chiều (ghép mã 6 số, lệnh chỉ đọc/đề xuất, không nhận mã PIN) + sàng lọc ghi loại người, Sếp tự đánh dấu nhân viên (migration 0037; [v0.1.64.md](../releases/v0.1.64.md)) · **v0.1.65** chế độ nghe & danh bạ (nhóm mới mặc định Lắng nghe im lặng, không bao giờ trả lời kể cả khi tag; thu thành viên mọi nhóm; tin 1-1 lưu im lặng; THAY ĐỔI QUYỀN: tin 1-1 chỉ Owner/người phụ trách, gán BOT người = Owner + PIN, che JID; migration 0038; [v0.1.65.md](../releases/v0.1.65.md)). Head migration = 0038. Chưa push — chờ mốc.
Trước đó **v0.1.62** (17/10/2026): đợt A phần 2, Antigravity phân lớp, kênh bền, sức khoẻ ([v0.1.62.md](../releases/v0.1.62.md)); không migration.
Trước đó **v0.1.61** (16/10/2026, đã vào main): đợt A phần 1 — mã PIN cho người được giao quyền, bảng quyền/tên vai trò (migration 0036), nháp & gửi tin trung thực, gộp người đủ bảng, lưới `check_terms.py` + route-crawl ([v0.1.61.md](../releases/v0.1.61.md)).
Các bản cũ (v0.1.50 – v0.1.60: Gen nhớ + ghi Kho, tự cập nhật đêm tự lành, Gen hướng dẫn, Mặt tiền Owner v2, thiết lập một màn, sửa QR WhatsApp, khoá thông tin riêng…) xem [CHANGELOG.md](../../CHANGELOG.md) và `docs/releases/`.
Đang chạy, theo nhóm:

- **Cài đặt & vận hành (genh)**: cài một lệnh; `genh update` an toàn (tải trước, sao lưu, migrate, tự quay về bản cũ khi lỗi, khoá `genh.lock`, báo "bị dừng giữa chừng");
  lịch đêm ~03:00 **tự lành** (bật lại khi mất/tắt/không chạy, trừ khi Sếp đã chủ động tắt), **người gác nút Cập nhật ngay tự chữa** (v0.1.54: `.path` failed vì hết hạn mức inotify ⇒ reset-failed + restart, vẫn lỗi ⇒ timer dự phòng quét mỗi phút), `genh auto-update status` nói thật, chọn bản cao nhất đã đủ 24 giờ; `genh export/import`, `genh offsite` (bản sao tuần ra USB/NAS), `genh remote` (Tailscale/Cloudflare/LAN/local),
  trực canh 12 phút → Telegram, gói chẩn đoán. Cổng mặc định chỉ nghe 127.0.0.1 (máy cũ giữ 0.0.0.0 + một chuông nhắc).
- **Phát hành & CI**: xem "Quy trình phát hành" dưới; ảnh ghim digest, `uv.lock --frozen`, action ghim SHA, quét bảo mật dạng báo cáo, `check_*` trong `.github/scripts`. Môi trường dev riêng `genh-dev` (cổng 184xx, `make dev-up`; [dev-local.md](../dev-local.md)) — không đụng bản cài thật.
- **Console**: 13 dịch vụ compose (`proxy web migrate api worker agy-box agy-egress bridge browser browser-redis browser-egress db redis`); menu 6 mục + Nâng cao; trình thiết lập; Hướng dẫn thiết lập;
  **Mặt tiền Owner** `/owner/*` (v0.1.60: 5 trụ cột Tình báo/Thông tin/Quan hệ/Phân tích/Việc + Cài đặt 4 khối; Owner mở `/` vào đây; Console ở Cài đặt › Cài đặt nâng cao); thiết lập một màn `/setup` (Tài khoản → Nguồn AI → Xong, mọi "Chọn model" về `/setup?buoc=nguon-ai`); Việc Sếp cần làm (10 dòng, 1 bắt buộc = nguồn AI, kết quả ở `ops.boss_checks`); chuông + dải "Cần Sếp xử lý"; Trợ giúp (gói chẩn đoán, cập nhật, **Lộ trình học cùng Gen**); phiên 7 ngày trượt, tối đa 30 ngày; PIN ở đường hạ rào.
- **Gen (chỉ Owner)**: khung chat nhớ hội thoại; Bản tin 07:30/17:30; dẫn đường trên UI; **8 loại đề xuất** có Xác nhận (draft_message, reminder, assign, social_reply, social_dm,
  **memory_note, kho_create, kho_update**); **Gen nhớ** (30 ghi chú, Cài đặt › Bộ não AI); đọc Kho + lịch/mail/việc/Drive qua Gen-hub (đã che) và Tài liệu/Deal/Vụ việc nội bộ;
  **ghi Kho** (Phiên, Việc) chỉ qua đề xuất + mã PIN + permit; mỗi bản mới Gen đề xuất một Phiên (F-87);
  **Gen hướng dẫn** (v0.1.54): thẻ Hôm nay của Sếp (≤ 3 việc cần làm ngay, mẹo, bài k/19), chấm đỏ, chuông `gen.coach` ≤ 1/ngày, dòng Bản tin x/N, tool `coach.status` — không gọi model, chỉ Owner, khuyên không ép.
- **Model AI**: **hồ sơ tiêu chuẩn theo vai** (v0.1.55: không cần gán model; dòng gán của Owner thắng; Về mặc định), chọn Nhanh/Kỹ hơn trong khung chat; ModelRouter (khoá API Gemini/OpenRouter/OpenAI-compat), agy mỗi vai một chỗ chạy (v0.1.63: Gen của Sếp, Bản tin, agent không gắn kênh chạy trong tiến trình; `core.reply`, sàng lọc, agent ngoại giao, Gen của nhân viên, thử agent, Soạn lại / Dịch nháp chạy qua `agy-box`, hộp tắt ⇒ nguồn kế; Thử quy tắc không dùng agy; một hàm quyết định `agy_policy.decide`, luật ở `providers.placement`), Claude Code CLI (Owner tự quyết rủi ro, QD-12); model và mức suy nghĩ tách riêng;
  việc nền mặc định chỉ khoá API; chi phí ₫/ngày + trần; Jev tuỳ chọn: lọc trước tin trùng/rác (che dữ liệu bắt buộc, v0.1.55; QD-10 bỏ Jules).
- **Kênh**: Zalo/WhatsApp qua bridge (v0.1.62 bền: mất mạng không xoá phiên, nút Nối lại bằng phiên đã lưu, Đăng xuất khi phiên lỗi; QR; WhatsApp v0.1.59: mã vẽ lớn, Baileys ghim 7.0.0-rc14, thử lại có giãn cách); Telegram hai chiều với Sếp (v0.1.64: ghép mã 6 số, lệnh chỉ đọc/đề xuất); Facebook cá nhân đọc + Trả lời bình luận/Nhắn tin có Xác nhận + PIN + ảnh chụp (đăng bài = lát 2).
- **Dữ liệu & bảo mật**: Postgres 16 (pgvector, pg_partman), RLS chỉ là phòng thủ phụ (mỗi bản cài 1 tổ chức), hạn lưu thật, bí mật mã hoá phong bì, DNS ghim cho MCP/Gen-hub, ngắt mạch Gen-hub 60 giây.

## v0.1.65 — bản gộp (nhánh `rel/v0165`, xếp trên `local/v0163-int` + gói sửa review P1/P2/P3)

- **Vì sao**: Sếp gộp ba bản lớn thành một lần phát hành; v0.1.63 cho việc có người ngoài chạy Antigravity trong container riêng, v0.1.64 cho Sếp nhắn Gen qua Telegram, v0.1.65 cho thu hết tình báo (mọi nhóm, thành viên, tin 1-1) mà không trả lời nhầm.
- **Thay đổi**: hộp `agy-box` (`gh/agybox`, `placement.py`, `agy_policy.decide`, router), proxy `agy-egress`, HOME tạm mỗi lượt agy, `readiness.py`; `gh/telegram/*` (ghép, `inbound`, `poller`, `commands`), B6 loại người; `settings.new_group_mode` / `direct_mode`, `core.groups.left_at`, `direct_visible_sql` (tin 1-1), gán BOT người.
- **Chưa làm**: Nợ #43 (nút Chạy lại tin lỗi); #44–#46 (allowlist egress mặc định, core vào hộp, định dạng/xoay vòng token agy); #47–#49 (quét danh bạ theo phần thay đổi, `view_scope`, tin 1-1 còn hở); đệm ở bridge cho loạt tin dồn < 1 giây trước khi tập nghe đồng bộ; chưa kiểm dịch vụ thật (WhatsApp QR #35, bot Telegram thật, bridge nhận nhóm lạ).
- **Boss cần làm**: xem "Boss phải làm — v0.1.65" dưới. Chi tiết: [v0.1.65.md](../releases/v0.1.65.md).

## Người lái và kế hoạch v0.1.65 – v0.1.70

Claude Code chạy trên máy cục bộ là người lái DUY NHẤT (từ 16/10/2026; phiên đám mây đã dừng). Mỗi bản ≤ 4 gói không chồng tệp (QD-14), tối đa 1 migration/bản; Sếp đã gộp v0.1.63–65 thành MỘT lần phát hành mang số v0.1.65; các bản sau: v0.1.66–67 và v0.1.68, v0.1.70 phát hành riêng (mỗi bản kiểm đầy đủ + review + push + PR).

- **v0.1.65** (xong, chờ push) bản gộp: hộp riêng Antigravity (v0.1.63) + Telegram 2 chiều và sàng lọc ghi loại người (v0.1.64) + chế độ nghe & danh bạ (v0.1.65, migration 0038).
- **v0.1.66** model hiển thị = model chạy (một bộ chọn model + bảng tầng) · **v0.1.67** agent làm và nói thật (tạo/sửa/bật tắt/nhân bản).
- **v0.1.68** một danh sách việc, thiết lập nói thật · **v0.1.69** chuông có vòng đời + mặc định đúng QD · **v0.1.70** câu chữ sạch, hạ baseline Nợ #39/#40.

Nhánh local (CHƯA push): **`rel/v0165`** = bản gộp trên; **`rel/v0166` … `rel/v0170`** xếp chồng tiếp (v0.1.66 model hiển thị = model chạy, v0.1.67 agent làm và nói thật, v0.1.68 một danh sách việc, v0.1.69 chuông có vòng đời, v0.1.70 câu chữ sạch). Mỗi bản: gộp gói → bộ kiểm đầy đủ MỘT lần → `/code-review` (+ `/security-review` khi chạm khoá, PIN, quyền, container) → thử trên dev → ảnh 390/1440.

## Quy trình phát hành & cổng

1. Nhánh làm việc → PR vào `main`; CI xanh thì tự merge squash (Boss đã cho phép), sau đó **nối lịch sử main vào nhánh bằng merge** (không reset/force-push).
2. Tăng `VERSION` ⇒ `release.yml`: CI chạy trước → Release dạng **bản thử** (prerelease) → `e2e-install` + mọi ô `e2e-upgrade` + `e2e-rollback` + `e2e-nightly-real` (v0.1.53) xanh → **promote** thành bản chính thức (latest);
   lịch đêm đợi thêm 24 giờ. Chi tiết: `docs/handoff/05-installer.md` mục "Cổng phát hành".
3. Báo Boss "đã phát hành" chỉ sau khi **kiểm genh tải về** (checksum + `genh version` khớp tag) và `releases/latest` là đúng tag mới. Promote tay (`skip_e2e`) chỉ khi E2E lỗi ngoài mã.
4. Mỗi bản ghi: [CHANGELOG.md](../../CHANGELOG.md) (3–5 dòng) + `docs/releases/vX.Y.Z.md`; file này chỉ cập nhật hiện trạng + việc dở (≤ 200 dòng, có test).
5. Bật bảo vệ nhánh `main` + tag `v*` (cần quyền admin repo, ~2 phút): xem [v0.1.33.md](../releases/v0.1.33.md). Không thêm `paths-ignore: docs/**` cho `ci.yml`.

## Việc dở

### Boss phải làm — v0.1.65 (gộp v0.1.63–65; không bắt buộc; chi tiết ở [v0.1.65.md](../releases/v0.1.65.md#việc-boss-phải-làm))

1. Sau khi bản chính thức ra: `genh update` (hoặc đợi lịch đêm) — migration 0037/0038 tự chạy; hộp `agy-box` + proxy `agy-egress` và khoá `gh_agy_key` tự lên (Sức khoẻ: "Hộp riêng Antigravity: Đang chạy"); bridge khởi động lại.
2. Antigravity: đăng nhập ở **Kết nối › Bộ não AI** bằng **một tài khoản Google riêng** (token đi vào hộp mỗi lượt có người ngoài). Máy chưa có khoá API nay cũng trả lời khách được bằng Antigravity qua hộp.
3. Telegram (tuỳ chọn): thẻ Telegram › **Nhận tin từ Sếp** › Ghép Telegram (PIN) → gửi `/start <mã 6 số>` cho bot → bật công tắc. Mã PIN chỉ gõ ở Console.
4. Biết trước: **nhóm mới tự vào Lắng nghe im lặng** (không trả lời kể cả khi tag; đổi ở thẻ kênh, PIN); tin 1-1 cài cũ đang tắt nay **lưu im lặng**; **THAY ĐỔI QUYỀN**: tin 1-1 chỉ Owner/người phụ trách, gán/bỏ BOT cho người = Owner + PIN, JID che với vai dưới Owner.
5. Thẻ Zalo/WhatsApp "Mất liên lạc" ⇒ **Nối lại bằng phiên đã lưu**. Tuỳ chọn: "Câu hỏi mở — mặc định đã chọn" ở [ROADMAP](../ROADMAP.md).

### Boss phải làm — v0.1.61 (đã qua; `genh update` + người được giao quyền tự đặt mã PIN ở Tài khoản của tôi; [v0.1.61.md](../releases/v0.1.61.md))

### Boss phải làm — v0.1.60 (không cần làm gì; chi tiết ở [v0.1.60.md](../releases/v0.1.60.md))

1. Không cần làm gì. Bản cài đang chạy đã thiết lập xong nên không phải làm lại; muốn đổi nguồn AI thì vào **Cài đặt › Nguồn AI › Đổi nguồn AI**.
2. Sau khi phát hành: mở `/owner` xem trang **Tình báo**; mở **Thông tin** và **Quan hệ** ở thanh trái (điện thoại: thanh dưới) để dùng.

### Boss phải làm — v0.1.59 (khoảng 5 phút; chi tiết ở [v0.1.59.md](../releases/v0.1.59.md))

1. Trên máy chủ chạy `genh update` (hoặc chờ lịch đêm), rồi tải lại trang (F5). Gồm cả bản v0.1.58; Gen tự chọn lại model, không thao tác tay.
2. WhatsApp: Kết nối › WhatsApp › **Tạo mã QR** → tích "Tôi hiểu rủi ro…" → **Tôi hiểu, hiện mã QR** → trên điện thoại WhatsApp › Thiết bị đã liên kết › **Liên kết thiết bị** → quét mã trên màn hình (điện thoại cách màn hình 20–30 cm, giữ yên).
3. Vẫn lỗi ⇒ chụp thẻ WhatsApp (có dòng lý do lỗi, "Chi tiết kỹ thuật") gửi lại cho Claude.

### Boss phải làm — v0.1.57 (không gấp; chi tiết ở [v0.1.57.md](../releases/v0.1.57.md))

1. **Thêm secret `GH_PERSONAL_PATTERNS`**: GitHub › Settings › Secrets and variables › Actions › New repository secret, mỗi dòng một mẫu (tên miền / tên gọi / email riêng của Sếp, viết như biểu thức chính quy). Chưa thêm thì CI vẫn chạy quy tắc chung và chỉ cảnh báo "chưa cấu hình mẫu riêng".
2. **Duyệt PR #137 ở repo Brain** (ghi chú vận hành riêng của Sếp dời từ repo công khai sang Brain).
3. Tuỳ chọn: **đặt Tên Kho** ở Kết nối › Gen-hub › "Tên Kho (tuỳ chọn)" (≤ 40 ký tự, cần mã PIN); để trống là "Kho dữ liệu".

### Boss phải làm — v0.1.56 (không bắt buộc; chi tiết ở [v0.1.56.md](../releases/v0.1.56.md))

1. Không cần làm gì với máy đang chạy. Đã quyết (10/10): repo giữ công khai (Owner khác cần tải bản phát hành), ghi chú vận hành riêng dời sang repo Brain (riêng tư).
2. Xem tên mẫu khách trong `docs/design/seed-data.json` và mock web có phải khách thật không (`seed_demo.py` đã dùng tên hư cấu).

### Boss phải làm — v0.1.55 (không bắt buộc; chi tiết ở [v0.1.55.md](../releases/v0.1.55.md))

1. Không cần làm gì. Lần tới mở trang chủ (cả trên điện thoại) sẽ thấy **Mặt tiền**: Hôm nay, Việc, Quan hệ, Hỏi Gen; màn quản trị cũ ở **Thêm › Cài đặt nâng cao**.
2. Trang Hôm nay hiện thẻ **"Áp model chuẩn theo vai?"** ⇒ bấm **Mở** (ở Hôm nay), rồi **Áp model chuẩn theo vai** → **Xác nhận** (khoá API và nguồn AI giữ nguyên). Nút "Về mặc định tất cả" hỏi mã PIN.
3. Hỏi Gen: chọn **Nhanh** hoặc **Kỹ hơn** ngay dưới ô nhập; để **Tự động** là chuẩn.
4. Thẻ Cập nhật không có nút "Cập nhật ngay" ⇒ đọc dòng lý do trên thẻ và làm đúng việc ghi ở đó (vd `genh auto-update enable` trên máy chủ). Gen-hub, Facebook, Telegram, Truy cập từ xa giờ là tuỳ chọn.
5. **Muốn dùng Jev**: Cài đặt › Bộ não AI › thẻ Jev → **"Dùng khóa OpenRouter đang có"** (hoặc dán khoá OpenRouter) → mã PIN → **"Thử 12 câu mẫu"** → gửi kết quả cho Claude (để làm v0.1.57). Không bật thì vẫn lọc bằng quy tắc như cũ.

### Boss phải làm — v0.1.54 (không bắt buộc, ~3 phút, sau khi máy lên v0.1.54; chi tiết ở [v0.1.54.md](../releases/v0.1.54.md))

1. Mở app → bấm nút **Gen** (có chấm đỏ) → xem thẻ **Hôm nay của Sếp** → bấm **Chỉ cho em** ở việc đầu tiên và làm theo.
2. Việc nào Sếp không dùng (vd Facebook) thì bấm **Không dùng việc này** (đọc câu hậu quả, Xác nhận) để Gen thôi nhắc; bật lại ở Cài đặt › Bộ não AI › Gen hướng dẫn.
3. Không bắt buộc: Cài đặt › Bộ não AI › **Gen hướng dẫn** để chỉnh giờ yên lặng hoặc số bài mỗi ngày. Ngoài ra không cần làm gì, bài học tự đến.
4. **Chỉ khi** thẻ Sức khoẻ hiện "Người gác cập nhật — Đang chạy dự phòng (hết hạn mức inotify)": trên máy chủ chạy `sudo sysctl -w fs.inotify.max_user_instances=1024` rồi `genh auto-update enable`. Không thấy cảnh báo thì không cần làm gì.

### Boss phải làm — v0.1.53 (một lần, ~2 phút, sau khi máy lên v0.1.53; chi tiết ở [v0.1.53.md](../releases/v0.1.53.md))

1. Trên máy chủ chạy `genh auto-update status`: dòng đầu phải là **BẬT**, "Lịch đang chạy (active): có", có "Lần kế tiếp", "Linger: có". Có dòng **CẢNH BÁO** ⇒ chép đúng lệnh nó in ra và chạy. Thấy **BẬT NHƯNG KHÔNG CHẠY** hoặc **TẮT** mà Sếp không tắt ⇒ `genh auto-update enable` (Linger KHÔNG ⇒ chạy trước `sudo loginctl enable-linger $USER`).
   Trước đây Sếp cố ý tắt tự cập nhật đêm thì bản này tự bật lại **một lần** — muốn tắt hẳn chạy `genh auto-update disable`.
2. Sáng hôm sau, Console › Cài đặt › Sao lưu & cập nhật › thẻ **Sức khoẻ hệ thống** (`/system?tab=storage&focus=health`): dòng **Tự cập nhật đêm** ghi "Bình thường · chạy lần cuối …". Có chuông "Lịch tự cập nhật đêm chưa chạy N ngày" ⇒ bấm **Xem cách bật lại**.
3. Xem timer bằng tay: `systemctl --user list-timers --all | grep gen-harness` (không phải `grep genh`). Muốn tắt hẳn tự cập nhật: `genh auto-update disable` (genh nhớ là Sếp đã tắt, không tự bật lại).

### Boss phải làm — v0.1.50 (một lần, ~3 phút, sau khi máy tự cập nhật; chi tiết ở [v0.1.50.md](../releases/v0.1.50.md))

1. **Quyền ghi Kho (tuỳ chọn)**: Gen-hub › token của Gen-Harness › tick thêm `kho_create`, `kho_update` (không tick gì khác), rồi Gen-Harness › Kết nối › Gen-hub › **Kiểm tra** (mã PIN):
   khối "Quyền ghi Kho" hiện "Có". Chưa tick thì thẻ Ghi vào Kho dữ liệu bị khoá nút Xác nhận; phần còn lại vẫn chạy.
2. **Duyệt đề xuất Phiên đầu tiên**: sau bước 1 (Kiểm tra xanh với quyền ghi), trong ≤ 30 phút có chuông "Gen đề xuất ghi Kho · Phiên v0.1.50" → đọc bảng "Trường | Sẽ ghi" (thẻ sửa bản ghi có thêm cột "Hiện tại") → **Xác nhận** + mã PIN →
   mở Kho kiểm bản ghi. Việc Sếp cần làm › dòng 9 "Gen ghi Kho" tự chuyển Đạt.
3. **Thử Gen nhớ**: nói "nhớ giúp em: …" → thẻ Ghi nhớ → Xác nhận; xem/sửa/xoá ở Cài đặt › Bộ não AI › Gen nhớ.

### Boss còn treo từ bản trước (trạng thái thật: Hướng dẫn › Việc Sếp cần làm, dòng "Đạt" là xong)

- **v0.1.49 — Gen-hub quyền đọc** (~2 phút): tick quyền ĐỌC lịch, mail, việc (Google Tasks), tìm tệp Drive (không tick quyền gửi/ghi) → Kết nối › Gen-hub › Kiểm tra →
  sáng sau Bản tin 07:30 có 3 mục mới. Không bắt buộc.
- **v0.1.47 — Facebook trả lời** (dòng 8, không bắt buộc): thẻ "Gửi trả lời & tin nhắn" ở Tài khoản mạng xã hội — nếu ghi "Khoá" thì đọc cảnh báo và tự quyết "Tôi hiểu rủi ro và đồng ý";
  nghiệm thu thật một lần bằng bình luận trên bài của chính Sếp. Phiên Facebook hết hạn ⇒ chuông + Telegram ⇒ Đăng nhập lại.
- **v0.1.46 — Truy cập từ xa** (dòng 7, tuỳ chọn từ v0.1.55): chọn cách truy cập (khuyên Tailscale: `genh remote tailscale`), bấm "Kiểm tra NGAY TRÊN ĐIỆN THOẠI", mời thử một nhân viên.
  Chuông "Cổng đang mở cho cả mạng" chỉ tắt khi đã chọn cách truy cập.
- **v0.1.44 — Telegram** (dòng 6, tuỳ chọn từ v0.1.55): tạo bot qua @BotFather → Kết nối › Telegram: dán mã, **Tìm chat_id**, **Lưu** (PIN), **Gửi thử** (điện thoại nhận 2 tin).
  Linux: nếu Console nhắc, chạy một lần `sudo loginctl enable-linger $USER` để trực canh chạy cả khi không đăng nhập.
- **v0.1.39 — nghiệm thu kết nối thật** (dòng 1–4): Gen-hub, Facebook, Google/agy (đăng nhập + gọi thử), Claude Code CLI; canary `--live` của agy chỉ làm sau khi Boss đăng nhập agy.
- **Tuỳ chọn**: cài Renovate App (1 phút, [v0.1.48.md](../releases/v0.1.48.md)); Jev tuỳ chọn ("Bật Jev 1 chạm", xem [v0.1.55.md](../releases/v0.1.55.md)).
- **Chờ Boss cho phép** (một câu mỗi việc): "cho xoá nhánh" (F-70, ROADMAP › Nợ); dặn Gen đề xuất Phiên bù cho v0.1.28 → v0.1.49 nếu muốn.

### Claude / điều phối viên còn dở

- **Phát hành v0.1.65 (bản gộp)**: `rel/v0165` đã kiểm đầy đủ → Opus review phần gộp → push → PR → CI xanh → merge squash → bản thử → E2E → promote → kiểm genh tải về khớp tag → `genh update` → báo Boss. v0.1.62 (đã gộp vào chuỗi này) ở `local/v0162-rc`.
- **Chưa làm (mang từ v0.1.58)**: bước rẻ ở `e2e-install` (`agy --help | grep -- --effort`, `missing_reason` trong container); ô chọn model vẫn ẩn khi Kiểm tra đỏ (`offeredGroups`). **Nợ #44–#49** (allowlist egress hộp, core vào hộp, định dạng/xoay vòng token agy, quét danh bạ theo phần thay đổi, `view_scope`, tin 1-1 còn hở); đệm ở bridge cho loạt tin dồn < 1 giây trước khi tập nghe đồng bộ · **Nợ #35** kiểm WhatsApp QR với máy chủ thật.
- **Bản kế tiếp (đã hẹn)**: nhận kết quả "Thử 12 câu mẫu" của Jev từ Boss rồi quyết ngưỡng lọc trước; Boss dùng thử Mặt tiền v2 rồi góp ý; chuông Gen dẫn về Mặt tiền; xoá hội thoại Gen thì xoá luôn lựa chọn model đã nhớ (Nợ #29); dọn mã chết trình thiết lập cũ (Nợ #36).
- **H-b còn mở**: timer đêm mất lịch khi `daemon-reload`/`enable` chạy từ bên trong service đêm — không tái hiện được bằng mã lẫn `e2e-nightly-real` (systemd thật: sau lần chạy timer vẫn có lần kế tiếp); tự lành bao ca này. Máy thật còn tái diễn thì ghi vào v0.1.53.md.
- **PR Renovate** không tự merge nằm chờ tới khi Boss nhắn "xử lý PR phụ thuộc"; chưa có lịch tự động nào gọi Claude.
- **Selector ghi Facebook** mới kiểm trên trang mẫu — chờ nghiệm thu thật (dòng 8). Chuông phiên hết có thể hiện hai lần (`social.paused` + `social.session_expired`), gộp ở bản sau nếu phiền.
- **Giới hạn đã biết**: TOTP chưa làm; Redis lỗi ⇒ giới hạn đăng nhập tạm không áp; gói apt trong Dockerfile chưa ghim phiên bản; tag GHCR `:latest` cũ đứng yên (không dùng).
- **Mục Nợ đầy đủ** (bộ câu hỏi chuẩn so model, F-70, TOTP, Facebook đăng bài lát 2, cosign/minisign, PHIEN bù, trường Kho "Công cụ"/"Người làm", lời hẹn trượt F-91/F-92, Gen hướng dẫn: `release_todos`, danh mục tính năng, "Làm giúp" G8, bộ bài cho nhân viên, tắt chuông theo loại…; Nợ #35–#37 và #42–#49: WhatsApp QR thật, mã chết trình thiết lập cũ, bảng Quan hệ ở 1024px, `list_promises` con trỏ, Chạy lại tin lỗi, hộp agy (egress, core, token), danh bạ, `view_scope`, tin 1-1): [ROADMAP › Nợ](../ROADMAP.md).
