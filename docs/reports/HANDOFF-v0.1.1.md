# Bàn giao Gen-Harness — hiện trạng + việc dở (cập nhật 17/10/2026, bản v0.1.62)

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

## Hiện trạng (v0.1.62)

Bản mới nhất **v0.1.62** (17/10/2026, `VERSION` = v0.1.62): **đợt A phần 2** (Hộp thư/Việc/Nhật ký/Khách & Nhóm xem hết, tìm ở máy chủ, che OTP/mật khẩu, lỗi sao lưu nói tiếng người, tài liệu khớp mã), **Antigravity phân lớp** (core/nội bộ dùng agy; ngoại giao và Gen nhân viên chưa — chờ hộp riêng v0.1.63), **kênh bền** (B4), **sức khoẻ** (B5), sửa review, môi trường dev cục bộ ([v0.1.62.md](../releases/v0.1.62.md)); không migration; chưa push — chờ mốc M1.
Trước đó **v0.1.61** (16/10/2026, đã vào main): đợt A phần 1 — mã PIN cho người được giao quyền, bảng quyền/tên vai trò (migration 0036), nháp & gửi tin trung thực, gộp người đủ bảng, lưới `check_terms.py` + route-crawl ([v0.1.61.md](../releases/v0.1.61.md)).
Các bản cũ (v0.1.50 – v0.1.60: Gen nhớ + ghi Kho, tự cập nhật đêm tự lành, Gen hướng dẫn, Mặt tiền Owner v2, thiết lập một màn, sửa QR WhatsApp, khoá thông tin riêng…) xem [CHANGELOG.md](../../CHANGELOG.md) và `docs/releases/`.
Đang chạy, theo nhóm:

- **Cài đặt & vận hành (genh)**: cài một lệnh; `genh update` an toàn (tải trước, sao lưu, migrate, tự quay về bản cũ khi lỗi, khoá `genh.lock`, báo "bị dừng giữa chừng");
  lịch đêm ~03:00 **tự lành** (bật lại khi mất/tắt/không chạy, trừ khi Sếp đã chủ động tắt), **người gác nút Cập nhật ngay tự chữa** (v0.1.54: `.path` failed vì hết hạn mức inotify ⇒ reset-failed + restart, vẫn lỗi ⇒ timer dự phòng quét mỗi phút), `genh auto-update status` nói thật, chọn bản cao nhất đã đủ 24 giờ; `genh export/import`, `genh offsite` (bản sao tuần ra USB/NAS), `genh remote` (Tailscale/Cloudflare/LAN/local),
  trực canh 12 phút → Telegram, gói chẩn đoán. Cổng mặc định chỉ nghe 127.0.0.1 (máy cũ giữ 0.0.0.0 + một chuông nhắc).
- **Phát hành & CI**: xem "Quy trình phát hành" dưới; ảnh ghim digest, `uv.lock --frozen`, action ghim SHA, quét bảo mật dạng báo cáo, `check_*` trong `.github/scripts`. Môi trường dev riêng `genh-dev` (cổng 184xx, `make dev-up`; [dev-local.md](../dev-local.md)) — không đụng bản cài thật.
- **Console**: 11 dịch vụ compose (`proxy web migrate api worker bridge browser browser-redis browser-egress db redis`); menu 6 mục + Nâng cao; trình thiết lập; Hướng dẫn thiết lập;
  **Mặt tiền Owner** `/owner/*` (v0.1.60: 5 trụ cột Tình báo/Thông tin/Quan hệ/Phân tích/Việc + Cài đặt 4 khối; Owner mở `/` vào đây; Console ở Cài đặt › Cài đặt nâng cao); thiết lập một màn `/setup` (Tài khoản → Nguồn AI → Xong, mọi "Chọn model" về `/setup?buoc=nguon-ai`); Việc Sếp cần làm (10 dòng, 1 bắt buộc = nguồn AI, kết quả ở `ops.boss_checks`); chuông + dải "Cần Sếp xử lý"; Trợ giúp (gói chẩn đoán, cập nhật, **Lộ trình học cùng Gen**); phiên 7 ngày trượt, tối đa 30 ngày; PIN ở đường hạ rào.
