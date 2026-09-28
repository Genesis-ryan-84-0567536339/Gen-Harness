# Gen-Harness — ghi chú cho Claude

## Cách làm việc (Kho Ryan QD-2, QD-3, QD-4)
- Việc nặng ngữ cảnh (đọc log CI, dò nhiều file, review diff lớn, chạy test/e2e, chụp màn hình) → giao sub agent
  (công cụ Agent); ngữ cảnh chính chỉ giữ quyết định, kết luận, báo cáo Boss. Việc 1–2 thao tác thì làm thẳng.
- Chọn model sub agent: Haiku (đọc log, kiểm trạng thái PR/release) · Sonnet 5 mặc định (dò/sửa code, chạy test)
  · Opus 5.5 (review trước merge, thiết kế, lỗi khó) · Fable (chỉ khi Opus đã bí).
- Trả lời Boss (QD-4): tiếng Việt có dấu, THẬT NGẮN, đi thẳng vào việc Boss cần làm (hoặc "không cần làm gì");
  không giải thích lòng vòng, không kể lý do kỹ thuật trừ khi Boss hỏi; "💡 Học nhanh" tối đa 1–2 dòng.

## Quy trình repo
- Nhánh làm việc → PR vào main; CI xanh thì tự merge squash (Boss đã cho phép), sau đó reset nhánh về origin/main.
- Tăng `VERSION` là tự phát hành (release.yml) + E2E cài thật; kiểm genh tải về (checksum/version) rồi mới báo Boss.
- Ghi thay đổi mỗi bản vào `docs/reports/HANDOFF-v0.1.1.md`.
