# Gen-Harness — ghi chú cho Claude

## Cách làm việc (Kho Ryan QD-2, QD-3, QD-4, QD-14)
- Việc nặng ngữ cảnh (đọc log CI, dò nhiều file, review diff lớn, chạy test/e2e, chụp màn hình) → giao sub agent
  (công cụ Agent); ngữ cảnh chính chỉ giữ quyết định, kết luận, báo cáo Boss. Việc 1–2 thao tác thì làm thẳng.
- Phân vai model: Sonnet thi công (dò/sửa code, chạy test) · Opus thiết kế + review trước merge · Haiku đọc log,
  kiểm trạng thái PR/release · Fable chỉ khi Opus đã bí.
- Dự phóng trước khi thi công (QD-14): việc cỡ một bản thì lập kế hoạch + chia gói việc KHÔNG chồng file (mỗi gói ghi rõ
  file được sửa, hợp đồng API giữa các gói) rồi mới giao thi công song song, mỗi gói một worktree/nhánh `claude/wip/<bản>/<gói>`.
- Trả lời Boss (QD-4): tiếng Việt có dấu, THẬT NGẮN, đi thẳng vào việc Boss cần làm (hoặc "không cần làm gì");
  không giải thích lòng vòng, không kể lý do kỹ thuật trừ khi Boss hỏi; "💡 Học nhanh" tối đa 1–2 dòng.

## Quy trình repo
- Nhánh làm việc → PR vào main; CI xanh thì tự merge squash (Boss đã cho phép). Sau đó NỐI lịch sử main vào nhánh bằng merge,
  KHÔNG reset/force-push. Khuôn (xem `git log --merges -3 origin/claude/v0149`):
  `git merge -s ours origin/main -m "merge: nối main (<sha> = PR #N vX.Y.Z squash, cây trùng hệt điểm tách <sha> ⇒ -s ours, cây mã không đổi)"`.
  Chỉ dùng `-s ours` khi cây main trùng hệt cây nhánh tại điểm gửi PR (`git diff <điểm-tách> origin/main` rỗng); main có thêm
  bản vá nóng thì merge thường và giải xung đột (bài học v0.1.41: `-s ours` làm mất bản vá chỉ có ở nhánh cũ).
- Không mở PR khi chưa có workflow kiểm tương ứng (CI phải kiểm đúng thứ PR đổi). PR chỉ sửa tài liệu vẫn phải merge được:
  không thêm `paths-ignore` cho `ci.yml`.
- Cổng phát hành: tăng `VERSION` ⇒ `release.yml`: CI → Release bản thử (prerelease) → E2E cài thật → bản chính thức (latest)
  → lịch đêm đợi thêm 24 giờ (thời gian chín). Báo Boss "đã phát hành" chỉ sau khi `releases/latest` đúng tag mới VÀ genh tải về
  khớp checksum/version. Promote tay (`skip_e2e`) chỉ khi E2E lỗi ngoài mã; E2E đỏ vì lỗi mã ⇒ sửa rồi tăng `VERSION`.
- Ghi mỗi bản: `CHANGELOG.md` (3–5 dòng, mới nhất trên cùng) + `docs/releases/vX.Y.Z.md` (chi tiết, có mục "Boss phải làm").
  `docs/reports/HANDOFF-v0.1.1.md` CHỈ giữ hiện trạng + việc dở, ≤ 200 dòng. Tiến độ + mục Nợ: `docs/ROADMAP.md`.
  Trước khi commit tài liệu: `python3 .github/scripts/check_doc_links.py` (link chết) và `python3 -m unittest discover -s .github/scripts`.
- Sửa CLAUDE.md cần Boss duyệt (bản 09/10/2026 đã duyệt — QD-18).

## Luật cứng
- Gen chỉ ĐỀ XUẤT. Không ghi Kho/Gen-hub khi chưa có Xác nhận + mã PIN của Sếp (QD-18: chỉ Kho — Phiên, Việc; kanban, warroom,
  mail, lịch vẫn không ghi). Trong test chỉ dùng MCP giả.
- Token/khoá/bí mật không vào log, Action Log, kết quả, thân lỗi hay repo. Không tạo tài khoản giả, không né chống bot.
- Không skip/quarantine test để xanh. Mọi thay đổi hành vi có test; migration chạy lại an toàn.
- Lỗi hiển thị cho người dùng = chuỗi thân thiện + "Chi tiết kỹ thuật"; không bao giờ render object vào JSX.
- Tiếng Việt có dấu trong UI, tài liệu, thông báo lỗi. Thuật ngữ: Sếp, Gen nhớ, Ghi nhớ, Ghi vào Kho Ryan, Kho Ryan, Gen-hub,
  mã PIN, Việc Sếp cần làm.
