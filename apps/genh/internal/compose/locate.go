package compose

import (
	"fmt"
	"os"
	"path/filepath"
)

// EnvOverrideVar cho phép chỉ thẳng đường dẫn compose.yaml, bỏ qua dò tìm —
// dùng khi test hoặc khi Owner cài từ một bản sao repo không theo cấu trúc
// mặc định.
const EnvOverrideVar = "GENH_COMPOSE_FILE"

// SearchCandidates liệt kê các đường dẫn Locate sẽ thử theo đúng thứ tự ưu
// tiên — hàm thuần (không đụng đĩa), test được độc lập với hệ thống tệp
// thật. installDir/cwd/exeDir đều có thể rỗng (Locate tự điền giá trị thật
// khi gọi Locate, test tự truyền cố định để có kết quả xác định).
func SearchCandidates(installDir, cwd, exeDir string) []string {
	var candidates []string

	if v := os.Getenv(EnvOverrideVar); v != "" {
		candidates = append(candidates, v)
	}

	if installDir != "" {
		candidates = append(candidates, filepath.Join(installDir, "deploy", "compose.yaml"))
	}

	// Dò lên tối đa 8 cấp cha từ thư mục làm việc và từ thư mục chứa binary
	// genh — đủ sâu cho cấu trúc repo/monorepo thông thường
	// (apps/genh/cmd/genh -> gốc repo là 3 cấp), dư dả cho cả trường hợp
	// build ở thư mục con sâu hơn.
	for _, start := range []string{cwd, exeDir} {
		if start == "" {
			continue
		}
		candidates = append(candidates, ascendingCandidates(start, 8)...)
	}

	return candidates
}

func ascendingCandidates(start string, maxUp int) []string {
	var out []string
	dir := start
	for i := 0; i <= maxUp; i++ {
		out = append(out, filepath.Join(dir, "deploy", "compose.yaml"))
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return out
}

// Locate tìm deploy/compose.yaml thật trên máy theo thứ tự SearchCandidates,
// trả về đường dẫn đầu tiên tồn tại.
//
// GIỚI HẠN QUAN TRỌNG (xem docs/handoff/05-installer.md mục "2. genh"): một
// bản genh PHÁT HÀNH THẬT phải tự mang theo compose.yaml (nhúng vào binary
// hoặc tải kèm bản phát hành) vì máy Owner không có checkout repo
// Gen-Harness. Việc nhúng/đóng gói đó thuộc "Phát hành" (GitHub Actions —
// ngoài phạm vi phiên này). Locate hiện dò lên các thư mục cha từ nơi genh
// đang chạy — ĐÚNG và ĐỦ khi genh chạy trong một checkout repo (dev, CI,
// hoặc một bản cài có kèm mã nguồn), nhưng chưa giải quyết trường hợp genh
// chạy độc lập không có checkout nào gần đó — trường hợp đó phải dùng
// GENH_COMPOSE_FILE cho tới khi có cơ chế nhúng của phiên phát hành sau.
func Locate(installDir string) (string, error) {
	cwd, _ := os.Getwd()
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}

	for _, c := range SearchCandidates(installDir, cwd, exeDir) {
		if info, err := os.Stat(c); err == nil && !info.IsDir() {
			return c, nil
		}
	}
	return "", fmt.Errorf(
		"không tìm thấy deploy/compose.yaml (đã thử biến %s, %s/deploy/compose.yaml, và dò lên từ thư mục hiện tại/thư mục chứa genh) — đặt %s=/đường/dẫn/compose.yaml rồi chạy lại",
		EnvOverrideVar, installDir, EnvOverrideVar)
}
