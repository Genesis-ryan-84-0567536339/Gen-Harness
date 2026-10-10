# Nhật ký thay đổi Gen-Harness

Mới nhất ở trên. Mỗi bản 3–5 dòng; chi tiết (vì sao, thay đổi theo mã, kiểm tra, việc Boss phải làm) ở `docs/releases/vX.Y.Z.md`.
Hiện trạng và việc dở: [docs/reports/HANDOFF-v0.1.1.md](docs/reports/HANDOFF-v0.1.1.md) · tiến độ và mục Nợ: [docs/ROADMAP.md](docs/ROADMAP.md) ·
vận hành: [docs/runbook.md](docs/runbook.md).
Ngày = ngày Release trên GitHub theo giờ Việt Nam; tiêu đề trong `docs/releases/` có thể ghi ngày làm việc nên lệch 1 ngày
(v0.1.32–v0.1.34, v0.1.40, v0.1.46) hoặc vài ngày (v0.1.47, v0.1.48: làm 03/10, phát hành 09/10).
Việc sửa nóng không đổi số bản (PR #46, #48, #53, #55, #58, #59) ghi ở [ROADMAP › Bản phản ứng](docs/ROADMAP.md).

## v0.1.54 — Gen hướng dẫn: Gen chủ động nhắc việc Sếp cần làm, giới thiệu tính năng, bài học mỗi ngày (10/10/2026)
- Thẻ **Hôm nay của Sếp** ở đầu khung Gen (chỉ Owner): tối đa 3 **Việc cần làm ngay** (sự cố, dòng bắt buộc, sao lưu, token Gen-hub, nháp chờ duyệt…), một mẹo **Sếp biết chưa?** và **Bài học hôm nay · k/19**; mỗi việc có Chỉ cho em / Để mai / Không dùng việc này (việc khẩn không tắt được).
- Lộ trình 19 bài (10 bài nội dung + 9 bài từ Hướng dẫn thiết lập) ở Trợ giúp › Lộ trình học cùng Gen; chấm đỏ ở nút Gen; chuông `gen.coach` tối đa 1/ngày (09:05/11:05/14:05, có giờ yên lặng, không đẩy Telegram); Bản tin thêm dòng "Việc bắt buộc: đã đạt x/N".
- Cài đặt › Bộ não AI › Gen hướng dẫn (bật/tắt, chuông, số bài mỗi ngày, giờ yên lặng, Bật lại); Gen có tool `coach.status` để trả lời "em cần làm gì?". Không gọi model, không ghi hội thoại; migration 0033.
- **Người gác yêu cầu tự chữa**: bài học máy Boss — `gen-harness-update-request.path` rơi vào failed "Result: resources" vì hết hạn mức inotify (mặc định 128, đang dùng 174) nên nút Cập nhật ngay không có ai nhận; `genh auto-update enable|status` và `handle-requests` nay `reset-failed` + restart, vẫn lỗi thì bật timer dự phòng quét mỗi phút và nói rõ lệnh `sudo sysctl -w fs.inotify.max_user_instances=1024`; thẻ Sức khoẻ có dòng cảnh báo, E2E thật có ca inotify.
- Chi tiết: [docs/releases/v0.1.54.md](docs/releases/v0.1.54.md) · thiết kế: [docs/design/gen-coach.md](docs/design/gen-coach.md)

## v0.1.53 — Tự cập nhật đêm tự lành + trung thực (10/10/2026)
- Máy Boss kẹt ở v0.1.44 từ 03/10 đến 09/10: lịch tự cập nhật đêm bị tắt mà `genh auto-update status` đọc sai và không ai biết, nút Cập nhật ngay trên Console chỉ nói "chưa nhận yêu cầu" (F-93, F-94, F-99).
- `genh update` tự lành: bật lại lịch đêm khi unit mất/tắt/không chạy (trừ khi Sếp đã chủ động tắt); `genh auto-update status` nói thật (5 thông tin: bật/tắt thật, cơ chế, enabled/active, lần chạy gần nhất/kế tiếp, linger) và cảnh báo khi log im quá 36 giờ; kiểm linger sau `enable-linger` (F-93, F-94, F-95).
  **Thay đổi hành vi**: máy đã tắt lịch đêm từ trước v0.1.53 (chưa có dấu "Sếp đã tắt") được bật lại một lần — muốn tắt hẳn: `genh auto-update disable`; `install --no-auto-update` nay tắt luôn lịch đêm đang có của bản cài đó.
- Lịch đêm chọn bản cao nhất đã đủ 24 giờ trong 10 bản gần nhất, không bị bản mới chưa chín chặn "đói" (F-96); nút Cập nhật ngay không kích lặp và không kẹt khi tệp yêu cầu không xoá được (GH-E94C, F-97); unit đêm mang `--install-dir`/`--port` và bản cài phụ không gỡ/ghi đè lịch của bản chính (F-98).
- Console nói rõ nguyên nhân "chưa nhận yêu cầu" (linger tắt / trình nhận yêu cầu lỗi) và cảnh báo lịch đêm im (F-99); E2E chạy thật timer và `.path` dưới user manager có linger, bắt buộc trước promote (F-100).
- Chi tiết: [docs/releases/v0.1.53.md](docs/releases/v0.1.53.md)

## v0.1.52 — Sửa cổng phát hành lần 2: genh gỡ digest cũ của ảnh đang chạy bằng `rmi -f` (10/10/2026)
- Thay v0.1.51 chưa promote: E2E nâng cấp vẫn đỏ ở bước "chỉ còn ảnh của bản hiện tại và bản liền trước" vì Docker từ chối gỡ digest cũ của `gen-harness-db` (container db đang chạy ảnh này). v0.1.52 chứa toàn bộ v0.1.51 + v0.1.50 + sửa này.
- Docker coi mọi digest của cùng một repo là MỘT tham chiếu nên `rmi repo@digest` bị chặn dù còn digest khác trỏ cùng ảnh; `genh update` nay dùng `rmi -f` chỉ cho digest mà ảnh còn được tham chiếu giữ (chỉ untag, không xoá ảnh).
- Chi tiết: [docs/releases/v0.1.52.md](docs/releases/v0.1.52.md)

## v0.1.51 — Sửa cổng phát hành: genh dọn cả tham chiếu digest cũ của ảnh trùng nội dung (10/10/2026)
- Thay v0.1.50 chưa promote: E2E nâng cấp đỏ ở bước "chỉ còn ảnh của bản hiện tại và bản liền trước" nên v0.1.50 nằm yên ở bản thử. v0.1.51 chứa toàn bộ v0.1.50 + sửa này.
- `genh update` dọn ảnh cũ theo CHÍNH tham chiếu (repo@digest / repo:tag) thay vì theo IMAGE ID: ảnh `gen-harness-db` không đổi nội dung qua nhiều bản (cùng ID, khác digest) nên digest cũ trước đây không bao giờ bị gỡ.
- Chi tiết: [docs/releases/v0.1.51.md](docs/releases/v0.1.51.md)

## v0.1.50 — Gen nhớ + Gen ghi Kho có xác nhận và mã PIN (09/10/2026)
- Gen nhớ: ghi chú quy ước/sở thích của Sếp lưu cục bộ (tối đa 30), Gen đề xuất — Sếp xác nhận — sửa/xoá ở Cài đặt › Bộ não AI (F-81, migration 0032).
- Ghi vào Kho Ryan: Gen đề xuất `kho_create`/`kho_update` cho Phiên/Việc; chỉ ghi sau Xác nhận + mã PIN + permit ký, qua Gen-hub (QD-18, F-81).
- Mỗi bản mới Gen tự đề xuất một Phiên (chuông + thẻ); Kết nối › Gen-hub có "Quyền ghi Kho"; Việc Sếp cần làm thêm dòng 9 "Gen ghi Kho" (F-87).
- Tài liệu đồng bộ: CHANGELOG + `docs/releases/`, HANDOFF ≤ 200 dòng, ROADMAP có mục Nợ, README/runbook, script kiểm link (F-90, F-69, F-47, F-91, F-92, F-42, F-39).
- Gộp từ main: sửa trình bày (PR #58 — chữ dính biên khung, Icon rớt dòng, lính gác bố cục 4 cỡ màn) và genh đọc tệp trạng thái thử lại khi tệp vừa bị thay (PR #59).
- Chi tiết: [docs/releases/v0.1.50.md](docs/releases/v0.1.50.md)

## v0.1.49 — Gen đọc lịch / mail / việc / Drive qua Gen-hub, chỉ đọc (09/10/2026)
- Gen (chỉ Owner) trả lời được lịch, mail, việc Google, tệp Drive qua Gen-hub và Tài liệu/Deal/Vụ việc nội bộ — đã che; tool ghi bị chặn ở mọi đường (QD-16).
- Ngắt mạch riêng cho Gen-hub (3 lỗi → mở 60 giây; im 15 phút → sự cố + chuông) (F-83).
- Bản tin Gen thêm "Lịch hôm nay", "Mail cần trả lời", "Việc Google đang mở"; Telegram chỉ có số đếm (F-8).
- Chi tiết: [docs/releases/v0.1.49.md](docs/releases/v0.1.49.md)

## v0.1.48 — Bản build tái lập & pipeline gọn (09/10/2026)
- Ảnh nền, caddy, redis ghim digest đa kiến trúc; api/browser cài từ `uv.lock` (`uv sync --frozen`); Renovate đề xuất nâng (F-19, F-36).
- Mọi action ghim SHA, quyền mặc định `contents: read`, bỏ ảnh `:latest`, build thử lại và kiểm tái lập (F-71).
- Quét bảo mật dạng báo cáo (pip-audit, npm audit, govulncheck); CI đỏ khi bản nhúng genh lệch `deploy/` (F-13, F-44).
- Chi tiết: [docs/releases/v0.1.48.md](docs/releases/v0.1.48.md)

## v0.1.47 — Facebook ghi, lát 1 (09/10/2026)
- Gen đề xuất Trả lời bình luận và Nhắn tin; chỉ gửi sau Xác nhận + mã PIN + permit ký, có ảnh chụp bằng chứng và Dừng tất cả (F-79).
- Sandbox Chromium bật bằng user namespace + seccomp riêng; không bật được thì chỉ mở gửi khi Owner đồng ý rủi ro (F-85).
- Kiểm phiên Facebook hằng ngày 09:10 → sự cố + chuông + Telegram (F-83); trễ cố định 3 giây (F-59); gỡ số bản khỏi chú thích "chỗ cắm" (F-92).
- Chi tiết: [docs/releases/v0.1.47.md](docs/releases/v0.1.47.md)

## v0.1.46 — Nhân viên & điện thoại vào được (04/10/2026)
- Cài mới chỉ nghe 127.0.0.1; máy cũ giữ 0.0.0.0 và nhận đúng một chuông "Cổng đang mở cho cả mạng" (F-27, F-21).
- `genh remote tailscale|cloudflare|--lan|--local`; lời mời lấy địa chỉ theo `GH_PUBLIC_URL`; dòng 7 "Truy cập từ xa" ở Việc Sếp cần làm.
- Chặn dò mật khẩu 10 lần/15 phút (theo IP và email), phiên tối đa 30 ngày (F-1, F-3).
- Chi tiết: [docs/releases/v0.1.46.md](docs/releases/v0.1.46.md)

## v0.1.45 — Khoá cấu hình nhạy cảm & vệ sinh bảo mật (03/10/2026)
- Mã PIN chỉ ở đúng đường hạ rào (mức tự trị, điều cấm, giới hạn, tool MCP ghi, tài khoản CLI) (F-20, F-60).
- MCP và nhà cung cấp AI ghim DNS, cấm địa chỉ nội bộ, có token thì phải https (F-49); nhật ký MCP chỉ lưu dấu vết (F-57).
- Hộp thư `run/` 2770, mật khẩu pg_dump qua `PGPASSWORD`, WebSocket kiểm Origin, cờ "Đáng ngờ" cho điểm nhân sự (F-52, F-54, F-55, F-56, F-58).
- Chi tiết: [docs/releases/v0.1.45.md](docs/releases/v0.1.45.md)

## v0.1.44 — Kênh Telegram tới Sếp + Trực canh máy chủ + Gói chẩn đoán (03/10/2026)
- Trực canh `gen-harness-watchdog` mỗi 12 phút, tự khởi động lại dịch vụ chết, báo Telegram chống spam (F-6).
- Bot Telegram của Sếp ở Kết nối › Telegram nhận Bản tin 07:30/17:30 và nhắc việc, một chiều (F-8).
- `X-Request-ID` + "Mã yêu cầu" cạnh mã ERR; Gói chẩn đoán ở Trợ giúp, đã lọc bí mật (F-4).
- Chi tiết: [docs/releases/v0.1.44.md](docs/releases/v0.1.44.md)

## v0.1.43 — Bỏ lời hứa không thật & chữ khó hiểu (03/10/2026)
- Bỏ "Dùng dữ liệu mẫu" ở bước 1; gán model chỉ còn 3 khoá lõi; màn trống dẫn đường (F-23, F-25, F-29).
- Thang tự trị 3 mức ở giao diện, Lọc tin Thấp/Vừa/Cao, ẩn độ tin cậy trên thẻ Hộp thư (F-30, F-62).
- Chuẩn hoá chữ dùng chung (`gh/textnorm.py`), nháp tin Gen ghi rõ "chưa gửi" (F-38, F-24).
- Chi tiết: [docs/releases/v0.1.43.md](docs/releases/v0.1.43.md)

## v0.1.42 — "Chế độ Boss": một menu gọn theo việc (03/10/2026)
- Thanh bên 6 mục + "Nâng cao" thu gọn, không có công tắc hay cây menu thứ hai (F-7, F-26).
- Trang Kết nối một trang với trạng thái thống nhất; Đội ngũ; Cài đặt lọc tab theo quyền (F-61, F-63–F-67).
- Mỗi thẻ một chỗ; Plugin ẩn và đóng băng (F-41).
- Chi tiết: [docs/releases/v0.1.42.md](docs/releases/v0.1.42.md)

## v0.1.41 — Gen trợ lý thật, lát 1 (03/10/2026)
- Gen nhớ hội thoại qua tải lại; Bản tin Gen 07:30/17:30; nút Hữu ích / Không hữu ích (F-8).
- Việc nền mặc định chỉ dùng khoá API; Claude Code CLI chỉ khi Owner bật (cảnh báo + PIN) (F-86, QD-12).
- Chi phí AI ₫/ngày theo agent có trần; mẫu nhà cung cấp OpenRouter (F-84); migration 0027.
- Chi tiết: [docs/releases/v0.1.41.md](docs/releases/v0.1.41.md)

## v0.1.40 — Dữ liệu an toàn: bản sao ngoài máy + hạn lưu thật (03/10/2026)
- `genh offsite`: bản sao mã hoá hằng tuần ra USB/NAS, tự kiểm gói, Bộ khôi phục, "Tải gói mang đi" (F-12).
- Hạn lưu dữ liệu thật (`gh/retention.py`); job nặng không chậm dần, job quá giờ có chuông (F-2, F-16).
- Bỏ S3/MinIO giả; `genh uninstall` mặc định giữ dữ liệu; migration 0026.
- Chi tiết: [docs/releases/v0.1.40.md](docs/releases/v0.1.40.md)

## v0.1.39 — Kết nối chạy thật cùng Boss (02/10/2026)
- Trang "Việc Sếp cần làm" (Gen-hub, Facebook, Google/agy, Claude Code CLI, Jev); kết quả lưu ở `ops.boss_checks` (F-74, F-76, F-77, F-78).
- Mạng xã hội trên thanh bên, một tên "Hướng dẫn thiết lập", lỗi Gen-hub có mã thống nhất (F-31, F-32, F-28).
- Migration 0025; `GET /boss-checks` để Claude tự đọc kết quả.
- Chi tiết: [docs/releases/v0.1.39.md](docs/releases/v0.1.39.md)

## v0.1.38 — Cô lập Antigravity CLI + gói chuyển máy (02/10/2026)
- agy chạy cwd rỗng 0700, env sạch, prompt qua stdin; chỉ dùng cho Gen của Sếp (F-22).
- Phiên Claude Code sang volume `claude_state`; canary offline "không lộ".
- Gói chuyển máy mã hoá lại phiên mạng xã hội (F-17).
- Chi tiết: [docs/releases/v0.1.38.md](docs/releases/v0.1.38.md)

## v0.1.37 — Cập nhật tự lành (02/10/2026)
- Khoá loại trừ `genh.lock`, bắt SIGTERM, rollback không bị huỷ; Console hiện "bị dừng giữa chừng" + Thử lại (F-34, F-73).
- Tải binary genh theo thời gian rảnh, thử lại 3 lần (F-72); kiểm linger và `docker.service` (F-73); E2E nâng cấp nhiều bản (F-35).
- Chi tiết: [docs/releases/v0.1.37.md](docs/releases/v0.1.37.md)

## v0.1.36 — Hệ thống tự báo khi hỏng + sao lưu chắc (02/10/2026)
- Chuông sự cố khử trùng lặp, `GET /system/health`, dải "Cần Sếp xử lý" (F-6, F-3, F-4).
- Sao lưu timeout 3600 giây, bị huỷ thì báo; log JSON có error_id; cron theo giờ VN (F-45, F-46, F-2).
- Chi tiết: [docs/releases/v0.1.36.md](docs/releases/v0.1.36.md)

## v0.1.35 — Sửa lỗi đỏ trong ứng dụng (02/10/2026)
- Giao việc / gán người / gán BOT dùng người và trợ lý thật (`/pickers/*`) (F-1).
- Tài liệu không phải PDF/ảnh buộc tải xuống + CSP sandbox; Sổ tay theo quyền Kho (F-5, F-15).
- PIN cho nhà cung cấp AI; lỗi thân thiện có mã; e2e thật rút gọn trong CI (F-20, F-43, F-14).
- Chi tiết: [docs/releases/v0.1.35.md](docs/releases/v0.1.35.md)

## v0.1.34 — `genh update` an toàn (02/10/2026)
- Tải bản mới trước khi sao lưu; chỉ khôi phục CSDL khi đã migrate; bản lỗi tự quay về bản cũ (F-10, F-33).
- Đã mới nhất thì không sao lưu/tải; kiểm đĩa, dọn ảnh cũ, giới hạn log 10 MB × 3 (F-11, F-37).
- E2E có dữ liệu mẫu và job bản hỏng cố ý (F-35).
- Chi tiết: [docs/releases/v0.1.34.md](docs/releases/v0.1.34.md)

## v0.1.33 — Cổng phát hành & CI đủ test (02/10/2026)
- CI chạy trước Release; Release ra dạng bản thử, E2E cài thật xanh mới nâng thành bản chính thức; lịch đêm đợi chín 24 giờ (F-9).
- CI thêm go vet/test 4 hệ điều hành, pytest dưới vai app, Playwright mock, kiểm alembic 1 head (F-13).
- Chi tiết: [docs/releases/v0.1.33.md](docs/releases/v0.1.33.md)

## v0.1.32 — Model và mức suy nghĩ tách riêng (02/10/2026)
- Model và mức suy nghĩ (effort) tách riêng cho agy và Claude Code; chuyển dữ liệu cũ (migration 0023) (F-88).
- Mỗi model có nguồn (CLI / tài liệu chính thức / "chưa xác minh"); nút Chẩn đoán CLI (chỉ Owner).
- Chi tiết: [docs/releases/v0.1.32.md](docs/releases/v0.1.32.md)

## v0.1.31 — Model CLI theo nhóm, nguồn Claude Code CLI (01/10/2026)
- Danh sách model CLI thật theo nhóm, gọi thử thật trước khi lưu; một sự thật cho trạng thái phiên CLI.
- Nguồn mới Claude Code CLI (gói Pro/Max của Owner), cảnh báo điều khoản — Owner tự quyết (QD-12).
- Chi tiết: [docs/releases/v0.1.31.md](docs/releases/v0.1.31.md)

## v0.1.30 — Sửa nóng: màn sập React #31, đổi tài khoản Google (30/09/2026)
- Sửa màn /guide/8 sập "React error #31 {reasons}" khi chưa có model (`MODEL_UNAVAILABLE`); web không vẽ đối tượng lỗi thô.
- Lối vào "Hướng dẫn thiết lập" cố định; mục "Cập nhật phần mềm" có "Kiểm tra bản mới".
- Đổi tài khoản Google của Antigravity CLI hoạt động đúng (gửi tạm tệp phiên, `409 CLI_LOGIN_IN_PROGRESS`).
- Chi tiết: [docs/releases/v0.1.30.md](docs/releases/v0.1.30.md)

## v0.1.29 — Bước 4 "Để sau" + Gen đọc Facebook cá nhân (30/09/2026)
- Bước 4 "Để sau" có hộp cảnh báo; dải "Chưa có model" ở bước 12 và Tổng quan.
- Đợt D3 lát đầu: dịch vụ `browser` + `browser-egress`, màn Tài khoản mạng xã hội, Gen chỉ đọc thông báo và hội thoại Facebook (QD-12).
- Chi tiết: [docs/releases/v0.1.29.md](docs/releases/v0.1.29.md)

## v0.1.28 — Sửa theo rà soát UX (30/09/2026)
- Bước 4 phải có model; bước 12 nói thật việc còn thiếu; lỗi kỹ thuật thành câu dễ hiểu.
- Ma trận quyền tiếng Việt, bớt ngõ cụt cho vai trò khác Owner, giao diện điện thoại (bảng → thẻ).
- Chi tiết: [docs/releases/v0.1.28.md](docs/releases/v0.1.28.md)

## Bản cũ (v0.1.1 – v0.1.27)

Một dòng mỗi bản; chi tiết ở `docs/releases/`.

- v0.1.27 (30/09/2026) — gia cố & phủ test: ghim DNS Gen-hub, hạn lưu chuông, nhắc việc chịu lỗi — [chi tiết](docs/releases/v0.1.27.md)
- v0.1.26 (30/09/2026) — Đợt D1: Gen đọc Kho Ryan qua Gen-hub (chỉ đọc, chỉ Owner) — [chi tiết](docs/releases/v0.1.26.md)
- v0.1.25 (29/09/2026) — Đợt C1: lọc đầu Hộp thư (trùng, rác, điểm), dùng Jev khi có — [chi tiết](docs/releases/v0.1.25.md)
- v0.1.24 (29/09/2026) — Đợt A4: Gen v2 bước 1, đề xuất thao tác có xác nhận — [chi tiết](docs/releases/v0.1.24.md)
- v0.1.23 (29/09/2026) — Đợt B4–B7: điện thoại, trang lỗi/404, chuông thông báo, sáng/tối — [chi tiết](docs/releases/v0.1.23.md)
- v0.1.22 (29/09/2026) — Đợt B1–B3: quản lý người dùng, thông tin công ty, Trợ giúp — [chi tiết](docs/releases/v0.1.22.md)
- v0.1.21 (29/09/2026) — Đợt A1–A3: Gen v1 (khung chat, dẫn đường trên UI, nguồn Jev) — [chi tiết](docs/releases/v0.1.21.md)
- v0.1.20 (29/09/2026) — sao lưu & khôi phục trên giao diện — [chi tiết](docs/releases/v0.1.20.md)
- v0.1.19 (29/09/2026) — "Tài khoản của tôi" + bắt buộc đổi mật khẩu tạm — [chi tiết](docs/releases/v0.1.19.md)
- v0.1.18 (28/09/2026) — đăng nhập lại sau cập nhật, `genh reset-password`, `trust-ca` — [chi tiết](docs/releases/v0.1.18.md)
- v0.1.17 (28/09/2026) — nút "Cập nhật ngay" trong Console — [chi tiết](docs/releases/v0.1.17.md)
- v0.1.16 (28/09/2026) — trang "Hướng dẫn kết nối" từng bước — [chi tiết](docs/releases/v0.1.16.md)
- v0.1.15 (28/09/2026) — "Để sau" thay cho "Bỏ qua" ở trình thiết lập — [chi tiết](docs/releases/v0.1.15.md)
- v0.1.14 (28/09/2026) — trình thiết lập chỉ bắt buộc bước 1–4 — [chi tiết](docs/releases/v0.1.14.md)
- v0.1.13 (28/09/2026) — cài xong trình duyệt không còn báo "Not secure" — [chi tiết](docs/releases/v0.1.13.md)
- v0.1.12 (28/09/2026) — đăng nhập Antigravity CLI trong Console ra link — [chi tiết](docs/releases/v0.1.12.md)
- v0.1.11 (28/09/2026) — ngưỡng đĩa trống 20 GB quá cao — [chi tiết](docs/releases/v0.1.11.md)
- v0.1.10 (28/09/2026) — genh dùng đúng `GEN_HARNESS_HOME` — [chi tiết](docs/releases/v0.1.10.md)
- v0.1.9 (28/09/2026) — api và worker đụng nhau khi chép volume lần đầu — [chi tiết](docs/releases/v0.1.9.md)
- v0.1.8 (28/09/2026) — cài từ bản phát hành: proxy thiếu Caddyfile — [chi tiết](docs/releases/v0.1.8.md)
- v0.1.7 (28/09/2026) — Release không còn treo ở ảnh web — [chi tiết](docs/releases/v0.1.7.md)
- v0.1.6 (28/09/2026, không có Release riêng) — lỗi phát hiện nhờ E2E cài thật — [chi tiết](docs/releases/v0.1.6.md)
- v0.1.5 (28/09/2026) — genh tự thay binary + tự cập nhật theo lịch — [chi tiết](docs/releases/v0.1.5.md)
- v0.1.4 (28/09/2026) — tự động phát hành qua `VERSION` + sửa cài Docker hỏng trên Linux — [chi tiết](docs/releases/v0.1.4.md)
- v0.1.3 (28/09/2026) — sửa mất hồ sơ khi tự nâng cấp genh — [chi tiết](docs/releases/v0.1.3.md)
- v0.1.2 (27/09/2026) — sửa sau rà soát độc lập; khoá backup riêng `GH_BACKUP_KEY` — [chi tiết](docs/releases/v0.1.2.md)
- v0.1.1 (27/09/2026, chỉ có thẻ tag) — sửa lưu trữ, hồ sơ Owner (`.ghbundle`), CSDL, RLS; mục "Lỗi cần sửa" và "Hợp đồng chung" — [chi tiết](docs/releases/v0.1.1.md)