- **Gen (chỉ Owner)**: khung chat nhớ hội thoại; Bản tin 07:30/17:30; dẫn đường trên UI; **8 loại đề xuất** có Xác nhận (draft_message, reminder, assign, social_reply, social_dm,
  **memory_note, kho_create, kho_update**); **Gen nhớ** (30 ghi chú, Cài đặt › Bộ não AI); đọc Kho + lịch/mail/việc/Drive qua Gen-hub (đã che) và Tài liệu/Deal/Vụ việc nội bộ;
  **ghi Kho** (Phiên, Việc) chỉ qua đề xuất + mã PIN + permit; mỗi bản mới Gen đề xuất một Phiên (F-87);
  **Gen hướng dẫn** (v0.1.54): thẻ Hôm nay của Sếp (≤ 3 việc cần làm ngay, mẹo, bài k/19), chấm đỏ, chuông `gen.coach` ≤ 1/ngày, dòng Bản tin x/N, tool `coach.status` — không gọi model, chỉ Owner, khuyên không ép.
- **Model AI**: **hồ sơ tiêu chuẩn theo vai** (v0.1.55: không cần gán model; dòng gán của Owner thắng; Về mặc định), chọn Nhanh/Kỹ hơn trong khung chat; ModelRouter (khoá API Gemini/OpenRouter/OpenAI-compat), agy phân lớp (v0.1.62: dùng cho lớp core/nội bộ — Gen của Sếp, Bản tin, sàng lọc, agent không gắn kênh, việc nền; chưa dùng cho `core.reply`, agent ngoại giao và Gen của nhân viên; một hàm quyết định `agy_policy.decide`), Claude Code CLI (Owner tự quyết rủi ro, QD-12); model và mức suy nghĩ tách riêng;
  việc nền mặc định chỉ khoá API; chi phí ₫/ngày + trần; Jev tuỳ chọn: lọc trước tin trùng/rác (che dữ liệu bắt buộc, v0.1.55; QD-10 bỏ Jules).
- **Kênh**: Zalo/WhatsApp qua bridge (v0.1.62 bền: mất mạng không xoá phiên, nút Nối lại bằng phiên đã lưu, Đăng xuất khi phiên lỗi; QR; WhatsApp v0.1.59: mã vẽ lớn, Baileys ghim 7.0.0-rc14, thử lại có giãn cách); Telegram một chiều tới Sếp; Facebook cá nhân đọc + Trả lời bình luận/Nhắn tin có Xác nhận + PIN + ảnh chụp (đăng bài = lát 2).
- **Dữ liệu & bảo mật**: Postgres 16 (pgvector, pg_partman), RLS chỉ là phòng thủ phụ (mỗi bản cài 1 tổ chức), hạn lưu thật, bí mật mã hoá phong bì, DNS ghim cho MCP/Gen-hub, ngắt mạch Gen-hub 60 giây.

## v0.1.62 — Đợt A phần 2 + Antigravity phân lớp + kênh bền + sức khoẻ (nhánh `claude/v0162`, tích hợp cục bộ `local/v0162-rc`)

