# Gen-Harness — Lộ trình tổng thể (cập nhật 29/09/2026)

Nguồn chuẩn tiến độ. Mỗi đợt = 1 PR = 1 bản phát hành, CI + E2E cài thật xanh mới phát hành.

## Vai trò
| Vai | Ai | Việc |
|---|---|---|
| Owner | Sếp (Ryan) | định hướng, duyệt, brainstorm |
| Dev | Claude Code (+ sub agent Haiku/Sonnet/Opus) | code, review, phát hành |
| Dev phụ (dự kiến) | Google Jules (worker trong gen-workplace/Gen-hub) | việc code nhỏ, tự mở PR — Claude review trước merge |
| Quản trị trong app | Gen | vận hành dữ liệu, dẫn Sếp dùng app |
| Vòng ngoài | agent Zalo/WhatsApp (+ Playwright sau) | thu thập thị trường |

## Đã xong
v0.1.15–0.1.20: thiết lập "Để sau" + hướng dẫn từng bước, nút Cập nhật ngay, reset mật khẩu / tin cậy CA, phiên 7 ngày,
Tài khoản của tôi + bắt buộc đổi mật khẩu tạm, sao lưu & khôi phục trên giao diện.
v0.1.21: Gen v1 (A1–A3) — khung chat, dẫn đường trên UI, nguồn Jev; cờ `gen.enabled` (bật cho Owner).

## Đợt A — Gen v1 (thiết kế: docs/design/gen-v1.md)
- ✅ A1 Khung chat phải + Gen trả lời/tóm tắt (chỉ đọc), lưu hội thoại, Nhật ký hành động — v0.1.21.
- ✅ A2 Giao thức hành động UI: mở trang, khoanh sáng (`data-gen-target`), dẫn từng bước — v0.1.21.
- ✅ A3 Nguồn model Jev (OpenRouter) + Gen dùng Jev cho quyết định nhanh, rơi về LLM khi lỗi — v0.1.21
  (schema `/v1/systemone` còn là giả định, xem HANDOFF v0.1.21).
- A4 Đề xuất thao tác; v2: điền form có xác nhận (nháp tin, nhắc việc, gán người).

## Đợt B — Cơ bản còn thiếu
B1 quản lý người dùng · B2 sửa thông tin công ty · B3 Trợ giúp/Giới thiệu/phiên bản · B4 giao diện điện thoại ·
B5 trang lỗi · B6 chuông thông báo · B7 sáng/tối.

## Đợt C — Hạ tầng dữ liệu
C1 Sàng lọc dùng Jev làm lớp lọc đầu (rác, trùng, chấm điểm) + đo chi phí/độ chính xác.

## Đợt D — Phòng làm việc chung (repo Gen-hub, cần mở quyền repo cho phiên này)
D1 Gen nối Kho/warroom/kanban của Gen-hub. D2 Jules worker trong gen-workplace (mỗi tài khoản có hạn mức riêng;
kiểm điều khoản dùng nhiều tài khoản trước khi chạy song song 5 tài khoản). D3 Playwright cho agent vòng ngoài.
