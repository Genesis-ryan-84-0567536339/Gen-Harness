# Bàn giao Gen-Harness — hiện trạng + việc dở (cập nhật 16/10/2026, bản v0.1.59)

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

## Hiện trạng (v0.1.60)

Bản mới nhất **v0.1.60** (16/10/2026, `VERSION` = v0.1.60): **Mặt tiền Owner v2** — 5 trụ cột Tình báo, Thông tin, Quan hệ, Phân tích, Việc có số thật + **Thiết lập một màn 3 bước** ([v0.1.60.md](../releases/v0.1.60.md)); đang chờ PR vào main + cổng phát hành.
Trước đó **v0.1.59** (16/10/2026, bản vá): sửa quét QR WhatsApp (mã vẽ lớn, xử lý `companion_reg_refresh`, thử lại có giãn cách, Baileys ghim 7.0.0-rc14); thẻ "Hôm nay của Sếp" đọc lại ngay ([v0.1.59.md](../releases/v0.1.59.md)); đã vào main. Chưa kiểm với máy chủ WhatsApp thật (Nợ #35).
Trước đó **v0.1.58** (11/10/2026, bản vá nóng): Antigravity CLI đòi mức suy nghĩ — Kiểm tra thử lại với mức, tự lưu model, Gen tự lành, bảng gán nói lý do thật ([v0.1.58.md](../releases/v0.1.58.md)).
Trước đó **v0.1.57** (10/10/2026): **khoá nạp dữ liệu mẫu** (cờ + DB chưa có dữ liệu thật), **Owner tự đặt Tên Kho** (Nợ #30), **CI `api` chạy hai lượt pytest song song**, bộ kiểm chống lộ chỉ giữ quy tắc chung (mẫu riêng ở secret `GH_PERSONAL_PATTERNS`), bản công khai đã gọt danh tính riêng ([v0.1.57.md](../releases/v0.1.57.md)); đã vào main.
Trước đó **v0.1.56** (10/10/2026): **không lộ thông tin riêng của Sếp cho Owner khác** — bỏ địa chỉ Gen-hub khỏi mã giao đi, tên Kho chung "Kho dữ liệu", CI chống lộ ([v0.1.56.md](../releases/v0.1.56.md)).
Trước đó **v0.1.55** (10/10/2026): **Gọn cho Sếp** — Mặt tiền Owner, hồ sơ model tiêu chuẩn + Về mặc định, thiết lập gọn, chọn model trong chat, Jev lọc trước ([v0.1.55.md](../releases/v0.1.55.md)).
Trước đó **v0.1.54**: **Gen hướng dẫn** — Gen chủ động nhắc việc Sếp cần làm, giới thiệu tính năng, bài học mỗi ngày ([v0.1.54.md](../releases/v0.1.54.md), thiết kế [gen-coach.md](../design/gen-coach.md)).
v0.1.54 chứa toàn bộ **v0.1.53** ("tự cập nhật đêm tự lành + trung thực": một bản cài đứng ở v0.1.44 từ 03/10 đến 09/10 vì lịch đêm bị tắt mà không ai biết, [v0.1.53.md](../releases/v0.1.53.md)),
v0.1.52 (gỡ digest cũ bằng `rmi -f`, [v0.1.52.md](../releases/v0.1.52.md)), v0.1.51 và v0.1.50.
Đang chạy, theo nhóm:

- **Cài đặt & vận hành (genh)**: cài một lệnh; `genh update` an toàn (tải trước, sao lưu, migrate, tự quay về bản cũ khi lỗi, khoá `genh.lock`, báo "bị dừng giữa chừng");
  lịch đêm ~03:00 **tự lành** (bật lại khi mất/tắt/không chạy, trừ khi Sếp đã chủ động tắt), **người gác nút Cập nhật ngay tự chữa** (v0.1.54: `.path` failed vì hết hạn mức inotify ⇒ reset-failed + restart, vẫn lỗi ⇒ timer dự phòng quét mỗi phút), `genh auto-update status` nói thật, chọn bản cao nhất đã đủ 24 giờ; `genh export/import`, `genh offsite` (bản sao tuần ra USB/NAS), `genh remote` (Tailscale/Cloudflare/LAN/local),
  trực canh 12 phút → Telegram, gói chẩn đoán. Cổng mặc định chỉ nghe 127.0.0.1 (máy cũ giữ 0.0.0.0 + một chuông nhắc).
- **Phát hành & CI**: xem "Quy trình phát hành" dưới; ảnh ghim digest, `uv.lock --frozen`, action ghim SHA, quét bảo mật dạng báo cáo, `check_*` trong `.github/scripts`.
- **Console**: 11 dịch vụ compose (`proxy web migrate api worker bridge browser browser-redis browser-egress db redis`); menu 6 mục + Nâng cao; trình thiết lập; Hướng dẫn thiết lập;
  **Mặt tiền Owner** `/owner/*` (v0.1.60: 5 trụ cột Tình báo/Thông tin/Quan hệ/Phân tích/Việc + Cài đặt 4 khối; Owner mở `/` vào đây; Console ở Cài đặt › Cài đặt nâng cao); thiết lập một màn `/setup` (Tài khoản → Nguồn AI → Xong, mọi "Chọn model" về `/setup?buoc=nguon-ai`); Việc Sếp cần làm (10 dòng, 1 bắt buộc = nguồn AI, kết quả ở `ops.boss_checks`); chuông + dải "Cần Sếp xử lý"; Trợ giúp (gói chẩn đoán, cập nhật, **Lộ trình học cùng Gen**); phiên 7 ngày trượt, tối đa 30 ngày; PIN ở đường hạ rào.
- **Gen (chỉ Owner)**: khung chat nhớ hội thoại; Bản tin 07:30/17:30; dẫn đường trên UI; **8 loại đề xuất** có Xác nhận (draft_message, reminder, assign, social_reply, social_dm,
  **memory_note, kho_create, kho_update**); **Gen nhớ** (30 ghi chú, Cài đặt › Bộ não AI); đọc Kho + lịch/mail/việc/Drive qua Gen-hub (đã che) và Tài liệu/Deal/Vụ việc nội bộ;
  **ghi Kho** (Phiên, Việc) chỉ qua đề xuất + mã PIN + permit; mỗi bản mới Gen đề xuất một Phiên (F-87);
  **Gen hướng dẫn** (v0.1.54): thẻ Hôm nay của Sếp (≤ 3 việc cần làm ngay, mẹo, bài k/19), chấm đỏ, chuông `gen.coach` ≤ 1/ngày, dòng Bản tin x/N, tool `coach.status` — không gọi model, chỉ Owner, khuyên không ép.
- **Model AI**: **hồ sơ tiêu chuẩn theo vai** (v0.1.55: không cần gán model; dòng gán của Owner thắng; Về mặc định), chọn Nhanh/Kỹ hơn trong khung chat; ModelRouter (khoá API Gemini/OpenRouter/OpenAI-compat), agy (chỉ cho Gen của Sếp), Claude Code CLI (Owner tự quyết rủi ro, QD-12); model và mức suy nghĩ tách riêng;
  việc nền mặc định chỉ khoá API; chi phí ₫/ngày + trần; Jev tuỳ chọn: lọc trước tin trùng/rác (che dữ liệu bắt buộc, v0.1.55; QD-10 bỏ Jules).
- **Kênh**: Zalo/WhatsApp qua bridge (QR; WhatsApp v0.1.59: mã vẽ lớn, Baileys ghim 7.0.0-rc14, thử lại có giãn cách); Telegram một chiều tới Sếp; Facebook cá nhân đọc + Trả lời bình luận/Nhắn tin có Xác nhận + PIN + ảnh chụp (đăng bài = lát 2).
- **Dữ liệu & bảo mật**: Postgres 16 (pgvector, pg_partman), RLS chỉ là phòng thủ phụ (mỗi bản cài 1 tổ chức), hạn lưu thật, bí mật mã hoá phong bì, DNS ghim cho MCP/Gen-hub, ngắt mạch Gen-hub 60 giây.

## v0.1.60 — Mặt tiền Owner v2 + Thiết lập một màn (5 gói G1–G5, nhánh `claude/v0159`)

- **Vì sao**: Boss 11/10 — Mặt tiền v0.1.55 mới là danh sách link, Sếp chưa thấy trong 3 giây việc phải quyết, tin khẩn, khách cần chăm; Phân tích khoá "sắp có"; thiết lập nhiều bước, "Chọn model" dẫn mỗi nơi một kiểu.
- **Thay đổi**: G1 API chỉ đọc chỉ Owner `GET /owner/brief|feed|feed/{id}/context|insights|proposals`, `relations?list=care`, `today.nav` + hook + DraftDecide/ProposalDecide + mock (không migration); G2 token sáng/tối + 8 thành phần kit + khung 5 trụ cột, Hỏi Gen ngăn kéo, lính gác thiết kế;
  G3 Tình báo, Việc, Phân tích; G4 Thông tin, Quan hệ; G5 `/setup` một màn 3 bước, đích "Chọn model" duy nhất `/setup?buoc=nguon-ai`, Cài đặt 4 khối. Đóng Nợ #28.
- **Kiểm tra**: bộ đủ như CI chạy một lần ở bước tích hợp — số liệu ở mục "Kiểm" của [v0.1.60.md](../releases/v0.1.60.md); ảnh 6 màn × 390/1440 × sáng/tối + 5 ảnh trạng thái ngày đầu (`owner-shots-v0159`).
- **Boss cần làm**: không cần làm gì (xem "Boss phải làm — v0.1.60" dưới).

## v0.1.59 — Bản vá: sửa quét QR WhatsApp (chưa kiểm với máy chủ thật), thẻ Hôm nay của Sếp đọc lại ngay (nhánh `claude/hotfix-v0159`)

- **Vì sao**: Owner báo (v0.1.58) "WhatsApp quét QR chưa được" ở màn Kết nối, Zalo không lỗi. Mã WhatsApp dày vẽ 88px nên điện thoại không đọc; bridge chưa xử lý `companion_reg_refresh`; socket lỗi trước khi ra mã mở lại vô hạn (1755 socket / 40 giây); thẻ Hôm nay đọc cache 60 giây.
- **Thay đổi**: web `ChannelCard` (WhatsApp luôn vẽ lớn, lỗi tiếng Việt + Chi tiết kỹ thuật); bridge `whatsapp.js` (refresh luôn đổi khoá ADV và dựng lại đúng mã đang hiện, ảnh L/640px, thử lại 2s·4s·8s, `sw.js` cho phiên bản WA Web với user-agent tự nhận, ghim Baileys 7.0.0-rc14); `gen/coach/cache.py` làm mới thẻ sau mọi thao tác đổi nguồn/khoá/model/gán model (bộ đếm phiên bản chống ghi đè bản cũ); Kiểm tra CLI xanh của Owner ghi `agy_call`/`claude_call` và `ai_source` (chỉ khi nguồn bật). Không migration.
- **Chưa làm**: mở Antigravity CLI cho mọi agent (Nợ #33, Owner chọn "mở thẳng" 16/10); tách agy ra container riêng (Nợ #34); kiểm WhatsApp với máy chủ thật (Nợ #35, máy kiểm thử bị chặn mạng).
- **Boss cần làm**: xem "Boss phải làm — v0.1.59" dưới. Chi tiết: [v0.1.59.md](../releases/v0.1.59.md).

## v0.1.56 — Không lộ thông tin riêng của Sếp cho Owner khác (3 gói A/B/C, nhánh `claude/v0156`)

- **Vì sao**: repo công khai + mọi Owner nhận cùng bản; Boss dặn không gợi ý cổng nối Gen-hub và rà thông tin riêng (Zalo, dữ liệu demo). Không có khoá/token/Zalo thật bị lộ; lộ thật là địa chỉ Gen-hub (6 chỗ) và tên riêng của Kho (~30 file, cả ghi chú máy chủ lưu DB).
- **Thay đổi**: A `KHO_LABEL` ("Kho dữ liệu") + `ENDPOINT_INVALID_MSG` dạng `https://<máy-chủ>/mcp` + migration `0035` (đổi ghi chú máy chủ Gen-hub cũ) + `seed_demo.py` tên hư cấu; B ô nhập `https://<địa-chỉ-gen-hub-của-bạn>/mcp`, mock/test `example.test`; C `check_no_personal_info.py` (bước CI ở job `web`) + tài liệu chung.
- **Chưa làm / để Boss quyết**: ghi chú vận hành riêng còn công khai (Nợ #31) — đã xong ở v0.1.57 (repo giữ công khai, ghi chú riêng dời sang Brain); ô Tên Kho (Nợ #30) — xong ở v0.1.57; tên khách trong `seed-data.json`/mock web (còn chờ Boss). Git history giữ địa chỉ cũ — không viết lại. Chi tiết: [v0.1.56.md](../releases/v0.1.56.md).

## v0.1.55 — Gọn cho Sếp (5 gói song song G1–G5, QD-14)

- **Vì sao**: Boss 10/10 "làm luôn, gọn, ít bản" — Console nhiều màn quản trị, thiết lập hỏi nhiều, phải tự gán model, 6 dòng bắt buộc dù chưa cần, thẻ Cập nhật không nói vì sao không có nút.
- **Thay đổi**: G1 hồ sơ model theo vai + `/defaults` (Về mặc định từng mục / tất cả có PIN; migration `0034` `agent.bindings.effort`; khoá lõi mới `core.briefing`); G2 thiết lập ≤ 4 lần nhập, bước 4 không ghi `agent.bindings`, Việc Sếp cần làm dòng 0 "nguồn AI" là bắt buộc duy nhất, `request_block_reason` ở thẻ Cập nhật;
  G3 `model_choice` ở `POST /gen/turns` + ModelPicker, câu ngoài phạm vi trả câu mẫu không gọi model (J3); G4 lọc trước J2 (`prefilter.py`), Jev che dữ liệu bắt buộc, `/jev/enable|benchmark|value-summary`, `/refinery/triage/skipped`; G5 Mặt tiền `/owner/*` + `GET /owner/today|relations|tasks` (chỉ đọc, chỉ Owner).
  Tích hợp: gắn 3 router, `api.defaults`/`api.owner`, mock nối đủ, mục tiêu Gen `boss_checks.row.ai` + `system.brain.jev.enable`, E2E cài thật thêm bước "không gán model nào, Gen vẫn trả lời bằng hồ sơ tiêu chuẩn".
- **Kiểm tra**: bộ đủ như CI chạy một lần ở bước tích hợp (`claude/v0155`): ruff/mypy, pytest superuser + `gh_app`, vitest, build, Playwright mock đủ suite (gồm `owner.spec`, layout-guard 5 màn `/owner/*`), browser, `go test`, unittest `.github/scripts` — số liệu ở báo cáo tích hợp.
- **Boss cần làm**: xem "Boss phải làm — v0.1.55" dưới (không bắt buộc; Jev tuỳ chọn). Chi tiết: [v0.1.55.md](../releases/v0.1.55.md).

## v0.1.54 — Gen hướng dẫn

- **Vì sao**: việc vận hành chỉ Sếp làm được (9 dòng Việc Sếp cần làm, sao lưu, token Gen-hub, nháp…) và tính năng Sếp chưa biết thì nằm im tới khi thành sự cố; Gen chỉ trả lời khi được hỏi. Nay Gen nhắc nhẹ mỗi ngày, có đường lùi ở mọi nút (QD-12).
- **Thay đổi**: migration `0033` (`agent.gen_coach_prefs`, `agent.gen_coach_items`); gói `gh/gen/coach/` (signals, lessons, engine, store, routes, cron) + `content/lessons.json` (10 bài N01–N10) và `tips.json` (6 mẹo); API `/gen/coach/{today,items,prefs,curriculum}` (chỉ Owner);
  job `gen_coach` 09:05/11:05/14:05; thẻ Hôm nay của Sếp, Lộ trình học cùng Gen (19 bài = 10 + 9 từ Hướng dẫn thiết lập), Cài đặt › Bộ não AI › Gen hướng dẫn; 16 mục tiêu Gen mới; thẻ "Việc thiết lập tiếp" đổi "Ẩn" thành "Để sau 7 ngày" (lưu ở máy chủ).
- **Kiểm tra** (gói nội dung, cây gộp tạm): pytest `test_coach_content_v0154` 27 xanh; cùng `test_gen_coach_v0154` + `test_worker_schedule_v0136` = 176 xanh. Bộ đủ (pytest, vitest, Playwright mock) chạy khi tích hợp `claude/v0154` — kết quả ở báo cáo tích hợp.
- **Người gác yêu cầu tự chữa** (cùng bản, bài học từ một bản cài thật: `gen-harness-update-request.path` failed "Result: resources" vì hết hạn mức inotify 128): `genh auto-update enable|status` và lần cài/cập nhật chữa (chỉ `SubState=waiting` mới là khoẻ; `handle-requests` KHÔNG chữa — trong service `.path` "running" giả); còn lỗi ⇒ `gen-harness-update-request.timer` dự phòng + `watcher` trong `run/nightly-status.json` + dòng "Người gác cập nhật" ở thẻ Sức khoẻ; E2E thật có ca inotify (xem [v0.1.54.md](../releases/v0.1.54.md)).
- **Boss cần làm**: xem "Boss phải làm — v0.1.54" dưới (không bắt buộc, ~3 phút). Chi tiết: [v0.1.54.md](../releases/v0.1.54.md).

## Quy trình phát hành & cổng

1. Nhánh làm việc → PR vào `main`; CI xanh thì tự merge squash (Boss đã cho phép), sau đó **nối lịch sử main vào nhánh bằng merge** (không reset/force-push).
2. Tăng `VERSION` ⇒ `release.yml`: CI chạy trước → Release dạng **bản thử** (prerelease) → `e2e-install` + mọi ô `e2e-upgrade` + `e2e-rollback` + `e2e-nightly-real` (v0.1.53) xanh → **promote** thành bản chính thức (latest);
   lịch đêm đợi thêm 24 giờ. Chi tiết: `docs/handoff/05-installer.md` mục "Cổng phát hành".
3. Báo Boss "đã phát hành" chỉ sau khi **kiểm genh tải về** (checksum + `genh version` khớp tag) và `releases/latest` là đúng tag mới. Promote tay (`skip_e2e`) chỉ khi E2E lỗi ngoài mã.
4. Mỗi bản ghi: [CHANGELOG.md](../../CHANGELOG.md) (3–5 dòng) + `docs/releases/vX.Y.Z.md`; file này chỉ cập nhật hiện trạng + việc dở (≤ 200 dòng, có test).
5. Bật bảo vệ nhánh `main` + tag `v*` (cần quyền admin repo, ~2 phút): xem [v0.1.33.md](../releases/v0.1.33.md). Không thêm `paths-ignore: docs/**` cho `ci.yml`.

## Việc dở

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

- **Phát hành v0.1.60**: `claude/v0159` (5 gói đã tích hợp, đã chứa main v0.1.59) → PR vào main → CI xanh → merge squash → nối main vào nhánh bằng merge (không reset) → bản thử → E2E cài thật + nâng cấp → promote → kiểm genh tải về khớp tag → báo Boss.
- **Chưa làm (mang từ v0.1.58)**: bước rẻ ở `e2e-install` (`agy --help | grep -- --effort`, `missing_reason` trong container); ô chọn model vẫn ẩn khi Kiểm tra đỏ (`offeredGroups`). **Nợ #33** mở Antigravity CLI cho mọi agent (Owner chọn "mở thẳng" 16/10, đang chờ mở quyền thi công) · **Nợ #34** tách agy ra container riêng · **Nợ #35** kiểm WhatsApp QR với máy chủ thật.
- **Bản kế tiếp (đã hẹn)**: nhận kết quả "Thử 12 câu mẫu" của Jev từ Boss rồi quyết ngưỡng lọc trước; Boss dùng thử Mặt tiền v2 rồi góp ý; chuông Gen dẫn về Mặt tiền; xoá hội thoại Gen thì xoá luôn lựa chọn model đã nhớ (Nợ #29); dọn mã chết trình thiết lập cũ (Nợ #36).
- **H-b còn mở**: timer đêm mất lịch khi `daemon-reload`/`enable` chạy từ bên trong service đêm — không tái hiện được bằng mã lẫn `e2e-nightly-real` (systemd thật: sau lần chạy timer vẫn có lần kế tiếp); tự lành bao ca này. Máy thật còn tái diễn thì ghi vào v0.1.53.md.
- **PR Renovate** không tự merge nằm chờ tới khi Boss nhắn "xử lý PR phụ thuộc"; chưa có lịch tự động nào gọi Claude.
- **Selector ghi Facebook** mới kiểm trên trang mẫu — chờ nghiệm thu thật (dòng 8). Chuông phiên hết có thể hiện hai lần (`social.paused` + `social.session_expired`), gộp ở bản sau nếu phiền.
- **Giới hạn đã biết**: TOTP chưa làm; Redis lỗi ⇒ giới hạn đăng nhập tạm không áp; gói apt trong Dockerfile chưa ghim phiên bản; tag GHCR `:latest` cũ đứng yên (không dùng).
- **Mục Nợ đầy đủ** (bộ câu hỏi chuẩn so model, F-70, TOTP, Facebook đăng bài lát 2, cosign/minisign, PHIEN bù, trường Kho "Công cụ"/"Người làm", lời hẹn trượt F-91/F-92, Gen hướng dẫn: `release_todos`, danh mục tính năng, "Làm giúp" G8, bộ bài cho nhân viên, tắt chuông theo loại…; Nợ #33–#37: Antigravity CLI cho mọi agent, tách agy, WhatsApp QR thật, mã chết trình thiết lập cũ, bảng Quan hệ ở 1024px): [ROADMAP › Nợ](../ROADMAP.md).
