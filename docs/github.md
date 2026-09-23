repo: Genesis-ryan-84-0567536339/heo-harness
branch: main
path: heo_harness/plugins/ui_dashboard

## Last sync

date: 2026-09-21T03:41:00Z

### Updated in this project

- Dựng lại Console theo spec LOCKED v2.2: sản phẩm là **Gen-Harness (Genesis Harness OS)**, tên Heo-Harness đã deprecated.
- Kiến trúc thông tin theo mục F2 của spec, không theo cấu trúc plugin: 12 màn hình chia 5 nhóm Nhìn → Hiểu → Quản → Làm → Máy.
- Agent không còn mặc định là "Bé Heo": màn Danh tính Agent cho tạo, sửa, nhân bản, tắt nhiều identity trên cùng chassis.
- Bổ sung các lớp spec bắt buộc: thang tự trị 0–6, 5 vai trò Owner/Manager/Operator/Agent/Auditor, chỉ số chất lượng dữ liệu, nút "vì sao hệ thống nghĩ vậy" và drill-down chứng cứ gốc trên mọi điểm số.

## Screen map

| Screen | Repo files & spec |
| --- | --- |
| Tổng quan điều hành | spec F2.1, F4 · dashboard.html (renderCommandCenter) |
| Hộp thư ý nghĩa | spec F2.2, E2 · dsh_bridge/plugins/heo-channel-zalo-gateway |
| Bản đồ quan hệ | spec F2.3, E4 |
| Hồ sơ sống | spec F2.4, E5 |
| Hợp nhất danh tính | spec G2 |
| Kho hội thoại | spec F2.8, E2 |
| Bảng cơ hội | spec F2.5, E3 |
| Đánh giá con người | spec F2.6, E6, E7, I |
| Chất lượng chăm sóc | spec F2.7, E8 |
| Bàn làm việc | spec F2.9, E10, E11 |
| Danh tính Agent | spec E13, F2.10 · heo_harness/plugins/persona/ |
| Điều khiển hệ thống | spec F2.10, H2, J · heo_harness/core/manager.py, plugin.py, plugins/auth/ |
