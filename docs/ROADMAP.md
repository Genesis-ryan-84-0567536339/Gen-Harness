# Gen-Harness — Lộ trình tổng thể (cập nhật 17/10/2026, sau v0.1.63)

Nguồn chuẩn tiến độ. Mỗi đợt = 1 PR = 1 bản phát hành. CI xanh mới tạo bản thử (prerelease); E2E cài thật xanh mới tự
nâng thành bản chính thức (latest); lịch tự cập nhật đêm đợi bản chính thức ra đủ 24 giờ. genh chỉ kiểm SHA-256 theo
checksums.txt — CHƯA kiểm chữ ký cosign (để sau, xem mục Nợ).
Lịch sử từng bản: [CHANGELOG.md](../CHANGELOG.md) + `docs/releases/`. Hiện trạng và việc Boss còn treo:
[HANDOFF](reports/HANDOFF-v0.1.1.md). Vận hành: [runbook](runbook.md). Ngày dùng ngày Release trên GitHub, giờ Việt Nam.

## Vai trò
| Vai | Ai | Việc |
|---|---|---|
| Owner | Sếp | định hướng, duyệt, brainstorm |
| Dev | Claude Code (+ sub agent Haiku/Sonnet/Opus) | code, review, phát hành |
| ~~Dev phụ~~ | ~~Google Jules~~ — **Boss bỏ (QD-10, xác nhận 30/09)** | việc code cho repo khác đi theo agy đa repo (gen-workplace) |
| Quản trị trong app | Gen | vận hành dữ liệu, dẫn Sếp dùng app; đề xuất — Sếp Xác nhận (+ mã PIN khi nhạy cảm) mới làm |
| Vòng ngoài | agent Zalo/WhatsApp (bridge, QR); Facebook cá nhân qua trình duyệt riêng (`apps/browser`, Playwright) | thu thập thị trường; Gen đọc, trả lời/nhắn chỉ khi Sếp xác nhận |

## Đã xong
Chi tiết từng bản ở [CHANGELOG.md](../CHANGELOG.md); tóm tắt theo chặng:
- **v0.1.1 – v0.1.27 (27–30/09/2026)**: lưu trữ/hồ sơ Owner/RLS, `genh` (cài, cập nhật tự động, export/import, khôi phục), trình thiết lập "Để sau",
  Console (người dùng, Trợ giúp, điện thoại, chuông, sáng/tối), **Gen v1/v2** (khung chat, dẫn đường, đề xuất có xác nhận), lọc đầu Hộp thư (Jev),
  Gen đọc Kho dữ liệu qua Gen-hub (v0.1.26), gia cố (v0.1.27).
- **v0.1.28 – v0.1.32 (30/09 – 02/10)**: sửa theo rà soát UX; bước 4 "Để sau"; Facebook cá nhân CHỈ ĐỌC (D3 lát đầu); hotfix React #31; model CLI theo nhóm,
  Claude Code CLI (QD-12), model và mức suy nghĩ tách riêng.
- **v0.1.33 – v0.1.40 (02 – 03/10)** — kế hoạch tổng [docs/audit/2026-10-01/0-ke-hoach-tong.md](audit/2026-10-01/0-ke-hoach-tong.md): cổng phát hành + CI đủ test, `genh update` an toàn/tự lành,
  sửa lỗi đỏ (F-1, F-5…), hệ thống tự báo khi hỏng, cô lập agy, "Việc Sếp cần làm", bản sao ngoài máy + hạn lưu thật.
- **v0.1.41 – v0.1.46 (03 – 04/10)**: Gen trợ lý thật lát 1 (nhớ hội thoại, Bản tin, chi phí AI), "Chế độ Boss" một menu, bỏ lời hứa không thật, Telegram + trực canh + gói chẩn đoán,
  khoá cấu hình nhạy cảm, nhân viên & điện thoại vào được (`genh remote`).
- **v0.1.47 – v0.1.50 (09/10)**: Facebook ghi lát 1 (trả lời/nhắn có xác nhận), bản build tái lập, Gen đọc lịch/mail/việc/Drive qua Gen-hub (QD-16),
  **Gen nhớ + Gen ghi Kho có xác nhận và mã PIN (QD-18, F-81, F-87)**. Cùng đợt: đồng bộ tài liệu (F-90, F-69, F-47, F-91, F-92, F-42, F-39).
- **v0.1.51 – v0.1.53 (10/10)**: bản phản ứng — cổng phát hành dọn ảnh cũ (v0.1.51, v0.1.52) và **tự cập nhật đêm tự lành + trung thực** (v0.1.53, F-93…F-100); xem mục Bản phản ứng bên dưới.
- **v0.1.54 (10/10)**: **Gen hướng dẫn** — Gen chủ động nhắc việc Sếp cần làm, giới thiệu tính năng chưa dùng, bài học mỗi ngày (thiết kế: [gen-coach.md](design/gen-coach.md)). Cùng bản: **người gác yêu cầu tự chữa** (`.path` failed vì hết hạn mức inotify ⇒ reset-failed + restart, vẫn lỗi ⇒ timer dự phòng quét mỗi phút + dòng cảnh báo ở thẻ Sức khoẻ; [v0.1.54.md](releases/v0.1.54.md)).

