package compose

import _ "embed"

// embeddedComposeYAML là compose.yaml nhúng sẵn vào chính binary genh, dùng
// làm phương án cuối khi Locate không tìm thấy deploy/compose.yaml nào trên
// đĩa (trường hợp thật: genh chạy độc lập trên máy Owner, không có checkout
// repo Gen-Harness nào gần đó).
//
// Ở một checkout dev/CI bình thường, Locate luôn tìm thấy compose.yaml thật
// trên đĩa trước (xem SearchCandidates) nên nội dung nhúng ở đây không được
// dùng tới — tệp embedded_compose.yaml chỉ cần TỒN TẠI để `go:embed` biên
// dịch được, và mặc định là một bản sao y hệt deploy/compose.yaml lúc build
// (dùng "build:" cục bộ, không tải được image nào — Bước 3/`genh update`
// vẫn tự báo rõ "chưa có bản phát hành" cho các service đó, không âm thầm
// lỗi).
//
// Bản phát hành THẬT (`.github/workflows/release.yml`, job pin-compose +
// build-genh) ghi ĐÈ tệp embedded_compose.yaml bằng deploy/compose.release.yaml
// đã ghim digest ("image: ghcr.io/...@sha256:...") TRƯỚC KHI build genh cho
// từng nền tảng — nhờ vậy một Owner tải genh về từ GitHub Release sẽ có
// compose.yaml đúng, dùng image đã publish sẵn, không cần checkout repo.
//
//go:embed embedded_compose.yaml
var embeddedComposeYAML []byte
