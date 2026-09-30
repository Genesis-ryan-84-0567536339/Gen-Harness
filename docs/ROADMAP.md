# Gen-Harness — Lộ trình tổng thể (cập nhật 30/09/2026)

Nguồn chuẩn tiến độ. Mỗi đợt = 1 PR = 1 bản phát hành, CI + E2E cài thật xanh mới phát hành.

## Vai trò
| Vai | Ai | Việc |
|---|---|---|
| Owner | Sếp (Ryan) | định hướng, duyệt, brainstorm |
| Dev | Claude Code (+ sub agent Haiku/Sonnet/Opus) | code, review, phát hành |
| ~~Dev phụ~~ | ~~Google Jules~~ — **Boss bỏ (QD-10, xác nhận 30/09)** | việc code cho repo khác đi theo agy đa repo (gen-workplace) |
| Quản trị trong app | Gen | vận hành dữ liệu, dẫn Sếp dùng app |
| Vòng ngoài | agent Zalo/WhatsApp (+ Playwright sau) | thu thập thị trường |

## Đã xong
v0.1.15–0.1.20: thiết lập "Để sau" + hướng dẫn từng bước, nút Cập nhật ngay, reset mật khẩu / tin cậy CA, phiên 7 ngày,
Tài khoản của tôi + bắt buộc đổi mật khẩu tạm, sao lưu & khôi phục trên giao diện.
v0.1.21: Gen v1 (A1–A3) — khung chat, dẫn đường trên UI, nguồn Jev; cờ `gen.enabled` (bật cho Owner).
v0.1.22: Đợt B1–B3 — quản lý người dùng, sửa thông tin công ty, trang Trợ giúp.
v0.1.23: Đợt B4–B7 — giao diện điện thoại, trang lỗi/404, chuông thông báo, sáng/tối.
v0.1.24: Đợt A4 — Gen v2 bước 1: đề xuất thao tác có xác nhận (nháp tin, nhắc việc, gán người).
v0.1.25: Đợt C1 — lọc đầu Hộp thư (trùng, rác, điểm) dùng Jev khi có, quy tắc khi không.
v0.1.26: Đợt D1 (lát đầu) — Gen đọc Kho Ryan qua Gen-hub (chỉ đọc, chỉ Owner, che dữ liệu trước khi gửi model).
v0.1.27: gia cố & phủ test — ghim DNS cho Gen-hub, lỗi Gen-hub chỉ Owner thấy, route MCP chung không lộ Kho, số liệu lọc đầu
theo phạm vi, rà trần so trùng, hạn lưu chuông 30/90 ngày, nhắc việc chịu lỗi từng dòng; e2e thẻ đề xuất/lọc đầu/Gen-hub/chuông.
v0.1.28: sửa theo rà soát UX — bước 4 phải có model (tự chọn model đã gọi thử, gán cho agent lõi), bước 12 nói thật việc còn
thiếu, nguồn lỗi xuống cuối + xoá được + một nhãn trạng thái, lỗi kỹ thuật thành câu dễ hiểu, "Để sau" dùng quy tắc/sao lưu
mặc định, tắt phụ đề tiếng Anh + bỏ chữ lập trình viên, ma trận quyền tiếng Việt, bớt ngõ cụt cho vai trò khác Owner, điện thoại
(bảng → thẻ). Còn lại: ghi chú phát hành tiếng Việt, số đếm Hộp thư, một số mục Nhẹ.
v0.1.29: Boss 30/09 "có công cụ, dùng hay không do Owner quyết, cảnh báo rủi ro rõ" — V2 bước 4 "Để sau" được (hộp cảnh báo,
dải "Chưa có model" ở bước 12 + Tổng quan, chọn model lại ở /guide/4); **D3 lát đầu**: dịch vụ `browser` (Playwright,
không DB, không khoá master) + `browser-egress` (chỉ tên miền Facebook), màn Tài khoản mạng xã hội (chỉ Owner, chấp nhận
rủi ro từng tài khoản, Owner tự đăng nhập trong cửa sổ trình duyệt từ xa, phiên mã hoá, gỡ = xoá phiên), Gen CHỈ ĐỌC thông
báo + danh sách hội thoại Facebook cá nhân và tóm tắt, lịch đọc (tắt mặc định), Dừng tất cả, giới hạn tốc độ.

## Đợt A — Gen v1 (thiết kế: docs/design/gen-v1.md)
- ✅ A1 Khung chat phải + Gen trả lời/tóm tắt (chỉ đọc), lưu hội thoại, Nhật ký hành động — v0.1.21.
- ✅ A2 Giao thức hành động UI: mở trang, khoanh sáng (`data-gen-target`), dẫn từng bước — v0.1.21.
- ✅ A3 Nguồn model Jev (OpenRouter) + Gen dùng Jev cho quyết định nhanh, rơi về LLM khi lỗi — v0.1.21
  (schema `/v1/systemone` còn là giả định, xem HANDOFF v0.1.21).
- ✅ A4 Gen v2 bước 1 — đề xuất thao tác có xác nhận (nháp tin → nhắc việc → gán người; Xác nhận/Sửa/Huỷ, PIN khi nhạy cảm,
  Action Log via=gen; nhắc việc đến giờ → chuông) — v0.1.24.

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

## Đợt D — Phòng làm việc chung (repo Gen-hub, cần mở quyền repo cho phiên này)
- 🟡 D1 Gen nối Kho/warroom/kanban của Gen-hub — **một phần** v0.1.26: Gen đọc Kho (Owner, chỉ đọc, che dữ liệu, đệm 5 phút,
  nhắc token trước 14 ngày; thẻ Gen-hub ở MCP Hub); v0.1.27 gia cố (ghim DNS, lỗi chỉ Owner, route MCP chung chỉ Owner).
  Còn: đề xuất ghi kanban/warroom (bản sau), phương án B.
- ~~D2 Jules worker~~ — **Bỏ** (Boss chốt QD-10, xác nhận lại 30/09). Không làm, không kiểm điều khoản Jules nữa.
- 🟡 D3 Gen điều khiển mạng xã hội thay Boss (API trước, Playwright cho tài khoản cá nhân) — thiết kế:
  docs/design/gen-browser-agent.md. ✅ Lát đầu **v0.1.29**: Facebook cá nhân, đăng nhập + CHỈ ĐỌC (thông báo, hội thoại).
  Tiếp: v0.1.30 ghi có xác nhận (đề xuất Gen + PIN + permit — chỗ cắm `gh/social/permit.py`); Trang FB/IG chuyên nghiệp
  qua API; nền tảng khác. Luật cứng giữ nguyên: không tài khoản giả, không lách chống bot (không stealth/proxy/giải CAPTCHA).
Thiết kế: docs/design/gen-hub-link.md (lát đầu v0.1.26 ✅ — Gen đọc Kho qua Gen-hub, chỉ-đọc).