- **v0.1.55 (10/10)**: **Gọn cho Sếp** — Mặt tiền Owner `/owner/*`, hồ sơ model tiêu chuẩn theo vai + Về mặc định, thiết lập ≤ 4 lần nhập và 1 dòng bắt buộc, thẻ Cập nhật nói lý do, chọn Nhanh/Kỹ hơn trong khung chat, Jev lọc trước tuỳ chọn ([v0.1.55.md](releases/v0.1.55.md)).
- **v0.1.56 (10/10)**: **Không lộ thông tin riêng của Sếp cho Owner khác** — bỏ địa chỉ Gen-hub khỏi web/API/hướng dẫn (chỉ còn chỗ giữ chỗ chung), tên Kho chung "Kho dữ liệu" (`KHO_LABEL`), migration 0035 đổi ghi chú máy chủ Gen-hub cũ, dữ liệu mẫu/mock hư cấu, CI `check_no_personal_info.py` ([v0.1.56.md](releases/v0.1.56.md)).
- **v0.1.57 (10/10)**: khoá nạp dữ liệu mẫu (cờ + DB chưa có dữ liệu thật), **Owner tự đặt Tên Kho** (Nợ #30 xong), **CI `api` chạy hai lượt pytest song song** (Nợ tách lượt xong), bộ kiểm chống lộ chỉ giữ quy tắc chung + mẫu riêng từ secret `GH_PERSONAL_PATTERNS`, **bản công khai đã gọt danh tính riêng — ghi chú riêng của Sếp dời sang Brain (Nợ #31 xong)** ([v0.1.57.md](releases/v0.1.57.md)).
- **v0.1.58 (11/10, bản vá nóng)**: Antigravity CLI đòi mức suy nghĩ — Kiểm tra kết nối thử lại với mức (≤ 4 lượt) và tự lưu model khi nguồn CLI mất dòng model, lượt Gen của Owner tự lành, bảng gán nói lý do thật thay "chưa có nguồn phù hợp", nhãn "Sắp hết hạn" của agy theo khoá làm mới token ([v0.1.58.md](releases/v0.1.58.md)).
- **v0.1.59 (16/10, bản vá)**: sửa quét QR WhatsApp (chưa kiểm với máy chủ WhatsApp thật, Nợ #35) — mã WhatsApp vẽ lớn, xử lý `companion_reg_refresh`, socket lỗi thử lại có giãn cách thay vì mở lại vô hạn, phiên bản WA Web mới (yêu cầu tự nhận là bridge), Baileys ghim `7.0.0-rc14`, thẻ kênh nói lý do lỗi tiếng Việt; thẻ "Hôm nay của Sếp" đọc lại ngay sau Kiểm tra nguồn CLI xanh ([v0.1.59.md](releases/v0.1.59.md)).
- **v0.1.60 (16/10)**: **Mặt tiền Owner v2** — 5 trụ cột có số thật (Tình báo, Thông tin, Quan hệ, Phân tích, Việc), API chỉ đọc `/owner/brief|feed|insights|proposals`, hệ hình ảnh mới + lính gác thiết kế; **Thiết lập một màn 3 bước**, mọi "Chọn model" về `/setup?buoc=nguon-ai`, Cài đặt 4 khối (Nợ #28 xong; [v0.1.60.md](releases/v0.1.60.md)).
- **v0.1.61 (16/10)**: **Đợt A sửa lỗi sau kiểm kê** — mã PIN cho người được giao quyền (tự đặt lần đầu) + phiên PIN hết hạn thật, bảng quyền đổi cả cột + tên vai trò tiếng Việt + mẫu agent (migration 0036), gửi lỗi/mcp_write/tin 1-1 trung thực + nút Gửi lại, gộp người đủ bảng, thẻ Cập nhật, lưới chống tái phát (`check_terms.py` + Playwright duyệt mọi route); còn Nợ #38–#41 ([v0.1.61.md](releases/v0.1.61.md)).
- **v0.1.62 (17/10)**: **Đợt A phần 2 + Antigravity phân lớp + kênh bền + sức khoẻ** — Hộp thư/Việc/Nhật ký/Khách & Nhóm xem hết (con trỏ, tìm ở máy chủ, gán BOT hàng loạt), lỗi sao lưu nói tiếng người, che OTP/mật khẩu trước khi gửi model, Cung–Cầu không ghép bừa, tài liệu khớp mã + `check_doc_facts.py`; **Antigravity (agy) dùng cho lớp core/nội bộ, chưa dùng cho ngoại giao (`core.reply`, agent giao tiếp người ngoài) và Gen nhân viên — chờ hộp riêng v0.1.63**; kênh Zalo/WhatsApp bền (mất mạng không xoá phiên, nút Nối lại, đăng xuất khi phiên lỗi), thẻ Sức khoẻ canh bridge + hàng lỗi có lối xử lý; `prctl` chống dump, timeout/flock agy, Dockerfile luôn cài mã mới + CI so băm; môi trường dev cục bộ ([dev-local.md](dev-local.md)); Nợ #42–#45 ([v0.1.62.md](releases/v0.1.62.md)).
- **v0.1.63 (17/10)**: **Hộp riêng Antigravity + "nguồn AI dùng được" một hàm** — container `agy-box` (không khoá master/DB/Redis; `genh` tự sinh `gh_agy_key`, dựng hộp, `doctor` + Sức khoẻ có dòng riêng); mỗi vai một chỗ chạy agy (Gen của Sếp / agent nội bộ trong tiến trình; Bản tin, sàng lọc, Soạn lại / Dịch nháp, agent trực kênh, Gen nhân viên, thử agent qua hộp; hộp tắt ⇒ nguồn AI kế, không rơi về agy trong tiến trình; Thử quy tắc vẫn không agy); `providers.readiness` thống nhất bước 4 thiết lập, dòng "nguồn AI" và nút Kiểm tra (F002 F010 F014 F035); cổng phát hành `check_agy_box_isolation.py` + E2E `e2e_agy_box.sh`; Nợ #34 xong, #44–#46 ([v0.1.63.md](releases/v0.1.63.md)).

## Tiếp theo (sau v0.1.63)
Kế hoạch tổng của đợt kiểm toán kết thúc ở v0.1.50; không còn đợt đánh số sẵn. Thứ tự đề xuất:
0. **Kế hoạch v0.1.63 – v0.1.70** (8 bản, mỗi bản ≤ 4 gói không chồng tệp; push theo 4 mốc M1 = v0.1.63–64, M2 = v0.1.65, M3 = v0.1.66–67, M4 = v0.1.68–70): **v0.1.63** (xong) hộp riêng Antigravity · **v0.1.64** Telegram 2 chiều (Nợ #13) + sàng lọc ghi loại người · **v0.1.65** chế độ nghe & danh bạ (migration duy nhất) · **v0.1.66** model hiển thị = model chạy · **v0.1.67** agent làm và nói thật · **v0.1.68** một danh sách việc, thiết lập nói thật · **v0.1.69** chuông có vòng đời + mặc định đúng QD · **v0.1.70** câu chữ sạch, hạ baseline Nợ #39/#40. Sếp `genh update` lên v0.1.63 (hộp `agy-box` tự lên), dùng thử Soạn lại / Dịch / agent trực kênh bằng Antigravity, đăng nhập lại Antigravity nếu thẻ báo hết hạn (đăng nhập ở Kết nối như cũ — api gửi phiên sang hộp theo từng lượt); Jev: gửi kết quả "Thử 12 câu mẫu" (HANDOFF › Boss phải làm — v0.1.55) để chốt ngưỡng lọc; Owner quét thử WhatsApp QR (Nợ #35); dọn còn lại (Nợ #29, #36).
   **Dùng thử Gen hướng dẫn một tuần** (3 bước ở [HANDOFF](reports/HANDOFF-v0.1.1.md) › Boss phải làm — v0.1.54), rồi nói cho Claude biết thẻ có đúng việc, chuông có phiền không; các ý để sau nằm ở mục Nợ #20–#25.
1. **Boss nghiệm thu thật** các tính năng chưa từng chạy với tài khoản thật (danh sách và cách làm ở [HANDOFF](reports/HANDOFF-v0.1.1.md) › Việc dở): Gen-hub quyền đọc + ghi Kho,
   Telegram, Truy cập từ xa (Tailscale), Facebook trả lời — từ v0.1.55 đều là tuỳ chọn (chỉ "nguồn AI" bắt buộc). Kết quả tự ghi ở Việc Sếp cần làm.
2. **Bộ câu hỏi chuẩn so model** (mục Nợ #1); riêng Jev đã có bộ 12 câu cố định (v0.1.55) — quyết ngưỡng theo kết quả chạy thật của Sếp.
3. **Kho dữ liệu**: ghi Phiên bù, Việc cho mục Nợ, cập nhật QD-12 và DA-1 (mục Nợ #7) — cần Boss dặn; ghi Kho luôn qua Xác nhận + mã PIN.
4. **Dọn nhánh** (F-70) khi Boss cho phép.
5. **Chờ Boss chọn hướng** (chưa có bản đánh số): Facebook đăng bài (lát 2); Gen ghi ra Gen-hub ngoài Kho (kanban/warroom/nháp mail/lịch — cần QD mới); Trang FB/IG qua API (F-80, đóng băng
   tới khi Facebook cá nhân chạy thật ≥ 2 tuần); TOTP sau khi truy cập từ xa ổn định.
6. **Bảo trì đều**: PR Renovate (nhắn Claude "xử lý PR phụ thuộc"), theo dõi cảnh báo quét bảo mật, kiểm sức khoẻ ở Tổng quan.

## Nợ
Việc đã hứa hoặc đã biết mà chưa làm. Mỗi dòng ghi điều kiện mở; "Boss" = cần Boss cho phép/quyết. Khi làm xong thì chuyển sang CHANGELOG và xoá dòng ở đây.

| # | Mục | Tình trạng / điều kiện |
|---|---|---|
| 1 | **Bộ 10–15 câu hỏi chuẩn so model** (chuyển từ v0.1.41) | **CHƯA chạy.** Script chạy trên 2–3 nguồn (CLI, OpenRouter, Gemini), ghi điểm + chi phí vào ghi chú phát hành; quyết giữ/bỏ Jev theo số đo. Cần khoá API và CLI đã đăng nhập |
| 2 | **F-70** xoá nhánh `claude/*` đã merge + nhánh `worktree-agent-*` local; bật "Automatically delete head branches" | **Chờ Boss cho phép.** Không thêm `paths-ignore: docs/**` cho `ci.yml` (PR chỉ sửa tài liệu sẽ kẹt vì check bắt buộc) |
| 3 | **TOTP cho Owner** (ARCHITECTURE hứa) | Chưa làm. Hiện có giới hạn đăng nhập, argon2 và mã PIN; làm sau khi truy cập từ xa ổn định |
| 4 | **Facebook đăng bài** (`post`) — lát 2; `like`/`follow` chưa làm | Selector ghi Facebook mới kiểm trên trang mẫu; cần Boss nghiệm thu thật lát 1 (dòng 8) trước |
| 5 | **gen-intel** | Ý tưởng để sau; chưa có thiết kế, chưa có mã. Làm khi Boss mô tả phạm vi |
| 6 | **Kiểm cosign/minisign** trong genh và `install.sh` | Hoãn: chỉ chống tráo tệp trên Release; hiện genh kiểm SHA-256 theo `checksums.txt`. Tệp `.sig`/`.pem` đã đính kèm nhưng chưa nơi nào kiểm |
| 7 | **Ghi PHIEN bù cho v0.1.28 → v0.1.49**; tạo VIEC cho mục Nợ; cập nhật QD-12 (hạn đã trượt) và DA-1; chốt câu định vị "Gen là mặt tiền chính, Console là nơi xem chi tiết" | Job F-87 (v0.1.50) chỉ đề xuất cho bản mới. **Boss** dặn Gen đề xuất từng bản cũ (mỗi bản một thẻ Ghi vào Kho dữ liệu + mã PIN) |
| 8 | **Trường Kho "Công cụ" / "Người làm"** chưa ghi được | Chưa biết giá trị lựa chọn của hai cột; `KHO_FIELDS` (`gh/hub_link/kho_write.py`) chỉ có trường đã biết. Mở khi Boss/Gen-hub cho danh sách giá trị |
| 9 | **F-91** lời hẹn "ghi có xác nhận (v0.1.30…)" ở v0.1.29 đã trượt | Làm thật ở **v0.1.47** (Facebook ghi lát 1); Trang FB/IG qua API vẫn chưa. Đã ghi chú ở [v0.1.29.md](releases/v0.1.29.md); bảng lát cũ trong [gen-browser-agent.md](design/gen-browser-agent.md) §5 đã sửa |
| 10 | **F-92** chú thích "CHỖ CẮM v0.1.30" trong mã | Đã gỡ số bản ở **v0.1.47**; `test_plug_comments_v0147.py` chặn chú thích kiểu cũ quay lại. Đóng, giữ để tra |
| 11 | Gen ghi ra Gen-hub **ngoài Kho** (nháp Gmail, tạo sự kiện Lịch, kanban/warroom); Gen soạn mail/tạo lịch có xác nhận | Hoãn; cần QD mới, dùng chung khung permit của v0.1.50. Hiện Gmail/Lịch/Drive/Tasks chỉ đọc |
| 12 | Watchdog ghi sự cố vào Kho | Hoãn (cùng lý do). Claude đọc sự cố qua gói chẩn đoán và `GET /boss-checks` |
| 13 | Boss nhắn lại Gen qua Telegram (2 chiều); Telegram làm kênh khách (F-28) | **Đang làm — v0.1.64** (xác thực đúng `chat_id` của Sếp, chống lệnh giả; Gen chỉ đề xuất, không nhận mã PIN qua Telegram). Telegram làm kênh khách vẫn hoãn |
| 14 | **F-80** cổng API Trang FB/IG/Zalo OA/TikTok/LinkedIn/X; nền tảng mạng xã hội mới | Đóng băng tới khi Facebook cá nhân chạy thật ≥ 2 tuần và Boss xác nhận có Trang/OA cần dùng |
| 15 | Bảo mật hoãn: F-50 Redis ACL, F-51 superuser sidecar, F-53 CA có NameConstraints | Xem lại khi mở truy cập từ xa rộng hơn |
| 16 | F-84 phần còn lại (duyệt nháp, đề xuất Deal/Vụ việc, stream), F-68 mở Gen cho vai trò khác | Hoãn; chờ có nhân viên dùng thật |
| 17 | Hạ tầng/CI | Gói apt trong Dockerfile chưa ghim phiên bản; PR Renovate chưa có lịch tự động; ô E2E Fedora thật (VM) chưa có; sinh type từ OpenAPI hoãn; `ops.action_log` hạn lưu (vướng chuỗi băm); F-38 phần còn lại |
| 18 | Nghiệm thu thật chưa làm | Tailscale/điện thoại trên máy chủ thật (v0.1.46); canary `--live` agy (v0.1.38/39); Facebook trả lời (v0.1.47) |
| 19 | **H-b** (v0.1.53): timer `gen-harness-update.timer` mất lịch khi `daemon-reload`/`enable` chạy từ bên trong service đêm | **Chưa tái hiện được** — bằng mã lẫn bằng `e2e-nightly-real` (systemd thật có linger: sau lần chạy service đêm timer vẫn enabled + active + có lần kế tiếp). H-a và H-c đã tái hiện và sửa; tự lành bao cả ca này nếu xảy ra trên máy thật. Chi tiết: [v0.1.53.md](releases/v0.1.53.md) |
| 20 | **`release_todos`** — mỗi bản phát hành khai báo "việc Sếp làm sau khi lên bản" thành dữ liệu (Gen hướng dẫn, v0.1.54) | Chưa làm. Hiện việc này chỉ nằm trong HANDOFF/`docs/releases/`; Gen chưa tự biết bản mới đòi Sếp làm gì. Thiết kế: [gen-coach.md](design/gen-coach.md) mục 18 |
| 21 | **Danh mục tính năng** có cấu trúc cho Gen (mô tả, đích, điều kiện dùng) | Chưa làm. Gen chỉ dựa vào `screens.list`, `guide.list`, `coach.status` để trả lời "có tính năng X không?" — chưa giới thiệu được tính năng ngoài 6 mẹo |
| 22 | **Gợi ý cuối câu tất định** — nút "Chỉ cho em" cuối câu trả lời do mã sinh (không do model) | Chưa làm. Cần `coach_intent` mở rộng + test chống bịa đích |
| 23 | **"Làm giúp" bước 8** (Gen điền sẵn form Tạo agent đầu tiên theo khuôn đề xuất có Xác nhận) | Chưa làm. Hiện Gen chỉ chỉ đường tới bước 8 |
| 24 | **Bộ bài cho nhân viên** — lộ trình riêng cho vai trò khác Owner | Hoãn: Gen hướng dẫn chỉ dành cho Sếp (cùng lý do Nợ #16, F-68); mở khi có nhân viên dùng thật |
| 25 | **Tắt chuông theo loại** (việc khẩn / token sắp hết hạn / bài học) | Chưa làm. Hiện "Chuông nhắc" là một công tắc chung; cần ý kiến Sếp sau một tuần dùng thử |
| 26 | **Nhãn nút theo trạng thái `opted_out_running`** (v0.1.53): sự cố/chuông `host.nightly` khi Sếp đã tắt tự cập nhật mà lịch vẫn bật vẫn dùng nút **"Xem cách bật lại"** (chung cho mọi lý do) | Chưa làm. Nội dung đích đã đúng (hai lựa chọn: tắt hẳn / giữ tự cập nhật) nhưng nhãn nút nói "bật lại"; cần nhãn riêng (vd "Xem lựa chọn") ở `gh/health.py` (`ACTIONS`) + web |
| 27 | **`genh auto-update disable` khi không có phiên systemd `--user`** (chạy qua `sudo`/`su`/ssh không có `XDG_RUNTIME_DIR`, hoặc tài khoản khác tài khoản đã bật lịch) (v0.1.53) | Chưa làm. Hiện genh hỏi lại trạng thái, báo "CHƯA tắt được" và thoát 1 (không nói dối) nhưng chưa tự dò `XDG_RUNTIME_DIR`/`loginctl` để tắt hộ; Sếp phải chạy lại đúng tài khoản trong phiên đăng nhập |
| 29 | **Dọn còn lại của v0.1.55**: ẩn giới hạn agent + hạn lưu dữ liệu vào Nâng cao (màn agents/storage); xoá hội thoại ở Lịch sử Gen chưa xoá lựa chọn model đã nhớ (`forgetChoice`, tự giới hạn 50 hội thoại) | Chưa làm, nhỏ |
| 32 | **Vì sao nguồn Antigravity CLI của Sếp mất dòng model** (máy lên v0.1.57, v0.1.58 chỉ làm hệ thống tự lành) | **Chưa rõ.** Từ v0.1.54 đến v0.1.57 không có mã nào xoá model của nguồn CLI (chỉ `system_api/routes.py` chặn xoá nguồn CLI và `seed_demo.py` dọn nguồn mẫu). Sau khi máy lên v0.1.58 đọc Action Log (`provider.model_set`, `provider.deleted`, `provider.model_auto`) và hỏi `SELECT * FROM agent.models` để loại trừ một đường xoá dữ liệu chưa biết; có nguyên văn lỗi agy thật thì đối chiếu với `(available: …)` đã giả định |
| 34 | **Tách agy ra container riêng không gắn khoá** (bước an toàn tiếp theo của "mở thẳng") | **Xong ở v0.1.63** (`agy-box`: không khoá, DB hay Redis; sàng lọc, Soạn lại / Dịch, agent ngoại giao, Gen nhân viên, thử agent chạy ở đây). Phần còn lại: #44 (egress), #45 (core vào hộp) |
| 35 | **Kiểm WhatsApp QR với máy chủ WhatsApp thật** (v0.1.59) | Chưa kiểm được: máy kiểm thử bị chặn mạng tới máy chủ WhatsApp. Điều kiện mở: Owner quét thử theo mục "Việc Boss phải làm" của v0.1.59 rồi báo kết quả (ghi vào `docs/releases/v0.1.59.md`) |
| 36 | **Mã chết trình thiết lập cũ** (v0.1.60): `Step1Welcome`, `Step2Owner`, `Step3Org`, `ComingSoonStep`, `Step12Finish` (chỉ `test/unit/legacy-wizard.tsx` còn dùng) và ba bản đăng nhập CLI ở `BossChecksPage` chưa gộp về `CliLoginPanel` | Chưa làm, nhỏ — dọn khi sửa trình thiết lập lần tới |
| 37 | **Bảng "Cần chăm" ở Quan hệ, máy tính 1024px** (v0.1.60): cột hồ sơ chiếm 4/12 nên bảng phải cuộn ngang mới thấy "Cơ hội mở" và nút "Nhờ Gen soạn tin" (ở 1440/1920 đủ chỗ; lính gác bố cục chấp nhận vì là vùng cuộn có chủ đích) | Chưa làm, nhỏ — ở 1024 đổi bảng sang danh sách xếp chồng hoặc đưa hồ sơ xuống dưới |
| 38 | **Nháp công cụ ghi (mcp_write) chưa thực thi được** (v0.1.61, Q8-1): duyệt chỉ giữ yêu cầu ("Chưa hỗ trợ thực thi tool ghi"), không gọi công cụ; nhãn "Đã duyệt — chưa thực hiện" | Chưa làm. Cần QD mới về ghi ra Gen-hub ngoài Kho (cùng Nợ #11); luật cứng: Gen chỉ đề xuất, mọi ghi qua Xác nhận + mã PIN |
| 39 | **Chữ cấm còn trong baseline `check_terms`** (v0.1.61): 51 chỗ ("khóa", "Kho tri thức", "nhập PIN", "Agent & Model" làm tên màn, tên vai tiếng Anh trong câu, "Nghe im lặng"…) ở `.github/scripts/terms.json` › `baseline` | Chưa làm, dọn dần: baseline chỉ được giảm (sửa xong thì hạ số trong `terms.json`). Gắn khi chạm tệp có chữ cấm |
| 40 | **Lỗi hiện trạng của route-crawl** (v0.1.61): 44 mục trong `terms.json` › `crawl_baseline` (khoá `cỡ\|route\|luật`) — lỗi console/4xx/5xx/chữ cấm có sẵn lúc dựng lưới; "DƯ" (baseline cao hơn thực tế) chỉ cảnh báo, `CRAWL_STRICT_STALE=1` để bắt đỏ | Chưa làm. Sửa gốc từng mục rồi hạ baseline (`CRAWL_LOWER_BASELINE=1`); khi ổn định bật `CRAWL_STRICT_STALE=1` trong CI |
| 41 | **Tên tệp còn hậu tố `v016x`** (v0.1.61): migration `0036_v016x_danh_muc`, `test_danh_muc_v016x`, `test_sua_review_dot_a_v016x`, `route-crawl-v016x.spec.ts` (đợt lên kế hoạch trước khi chốt số bản) | Không đổi: đổi tên migration đã phát hành làm lệch lịch sử alembic; test/spec đổi tên khi chạm lần tới |
| 42 | **`list_promises` con trỏ `due_at`** (v0.1.62): phân trang theo `due_at` có thể rơi dòng trùng `due_at` ở ranh giới trang (Hộp thư đã sang bộ ba `(created_at, item_type, item_id)`, Việc sang cặp `(created_at, id)`) | Chưa làm — gói sau v0.1.62; đổi sang cặp `(due_at, id)` |
| 43 | **Nút "Chạy lại tin lỗi"** (v0.1.62): tin vào hàng lỗi (DLQ) đã có Phát lại/Xoá ở Sức khoẻ, nhưng tin sàng lọc lỗi (`raw_error`) chưa có nút chạy lại thủ công và Sức khoẻ chưa đếm số tin lỗi | Chưa làm — gắn gói B6 (v0.1.64) |
| 44 | **Allowlist egress chặt cho hộp agy** (v0.1.63): gói sửa review đã dựng proxy `agy-egress` (hộp chỉ ở mạng internal, proxy chặn IP nội bộ / gateway / LAN, chống DNS rebinding) và tuỳ chọn `GH_AGY_EGRESS_ALLOW`; **mặc định vẫn cho mọi tên miền công khai**. Đã đo: agy theo `HTTPS_PROXY` (CONNECT tới `antigravity-unleash.goog`, `play.googleapis.com`), chưa đo được đường OAuth / gọi model thật. Kèm: hộp về mạng vẫn tới được `api:8000` qua `agy-bus` | Phần proxy xong; còn: bật allowlist mặc định khi có phiên đăng nhập để ghi đủ tên miền, rồi cho api chỉ nghe `agy-bus` ở cổng riêng |
| 45 | **Chuyển cả core vào hộp agy** (v0.1.62): Gen của Sếp, agent nội bộ vẫn chạy agy trong tiến trình api/worker; Gen của Sếp đọc tin người ngoài khi đọc Hộp thư (rủi ro còn lại của "agy cho lớp core"); ca canary `shell_proc1_khong_lo` vẫn là khe hở dự kiến tới khi xong | Chưa làm — khi hộp riêng ổn định một thời gian (v0.1.63 mới đưa việc có người ngoài vào hộp) |
| 46 | **Xác minh định dạng tệp token agy thật** (v0.1.63, sổ câu hỏi #18): chưa tìm thấy `antigravity-oauth-token` thật để chắc trường hạn (`expiry` / `expires_at` / `id_token.exp`); mã an toàn (không đọc được hạn ⇒ khoá độc quyền, tuần tự). Hộp nhận tệp token theo từng lượt từ api (gói sửa review v0.1.63) — chưa biết agy thật có xoay vòng refresh token không (nếu có, lượt hộp làm mới có thể làm hỏng phiên của api); cũng chưa sinh `settings.json` an toàn từ mã cho HOME tạm (tên/giá trị khoá chưa kiểm được) | Chưa làm — xác minh khi Sếp đăng nhập agy trên bản v0.1.63 (đọc `agy_state`, ghi định dạng vào `docs/api/agybox-protocol.md`) |
| 47 | **Quét danh bạ theo phần thay đổi** (v0.1.65, review P3): bridge vẫn quét ĐỦ mọi nhóm + mọi thành viên mỗi lượt (giãn 1 giây/lần hỏi, 2 giờ/lượt, lỗi thì dừng và lùi lịch). Chỉ hỏi lại nhóm đổi (Zalo `gridVerMap`, thành viên mới theo uid) cần bridge nhớ phiên bản từng nhóm và giữ đúng nghĩa «danh sách đủ» (`members_complete`/`groups_complete` quyết định ai bị coi là «đã rời») | Chưa làm — không gọn trong v0.1.65. Mở khi số nhóm đủ lớn để lượt quét đủ gây nặng/bị hãm tốc; làm trung thực (giãn cách, không né chống bot) |
| 48 | **«Phạm vi xem» của nhóm (`view_scope`) chưa được áp** (v0.1.65, review P3): máy chủ lưu và hiển thị Chỉ Sếp / Quản lý / Mọi thành viên nhưng chưa nơi nào lọc theo nó; hướng dẫn đã sửa thành «ghi chú ý Sếp», quyền xem thật theo vai trò + phạm vi gán | Chưa làm. Áp thật: nhóm `owner` ẩn khỏi vai dưới Owner ở Hộp thư/Kho/hồ sơ/tìm kiếm (cùng chỗ với quy tắc tin 1-1 `direct_visible_sql`) |
| 49 | **Quy tắc tin 1-1 chỉ Owner — phần còn lại** (v0.1.65, review P2-2): (a) tin ĐI 1-1 của người được giao cho nhân viên không hiện ở Kho thô vì người gửi là tài khoản của Sếp, nhân viên chỉ thấy tin khách gửi; (b) tín hiệu cung–cầu / cơ hội / bản nháp dẫn xuất từ tin 1-1 (`biz.market_signals`, deal) chưa lọc theo quy tắc này, chỉ đơn vị ý nghĩa, tin thô, chứng cứ, Hộp thư, hồ sơ, tìm kiếm và WebSocket đã lọc | Chưa làm. (a) ghép tin đi theo luồng hội thoại (cùng kênh + cùng người nhận); (b) cột nguồn trên bảng dẫn xuất + lọc bằng `direct_visible_sql` |

### Câu hỏi mở — mặc định đã chọn (16/10/2026; Sếp sửa nếu muốn khác)
- Tin riêng 1-1: lưu im lặng, không tự trả lời (làm cùng v0.1.65). Nhóm mới (Sếp chốt 17/10, thay «hỏi khi kết nối kênh»): MẶC ĐỊNH «Lắng nghe im lặng» (`silent`) — lưu hết tin, KHÔNG BAO GIỜ trả lời kể cả khi được tag; mọi bản cài kể cả cũ, nhóm cũ đang `off` giữ nguyên. «Nhóm mới: Lắng nghe im lặng / Hỏi Sếp / Không nghe» ở thẻ kênh (`settings.new_group_mode.<kênh>`, mặc định `silent`, đổi cần PIN); hộp hỏi + `pending` chỉ khi Sếp chọn Hỏi Sếp; thẻ kênh báo «N nhóm mới đã vào Lắng nghe im lặng» — F1d.
- Gen của nhân viên (không phải Owner): dùng Antigravity qua hộp riêng (v0.1.63). Agent không gắn kênh/nhóm/người = nội bộ ⇒ agy trong tiến trình. Hộp tắt ⇒ chuyển nguồn AI kế, không quay về agy trong tiến trình.
- Sàng lọc tin người lạ (`core.refinery`): chạy agy qua hộp riêng (v0.1.63).
- Nút "Nối lại" Zalo/WhatsApp: không đòi mã PIN; có bước hỏi lại khi phiên bị thay chỗ.
- Cầu thiếu tên hàng (A11): giữ mở cơ hội `raw_signal` để không mất khách.
- Telegram: không có nút Duyệt, không nhận mã PIN qua Telegram (chỉ liên kết mở Console).
- Giữ Jev (Q7). Push theo 4 mốc M1–M4 thay cho mỗi bản một lần push.

## Bản phản ứng (hotfix)
Các bản sửa nóng thật, không nằm trong kế hoạch đợt. Đối chiếu `git log origin/main` và nhánh `hotfix/*`:

| Ngày | Bản / PR | Chuyện gì |
|---|---|---|
| 30/09/2026 | **v0.1.30** (PR #34) | Màn /guide/8 sập "React error #31 {reasons}" khi chưa có model; lối vào Hướng dẫn thiết lập "biến mất"; thiếu nút kiểm tra bản mới; đổi tài khoản Google của agy không hoạt động. [Chi tiết](releases/v0.1.30.md) |
| 03/10/2026 | **Hotfix v0.1.41** (PR #46, nhánh `claude/hotfix-v0141`) | Release v0.1.41 đỏ 2 test prune sao lưu: bản vá neo giờ mẫu chỉ có trên nhánh cũ nên merge "giữ nguyên cây" ở v0.1.35 làm mất; khôi phục (cherry-pick) và phát hành lại v0.1.41, giữ `VERSION`. [Chi tiết](releases/v0.1.41.md) |
| 03/10/2026 | **Hotfix v0.1.42 "time-bomb"** (PR #48, `hotfix/v0142-time-bomb`) | Test thẻ cập nhật lỗi dùng mốc cố định 02/10 hết hạn 24 giờ ⇒ vitest đỏ trên main, chặn phát hành v0.1.42; đổi sang mốc giờ tương đối (F-6) |
| 04/10/2026 | **Sửa e2e-upgrade, Owner mẫu** (PR #53, `hotfix/e2e-owner-seed`) | Dữ liệu mẫu không có người dùng nên chuông `network.open_lan` luôn 0; chèn 1 Owner mẫu trước khi kiểm (F-21) |
| 09/10/2026 | **Sửa e2e-upgrade từ v0.1.46** (PR #55, `hotfix/e2e-upgrade-from-v0146`) | Ô nâng cấp giả định bản cũ luôn nghe 0.0.0.0; bản ≥ v0.1.46 cài mới nghe 127.0.0.1 nên E2E release v0.1.47 đỏ và nằm yên ở bản thử. Sửa test (không sửa genh); v0.1.47 phát hành sau đó. [Chi tiết](releases/v0.1.48.md) |
| 09/10/2026 | **Sửa trình bày dính biên khung** (PR #58, `claude/css-bien-khung`) | Ảnh chụp màn hình thật: chữ/số dính sát mép thẻ, khối "Máy chủ chưa nhận yêu cầu cập nhật" vỡ 3 dòng. Sửa gốc ở `Panel`/`Icon` + 5 họ lỗi, thêm lính gác `layout-guard.spec.ts` (4 cỡ màn); đi cùng v0.1.50. [Chi tiết](releases/v0.1.50.md) |
| 09/10/2026 | **Sửa test heartbeat genh chập chờn** (PR #59) | `readStateFile` báo "tệp bị thay giữa chừng" khi nhịp vừa ghi tạm-rồi-rename (CI đỏ ~1/100); nay chỉ lỗi đó được thử lại tối đa 5 lần × 5ms, symlink/hard link/sai chủ vẫn từ chối ngay. Không tăng VERSION, đi cùng v0.1.50. [Chi tiết](releases/v0.1.50.md) |
| 10/10/2026 | **Bản phản ứng v0.1.51** (`claude/hotfix-prune-digest`) | Cổng phát hành v0.1.50 đỏ ở bước "chỉ còn ảnh của bản hiện tại và bản liền trước": `pruneOldImages` giữ theo IMAGE ID nên digest cũ của ảnh trùng nội dung (`gen-harness-db`, 3 digest cùng ID) không bao giờ bị gỡ. Sửa theo tham chiếu; thay v0.1.50 chưa promote. [Chi tiết](releases/v0.1.51.md) |
| 10/10/2026 | **Bản phản ứng 2 — v0.1.52** (`claude/hotfix-prune-digest-2`) | Cổng phát hành v0.1.51 vẫn đỏ ở bước giữ 2 bản ảnh: genh đã gọi `rmi …@digest` nhưng Docker từ chối (`isSingleReference`: mọi digest cùng repo là MỘT tham chiếu, container db đang chạy). Nay `rmi -f` cho digest mà ảnh còn được tham chiếu giữ; thay v0.1.51 chưa promote. [Chi tiết](releases/v0.1.52.md) |
| 10/10/2026 | **Bản phản ứng v0.1.53** (`claude/v0153`) | Một bản cài kẹt v0.1.44 từ 03/10 đến 09/10: lịch tự cập nhật đêm bị tắt mà `genh auto-update status` đọc sai và không ai biết, nút Cập nhật ngay trên Console chỉ nói "chưa nhận yêu cầu". Lịch đêm nay tự lành (trừ khi Sếp đã chủ động tắt), `status` nói thật, kiểm linger, chọn bản đủ 24 giờ từ danh sách, `ConsumeRequest` không nuốt lỗi xoá (GH-E94C), bản cài phụ không gỡ lịch của bản chính; Console nói rõ nguyên nhân; E2E chạy thật timer. [Chi tiết](releases/v0.1.53.md) |
| 16/10/2026 | **Bản vá v0.1.59** (`claude/hotfix-v0159`) | Owner báo (v0.1.58) "WhatsApp quét QR chưa được": mã WhatsApp vẽ 88px quá nhỏ; bridge chưa xử lý `companion_reg_refresh`; socket lỗi trước khi ra mã mở lại vô hạn; thẻ Hôm nay đọc cache 60 giây sau Kiểm tra. [Chi tiết](releases/v0.1.59.md) |

Hai bản **phản ứng theo yêu cầu của Boss** (tính năng, không phải sửa nóng): v0.1.31 (01/10 "không thấy model và nhóm model nào để chọn") và v0.1.32 (01/10 "high là mức suy nghĩ, không phải tên model").

## Đợt A — Gen v1 (thiết kế: docs/design/gen-v1.md)
- ✅ A1 Khung chat phải + Gen trả lời/tóm tắt (chỉ đọc), lưu hội thoại, Nhật ký hành động — v0.1.21.
- ✅ A2 Giao thức hành động UI: mở trang, khoanh sáng (`data-gen-target`), dẫn từng bước — v0.1.21.
- ✅ A3 Nguồn model Jev (OpenRouter) + Gen dùng Jev cho quyết định nhanh, rơi về LLM khi lỗi — v0.1.21
  (schema `/v1/systemone` còn là giả định, xem [v0.1.21.md](releases/v0.1.21.md)).
- ✅ A4 Gen v2 bước 1 — đề xuất thao tác có xác nhận (nháp tin → nhắc việc → gán người; Xác nhận/Sửa/Huỷ, PIN khi nhạy cảm,
  Action Log via=gen; nhắc việc đến giờ → chuông) — v0.1.24. Mở rộng: `social_reply`/`social_dm` (v0.1.47), `memory_note`/`kho_create`/`kho_update` (v0.1.50).
- ✅ A5 Gen hướng dẫn — thẻ "Hôm nay của Sếp" (việc cần làm ngay, mẹo, bài học k/19), Lộ trình học cùng Gen, chuông `gen.coach`, dòng Bản tin x/N, tool `coach.status` — v0.1.54
  (thiết kế: [gen-coach.md](design/gen-coach.md); không gọi model, chỉ Owner, khuyên không ép).
- ✅ A6 Gen chọn model trong khung chat (Tự động/Nhanh/Kỹ hơn + mức suy nghĩ) + định tuyến theo ý định (câu ngoài phạm vi không gọi model) + Mặt tiền Owner "Hỏi Gen" — v0.1.55.

## Đợt B — Cơ bản còn thiếu
- ✅ B1 quản lý người dùng (mời, đổi vai trò, khoá/mở khoá, đặt lại mật khẩu) — v0.1.22.
- ✅ B2 sửa thông tin công ty (Điều khiển hệ thống › Tổ chức) — v0.1.22.
- ✅ B3 Trợ giúp/Giới thiệu/phiên bản (`/help`, Báo lỗi) — v0.1.22.
- ✅ B4 giao diện điện thoại (ngăn kéo danh mục, Gen phủ toàn màn, 375px không cuộn ngang) — v0.1.23.
- ✅ B5 trang lỗi (có mã lỗi) + trang 404 — v0.1.23.
- ✅ B6 chuông thông báo (`/notifications`, cập nhật trực tiếp qua WebSocket) — v0.1.23.
- ✅ B7 sáng/tối (mặc định theo hệ thống, nhớ theo từng người dùng) — v0.1.23.

## Đợt C — Hạ tầng dữ liệu
- ✅ C1 Sàng lọc dùng Jev làm lớp lọc đầu (rác, trùng, chấm điểm 0–100) + đo chi phí (độ trễ, số lượt Jev) và độ khớp với
  quy tắc; Hộp thư có huy hiệu + "Ẩn rác & trùng", thẻ cấu hình Owner — v0.1.25. (Còn: đo độ chính xác có nhãn người.)
  v0.1.27: số liệu theo phạm vi `queue.read`; trần 3000 mục so trùng đã rà (trùng y hệt không bị trần bỏ sót).

## Đợt D — Phòng làm việc chung (Gen-hub) và mạng xã hội
- 🟡 D1 Gen nối Kho/Gen-hub — thiết kế: [gen-hub-link.md](design/gen-hub-link.md). ✅ v0.1.26 Gen đọc Kho (Owner, chỉ đọc, che dữ liệu, đệm 5 phút, nhắc token trước 14 ngày);
  ✅ v0.1.27 gia cố (ghim DNS, lỗi chỉ Owner, route MCP chung chỉ Owner); ✅ v0.1.49 đọc lịch/mail/việc/Drive Google (chỉ đọc, ngắt mạch F-83) + 3 mục Bản tin;
  ✅ **v0.1.50 ghi Kho (Phiên, Việc) qua đề xuất + mã PIN + permit (QD-18)** và Gen nhớ.
  Còn: ghi kanban/warroom/Gmail/Lịch (Nợ #11, cần QD mới); phương án B (agent ngoài đọc số liệu Gen-Harness) — cắt khỏi lộ trình gần (F-82).
- ~~D2 Jules worker~~ — **Bỏ** (Boss chốt QD-10, xác nhận lại 30/09). Không làm, không kiểm điều khoản Jules nữa.
- 🟡 D3 Gen điều khiển mạng xã hội thay Boss — thiết kế: [gen-browser-agent.md](design/gen-browser-agent.md). ✅ v0.1.29 Facebook cá nhân, đăng nhập + CHỈ ĐỌC (thông báo, hội thoại).
  ✅ **v0.1.47** ghi lát 1 (F-79): Trả lời bình luận + Nhắn tin có xác nhận (đề xuất Gen + PIN + permit + ảnh chụp bằng chứng);
  F-85 sandbox bật bằng user namespace + seccomp riêng, tự lùi + trang đồng ý rủi ro khi máy chủ không cho (xem `GET /social/write-gate`);
  F-83 kiểm phiên 09:10 + chuông + Telegram. Tiếp: **đăng bài = lát 2** (Nợ #4). Luật cứng giữ nguyên: không tài khoản giả, không lách chống bot (không stealth/proxy/giải CAPTCHA).
