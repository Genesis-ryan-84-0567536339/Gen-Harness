# Trí nhớ làm việc của phiên đám mây (đến 16/10/2026) — nạp TRƯỚC khi làm bất cứ việc gì

Tệp này là "trí nhớ" của phiên Claude Code trên đám mây đã lái Gen-Harness từ v0.1.32 tới v0.1.61. Bản ghi hội thoại gốc nằm trên máy đám mây,
không chuyển được, nên mọi điều phiên đó biết và làm theo đều chép ở đây. Đọc theo thứ tự: tệp này → `CLAUDE.md` → `docs/handoff/TIEP-QUAN-16-10.md`
→ `docs/reports/HANDOFF-v0.1.1.md` → `docs/ROADMAP.md`. Sau khi đọc, tóm tắt lại cho Sếp 5 dòng những gì đã nạp để Sếp biết bạn nhớ đúng.

## 1. Kỹ năng phải dùng (Sếp chốt 16/10)

Kỹ năng chính hãng Anthropic, dùng ĐÚNG lúc, không bỏ qua:

| Khi nào | Dùng gì |
|---|---|
| Làm/sửa giao diện | `.claude/skills/frontend-design/SKILL.md` (đọc trước khi viết dòng UI đầu tiên) |
| Kiểm trên app chạy thật (bấm thử, lỗi console, ảnh 390/1440) | `.claude/skills/webapp-testing/SKILL.md` hoặc `/run` |
| Trước MỌI lần merge | `/code-review` |
| Chạm mã PIN, khoá, quyền, bí mật, che dữ liệu, agy | `/security-review` thêm vào |
| Diff lớn | `/simplify` |

Kiểm `.claude/skills/README.md` để biết nguồn gốc/giấy phép. Giao diện xong phải gửi Sếp ảnh thật 390px và 1440px TRƯỚC khi báo "xong".

## 2. Cách Sếp muốn được trả lời

- Tiếng Việt có dấu, THẬT NGẮN (Sếp đã phàn nàn "nói ngắn gọn coi"). Kết quả trước; tách đã làm / đang chạy / bị chặn. Không dán log, không kể lý do kỹ thuật trừ khi hỏi.
- Cuối mỗi trả lời: **📌 Tóm tắt gọn** (🔴 Boss làm ngay · ⏳ Đang chờ · 📋 Còn nợ) rồi **💡 Học nhanh** tối đa 1–2 dòng.
- Sếp không rành code, không ngồi canh được ("tôi đâu thể ngồi đợi bạn hoài") ⇒ tự làm đến xong, chỉ gọi Sếp khi thật sự cần (đăng nhập thật, quyết định sản phẩm, việc không đảo ngược).
- Không đẩy việc tay cho Sếp nếu tự làm được. Sếp hỏi "tiến độ bao nhiêu %" ⇒ trả số cụ thể (lỗi đã sửa / tổng, P1 đã sửa / tổng P1).
- Sếp quan tâm chi phí: giới hạn 4–5 agent song song, việc rẻ giao Haiku, gom việc nhỏ, mỗi ngày tối đa 1 bản phát hành (trừ vá nóng).
- Sếp lo "càng sửa càng lỗi" ⇒ mỗi bản phải có: test đỏ→xanh cho từng lỗi, bộ kiểm đầy đủ một lần, review độc lập, kiểm hồi quy trên app thật.

## 3. Luật cứng (vi phạm = hỏng niềm tin)