- **Vì sao**: kiểm kê 16/10 — app chỉ cho xem một phần dữ liệu, OTP đi thẳng vào model, mất mạng là mất phiên Zalo/WhatsApp; Sếp chốt Antigravity theo kiến trúc phân lớp.
- **Thay đổi**: A4 A5 A8 A9 A10 A11 A12 (xem hết/tìm ở máy chủ, che OTP, Cung–Cầu, `check_doc_facts.py`); agy phân lớp + `prctl` + timeout/flock + canary shell; B4 kênh bền; B5 `bridge.silent` + hàng lỗi Phát lại/Xoá; B1 test hợp đồng; sửa review (dò SĐT, con trỏ, Dockerfile + so băm, chỉ api sinh mã thiết lập).
- **Chưa làm**: hộp riêng agy (Nợ #34, v0.1.63); Telegram 2 chiều (Nợ #13, v0.1.64); Nợ #42–#45 (`list_promises` con trỏ, nút Chạy lại tin lỗi, allowlist egress `agy-out`, chuyển cả core vào hộp); `--live` canary agy và thử thật trên dev chưa chạy.
- **Sếp cần làm**: xem "Sếp cần làm bây giờ" ở mục Việc dở. Chi tiết: [v0.1.62.md](../releases/v0.1.62.md).

## Người lái và kế hoạch v0.1.63 – v0.1.70

Claude Code chạy trên máy cục bộ là người lái DUY NHẤT (từ 16/10/2026; phiên đám mây đã dừng). Mỗi bản ≤ 4 gói không chồng tệp (QD-14), tối đa 1 migration/bản; push theo 4 mốc: M1 = v0.1.63–64, M2 = v0.1.65, M3 = v0.1.66–67, M4 = v0.1.68–70.

- **v0.1.63** hộp riêng Antigravity `agy-box` (không khoá/DB/bí mật) cho ngoại giao + sàng lọc tin người lạ; một hàm "nguồn AI dùng được" (B2).
- **v0.1.64** Telegram 2 chiều (Nợ #13, đúng `chat_id` của Sếp, không nhận mã PIN) + sàng lọc ghi loại người, đánh dấu nhân viên (B6).
- **v0.1.65** chế độ nghe & danh bạ (F1, migration duy nhất; thu thành viên mọi nhóm, tin 1-1 lưu im lặng).
- **v0.1.66** model hiển thị = model chạy (một bộ chọn model + bảng tầng) · **v0.1.67** agent làm và nói thật (tạo/sửa/bật tắt/nhân bản).
- **v0.1.68** một danh sách việc, thiết lập nói thật · **v0.1.69** chuông có vòng đời + mặc định đúng QD · **v0.1.70** câu chữ sạch, hạ baseline Nợ #39/#40.

Nhánh local đang làm (CHƯA push, ngoài `claude/v0162`): **H1** (dịch vụ `agy-box`), **H2** (chính sách vai nào chạy agy ở đâu), **H3** (genh + phát hành mang `agy-box`), **B2** (nguồn AI dùng được), **T** (Telegram 2 chiều), **B6** (sàng lọc ghi loại người). Gộp theo mốc; mỗi bản: gộp gói → bộ kiểm đầy đủ MỘT lần → `/code-review` (+ `/security-review` khi chạm khoá, PIN, quyền, container) → thử trên dev → ảnh 390/1440.

## Quy trình phát hành & cổng

1. Nhánh làm việc → PR vào `main`; CI xanh thì tự merge squash (Boss đã cho phép), sau đó **nối lịch sử main vào nhánh bằng merge** (không reset/force-push).
2. Tăng `VERSION` ⇒ `release.yml`: CI chạy trước → Release dạng **bản thử** (prerelease) → `e2e-install` + mọi ô `e2e-upgrade` + `e2e-rollback` + `e2e-nightly-real` (v0.1.53) xanh → **promote** thành bản chính thức (latest);
   lịch đêm đợi thêm 24 giờ. Chi tiết: `docs/handoff/05-installer.md` mục "Cổng phát hành".
3. Báo Boss "đã phát hành" chỉ sau khi **kiểm genh tải về** (checksum + `genh version` khớp tag) và `releases/latest` là đúng tag mới. Promote tay (`skip_e2e`) chỉ khi E2E lỗi ngoài mã.
4. Mỗi bản ghi: [CHANGELOG.md](../../CHANGELOG.md) (3–5 dòng) + `docs/releases/vX.Y.Z.md`; file này chỉ cập nhật hiện trạng + việc dở (≤ 200 dòng, có test).
5. Bật bảo vệ nhánh `main` + tag `v*` (cần quyền admin repo, ~2 phút): xem [v0.1.33.md](../releases/v0.1.33.md). Không thêm `paths-ignore: docs/**` cho `ci.yml`.

## Việc dở

### Sếp cần làm bây giờ (MỘT danh sách — khớp "Hướng dẫn › Việc Sếp cần làm" trong app; chỉ việc 1 là bắt buộc)

1. **Bắt buộc duy nhất**: có ít nhất một nguồn AI chạy được — màn **Thiết lập nguồn AI** (`/setup?buoc=nguon-ai`) → dán khoá API hoặc đăng nhập Google / Claude Code → **Kiểm tra**. Antigravity báo hết hạn ⇒ đăng nhập lại ở đó.
   Chưa có khoá API thì agent trực kênh và Soạn lại / Dịch nháp chưa chạy bằng Antigravity (tới khi có hộp riêng, v0.1.63).
2. Sau khi bản mới ra: `genh update` (hoặc đợi lịch đêm). Thẻ Zalo/WhatsApp "Mất liên lạc" ⇒ **Nối lại bằng phiên đã lưu**.

### Tuỳ chọn — không bắt buộc, làm khi muốn (cách làm chi tiết ở `docs/releases/vX.Y.Z.md` của từng bản)

- **Gen-hub** ([v0.1.49](../releases/v0.1.49.md), [v0.1.50](../releases/v0.1.50.md)): tick quyền ĐỌC (lịch, mail, việc, Drive) và GHI Kho (`kho_create`, `kho_update`, không tick gì khác) → Kết nối › Gen-hub › **Kiểm tra** (mã PIN);
  rồi duyệt đề xuất "Phiên" đầu tiên (Xác nhận + mã PIN) và thử Gen nhớ ("nhớ giúp em: …"). Chưa tick thì thẻ Ghi vào Kho dữ liệu bị khoá nút Xác nhận; phần còn lại vẫn chạy. Tên Kho: ô "Tên Kho" (≤ 40 ký tự, [v0.1.57](../releases/v0.1.57.md)).
- **Telegram** ([v0.1.44](../releases/v0.1.44.md)): tạo bot qua @BotFather → Kết nối › Telegram: dán mã, **Tìm chat_id**, **Lưu** (PIN), **Gửi thử**. Linux: nếu Console nhắc, chạy một lần `sudo loginctl enable-linger $USER`.
- **Truy cập từ xa** ([v0.1.46](../releases/v0.1.46.md)): chọn cách truy cập (khuyên Tailscale: `genh remote tailscale`), bấm "Kiểm tra NGAY TRÊN ĐIỆN THOẠI", mời thử một nhân viên.
- **Facebook trả lời** ([v0.1.47](../releases/v0.1.47.md)): thẻ "Gửi trả lời & tin nhắn" — nếu ghi "Khoá" thì đọc cảnh báo và tự quyết; nghiệm thu thật một lần bằng bình luận trên bài của chính Sếp.
- **WhatsApp quét QR thật** ([v0.1.59](../releases/v0.1.59.md), Nợ #35): Kết nối › WhatsApp › Tạo mã QR → tích "Tôi hiểu rủi ro…" → quét (điện thoại cách màn hình 20–30 cm). Vẫn lỗi ⇒ chụp thẻ WhatsApp (có "Chi tiết kỹ thuật") gửi Claude.
- **Gen hướng dẫn** ([v0.1.54](../releases/v0.1.54.md)): nút Gen (chấm đỏ) → thẻ Hôm nay của Sếp → **Chỉ cho em**; việc không dùng thì **Không dùng việc này**; dùng thử một tuần rồi báo Claude thẻ có đúng việc, chuông có phiền không.
- **Tự cập nhật đêm** ([v0.1.53](../releases/v0.1.53.md)): `genh auto-update status` phải ghi **BẬT** (có dòng CẢNH BÁO ⇒ chạy đúng lệnh nó in); muốn tắt hẳn: `genh auto-update disable`. Cập nhật không có nút "Cập nhật ngay" ⇒ đọc lý do trên thẻ.
- **Mặt tiền** ([v0.1.55](../releases/v0.1.55.md), [v0.1.60](../releases/v0.1.60.md)): mở `/owner` (Tình báo, Thông tin, Quan hệ); thẻ "Áp model chuẩn theo vai?" ⇒ **Mở** → **Áp model chuẩn theo vai** → Xác nhận. Đổi nguồn AI sau thiết lập: Cài đặt › Nguồn AI › Đổi nguồn AI.
- **Jev** ([v0.1.55](../releases/v0.1.55.md)): Cài đặt › Bộ não AI › thẻ Jev → "Dùng khóa OpenRouter đang có" → PIN → **Thử 12 câu mẫu** → gửi kết quả cho Claude để chốt ngưỡng lọc. Không bật thì vẫn lọc bằng quy tắc.
- **Repo / CI** ([v0.1.48](../releases/v0.1.48.md), [v0.1.56](../releases/v0.1.56.md), [v0.1.57](../releases/v0.1.57.md)): thêm secret `GH_PERSONAL_PATTERNS` (chưa thêm thì CI chỉ cảnh báo); duyệt PR #137 ở repo Brain; cài Renovate App; xem `docs/design/seed-data.json` có tên khách thật không. Repo giữ công khai (đã quyết 10/10).
- **Chờ Sếp cho phép (một câu mỗi việc)**: "cho xoá nhánh" (F-70, ROADMAP › Nợ); dặn Gen đề xuất Phiên bù (Nợ #7 — cần Sếp mở lại quy trình Kho, đang tạm ngưng từ 16/10).

### Claude / điều phối viên còn dở

- **Phát hành v0.1.62**: tích hợp cục bộ `local/v0162-rc` (đã gộp A4 A5 A8–A12, agy, B4, B5, B1, K/R/G, dev-local) → bộ kiểm đầy đủ → review → push theo mốc M1 cùng v0.1.63–64 (mặc định) → PR → CI xanh → merge squash → bản thử → E2E → promote → kiểm genh tải về khớp tag → báo Boss.
- **Chưa làm (mang từ v0.1.58)**: bước rẻ ở `e2e-install` (`agy --help | grep -- --effort`, `missing_reason` trong container); ô chọn model vẫn ẩn khi Kiểm tra đỏ (`offeredGroups`). **Nợ #34** hộp riêng agy (đang làm v0.1.63) · **Nợ #35** kiểm WhatsApp QR với máy chủ thật.
- **Bản kế tiếp (đã hẹn)**: nhận kết quả "Thử 12 câu mẫu" của Jev từ Boss rồi quyết ngưỡng lọc trước; Boss dùng thử Mặt tiền v2 rồi góp ý; chuông Gen dẫn về Mặt tiền; xoá hội thoại Gen thì xoá luôn lựa chọn model đã nhớ (Nợ #29); dọn mã chết trình thiết lập cũ (Nợ #36).
- **H-b còn mở**: timer đêm mất lịch khi `daemon-reload`/`enable` chạy từ bên trong service đêm — không tái hiện được bằng mã lẫn `e2e-nightly-real` (systemd thật: sau lần chạy timer vẫn có lần kế tiếp); tự lành bao ca này. Máy thật còn tái diễn thì ghi vào v0.1.53.md.
- **PR Renovate** không tự merge nằm chờ tới khi Boss nhắn "xử lý PR phụ thuộc"; chưa có lịch tự động nào gọi Claude.
- **Selector ghi Facebook** mới kiểm trên trang mẫu — chờ nghiệm thu thật (dòng 8). Chuông phiên hết có thể hiện hai lần (`social.paused` + `social.session_expired`), gộp ở bản sau nếu phiền.
- **Giới hạn đã biết**: TOTP chưa làm; Redis lỗi ⇒ giới hạn đăng nhập tạm không áp; gói apt trong Dockerfile chưa ghim phiên bản; tag GHCR `:latest` cũ đứng yên (không dùng).
- **Mục Nợ đầy đủ** (bộ câu hỏi chuẩn so model, F-70, TOTP, Facebook đăng bài lát 2, cosign/minisign, PHIEN bù, trường Kho "Công cụ"/"Người làm", lời hẹn trượt F-91/F-92, Gen hướng dẫn: `release_todos`, danh mục tính năng, "Làm giúp" G8, bộ bài cho nhân viên, tắt chuông theo loại…; Nợ #34–#37 và #42–#45: hộp riêng agy, WhatsApp QR thật, mã chết trình thiết lập cũ, bảng Quan hệ ở 1024px, `list_promises` con trỏ, Chạy lại tin lỗi, allowlist egress `agy-out`): [ROADMAP › Nợ](../ROADMAP.md).
