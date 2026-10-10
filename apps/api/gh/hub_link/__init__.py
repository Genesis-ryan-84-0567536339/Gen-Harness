"""Liên kết Gen-hub — Gen đọc Kho dữ liệu chỉ-đọc (v0.1.26, docs/design/gen-hub-link.md)."""

#: Tên hiển thị của Kho dữ liệu nối qua Gen-hub — MỘT chỗ duy nhất ở API (bản sao web: `KHO_LABEL` ở
#: packages/contracts/src/gen.ts). v0.1.56: tên chung, không mang tên riêng của chủ Gen-hub (mọi Owner nhận bản này).
#: Chuỗi tĩnh (lessons.json, tips.json, registry.json) ghi cùng chữ — tests/test_no_personal_info_v0156.py kiểm khớp.
KHO_LABEL = "Kho dữ liệu"