- Không tạo tài khoản giả, không né chống bot (WhatsApp: UA trung thực `Gen-Harness-bridge/<ver>`, KHÔNG giả Chrome — đã từng là lỗi chặn review).
- Bí mật/token/khoá/OTP/mã thiết lập KHÔNG vào log, kết quả, thân lỗi, commit, repo.
- KHÔNG ghi địa chỉ Gen-hub, tên Kho riêng, email hay danh tính riêng của Sếp vào bất cứ thứ gì giao đi (repo, tài liệu, mã). Chạy `python3 .github/scripts/check_no_personal_info.py` trước khi commit tài liệu.
- Gen chỉ ĐỀ XUẤT; ghi Kho chỉ khi có Xác nhận + mã PIN. Từ 16/10 tạm ngưng Gen-hub/Brain trong thi công: không đọc/ghi Kho.
- Không skip/xfail/quarantine test để xanh; test khẳng định hành vi cũ sai thì VIẾT LẠI cho đúng hành vi mới, ghi lý do.
- Không force-push nhánh dùng chung, không reset/rewrite lịch sử; nối main về nhánh bằng merge (khuôn `-s ours` trong `CLAUDE.md`, chỉ khi cây trùng hệt).
- Không ghi tên model AI trong commit/PR/mã. Commit tiếng Việt.
- Lỗi hiển thị = câu thân thiện + "Chi tiết kỹ thuật"; không render object vào JSX; UI tiếng Việt có dấu, thuật ngữ trong `CLAUDE.md`.
- Không đụng bản cài Gen-Harness thật (`~/.gen-harness`) và Gen-hub đang chạy trên máy: chỉ đọc; update/restart/stop phải hỏi Sếp.

## 4. Quy trình mỗi bản (đã chạy ổn từ v0.1.53 tới v0.1.61)

1. Dự phóng (QD-14): chia gói KHÔNG chồng tệp, mỗi gói một nhánh `claude/wip/<bản>/<gói>`; ghi rõ tệp được sửa + hợp đồng API giữa gói.
2. Thi công (Sonnet), mỗi lỗi có test đỏ trước/xanh sau; chạy kiểm phần chạm.
3. Tích hợp vào `claude/v0XYZ` bằng merge thường → bộ kiểm như `ci.yml` ĐẦY ĐỦ một lần (api ruff, mypy, pytest hai lượt thường + `GH_TEST_APP_ROLE=1`;
   web lint, typecheck, vitest, build, Playwright mock + route-crawl; `.github/scripts`).
4. Review Opus (tính đúng + an toàn) ⇒ sửa ⇒ `/security-review` nếu chạm vùng nhạy cảm ⇒ kiểm hồi quy app thật.
5. Tài liệu bản: `VERSION`, `CHANGELOG.md` (3–5 dòng, mới trên cùng), `docs/releases/vX.Y.Z.md` (có "Boss phải làm"), ROADMAP (+Nợ), HANDOFF (≤ 200 dòng),
   mốc trong `.github/scripts/test_check_doc_links.py`; chạy `check_doc_links.py`, `unittest discover -s .github/scripts`, `check_doc_facts.py` (từ A12).
6. PR → main (thân PR tiếng Việt). CI xanh ⇒ merge squash với sha head 40 ký tự. Sau merge nối main về nhánh.
7. Phát hành: `release.yml` (prerelease) → `e2e-install.yml` (E2E cài thật + promote, chạy riêng qua workflow_run) → kiểm `releases/latest` đúng tag,
   có dấu `genh:promoted_at`, tải `genh-linux-amd64` + `checksums.txt` khớp sha256, `genh version` đúng. CHỈ khi đó báo Sếp "đã phát hành" + nhắc `genh update`.
8. Lượt CI bị huỷ do push mới hiện `ci-ok` đỏ trên sha cũ — không phải lỗi, xem lượt của sha mới.

## 5. Quyết định của Sếp còn hiệu lực

- 16/10: **Antigravity CLI (agy) là nguồn AI chủ đạo, MỞ THẲNG cho mọi agent/vai, kể cả việc nền** ("cả hệ thống này chạy chủ đạo bằng agy cli").
  Sếp đã được báo rủi ro (agy cùng container với khoá). Hộp riêng/tách container là Nợ ưu tiên làm sau. Đừng bao giờ tự thu hẹp agy lại — Sếp từng rất bực vì việc này.
  Claude Code CLI ở việc nền vẫn theo luật riêng (Owner tự bật, điều khoản gói Claude).
