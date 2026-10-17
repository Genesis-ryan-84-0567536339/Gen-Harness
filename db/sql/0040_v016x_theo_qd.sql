-- Gen-Harness · v0.1.69: (C4) chuông có vòng đời + (D3) dữ liệu/mặc định đúng quyết định của Sếp (QD-20, QD-22, QD-18).
-- Mọi câu lệnh chạy lại an toàn (IF NOT EXISTS / UPDATE có điều kiện khớp giá trị cũ); không xoá dòng, không đổi quyền.

-- a) (C4, F098) core.notifications.resolved_at — chuông của sự cố đã đóng được gắn "Đã xử lý" (cùng read_at).
--    Cột NULL, không cần backfill; gh_app đã có quyền cả bảng.
ALTER TABLE core.notifications ADD COLUMN IF NOT EXISTS resolved_at timestamptz;