- 16/10: 9 câu hỏi kiểm kê — Q1 mở thẳng (hộp riêng sau) · Q2-1 cho Gen đọc dữ liệu đã che khi chỉ có agy · Q3-1 người được giao quyền duyệt tự đặt PIN ·
  Q4-2 bỏ lời hứa "thấy team", Quản lý thấy việc được giao · **Q5-2 thu thành viên MỌI nhóm kể cả nhóm "Không nghe"** (vì bridge đã nhận dữ liệu qua websocket) ·
  Q6-1 đổi tên chế độ "Chỉ khi được tag" cho đúng (nghe hết, chỉ trả lời khi tag) · Q7-1 giữ Jev · Q8-1 mcp_write chặn và nói "chưa hỗ trợ" · Q9-2.
- 16/10: tạm ngưng Gen-hub/Brain trong thi công; dùng kỹ năng chính hãng Anthropic.
- 16/10: làm ở máy cục bộ trước, chắc chắn ổn mới đẩy GitHub; Claude cục bộ là người lái duy nhất.
- Sếp cho phép tự merge squash khi CI xanh và tự phát hành theo cổng.

## 6. Bối cảnh kỹ thuật cần nhớ

- Stack: FastAPI (`apps/api/gh`), worker arq, Postgres 16 (pgvector, pg_partman, RLS, vai `gh_app`), Redis, React/Vite (`apps/web`), bridge Node
  (`apps/bridge`, Baileys GHIM 7.0.0-rc14, zca-js), genh Go, compose `deploy/compose.yaml` 11 dịch vụ.
- Test api cần Postgres + Redis riêng (biến `GH_TEST_TEMPLATE`, `GH_TEST_REDIS`, `GH_TEST_BROWSER_REDIS`, `GH_TEST_APP_ROLE=1` cho lượt vai app).
- WhatsApp v0.1.59: QR lớn, xử lý `companion_reg_refresh`, thử lại giãn cách, mã `PAIRING_REJECTED` — CHƯA kiểm với máy chủ WhatsApp thật (Nợ #35) ⇒ làm trên máy cục bộ.
- Thẻ Coach/"Hôm nay của Sếp": cache có `invalidate` + `commit_and_invalidate` (đếm phiên bản, ghi có điều kiện) — giữ khi sửa `_heal_agy`.
- Race đã gặp: thông báo WebSocket tới trước khi socket mở ⇒ invalidate khi socket mở (v0.1.60).
- Kiểm kê 16/10 tìm 131 lỗi; đã sửa 18 (9/19 P1) ở v0.1.61; v0.1.62 đang gộp thêm 14 + agy + B4/B5.

## 7. Bài học (đừng lặp lại)

- Sửa "luật an toàn cũ" mà không hỏi Sếp ⇒ Sếp coi là phá cốt lõi. Thay đổi hành vi lõi (nguồn AI, quyền, kênh) phải theo quyết định Sếp đã ghi ở mục 5.
- Nhiều agent trên một máy: không `pkill -f` mẫu rộng; mỗi agent cổng Redis + template DB riêng; không chạy nhiều bộ pytest đầy đủ cùng lúc (quá tải ⇒ timeout giả).
- Đĩa đầy khi nhiều worktree + node_modules ⇒ dùng `cp -al` hoặc node_modules chung; xoá worktree đã push.
- Release xanh ≠ đã promote. Báo phát hành chỉ sau khi kiểm checksum + `genh version`.
- `-s ours` khi main có bản vá nóng chỉ ở nhánh khác sẽ làm mất bản vá (v0.1.41).
- Rà bảo mật trước phát hành từng bắt được lỗ thật (v0.1.61: đích nháp nhận `identity_id` của người khác) — không bỏ bước này.
