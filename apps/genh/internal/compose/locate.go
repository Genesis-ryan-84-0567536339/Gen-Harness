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
// trả về đường dẫn đầu tiên tồn tại. Nếu không tìm thấy ở đâu cả (trường hợp
// thật: genh chạy độc lập trên máy Owner, không có checkout repo gần đó),
// rơi về ghi compose.yaml NHÚNG SẴN trong binary (embeddedComposeYAML, xem
// embed.go) ra "<installDir>/deploy/compose.yaml" rồi trả về đường dẫn đó —
// CHỈ khi installDir khác rỗng (không có installDir thì không biết ghi vào
// đâu, giữ nguyên lỗi cũ) và CHỈ khi tệp đó CHƯA có sẵn (không đè một
// compose.yaml Owner đã có, kể cả khi nó khác nội dung nhúng — idempotent,
// giống các bước cài khác trong package install).
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

	if installDir != "" {
		if path, err := writeEmbeddedCompose(installDir); err == nil {
			return path, nil
		}
		// Ghi thất bại (ví dụ không có quyền) — rơi xuống lỗi chung bên dưới,
		// không che giấu bằng cách trả lỗi ghi tệp khó hiểu hơn.
	}

	return "", fmt.Errorf(
		"không tìm thấy deploy/compose.yaml (đã thử biến %s, %s/deploy/compose.yaml, dò lên từ thư mục hiện tại/thư mục chứa genh, và ghi bản nhúng sẵn) — đặt %s=/đường/dẫn/compose.yaml rồi chạy lại",
		EnvOverrideVar, installDir, EnvOverrideVar)
}

// writeEmbeddedCompose ghi compose.yaml nhúng sẵn ra
// "<installDir>/deploy/compose.yaml" nếu tệp đó CHƯA tồn tại, rồi trả về
// đường dẫn — an toàn gọi lại nhiều lần (idempotent), không đè tệp đã có.
func writeEmbeddedCompose(installDir string) (string, error) {
	deployDir := filepath.Join(installDir, "deploy")
	path := filepath.Join(deployDir, "compose.yaml")

	if info, err := os.Stat(path); err == nil && !info.IsDir() {
		return path, nil
	}

	if err := os.MkdirAll(deployDir, 0o755); err != nil {
		return "", fmt.Errorf("tạo thư mục %s: %w", deployDir, err)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, embeddedComposeYAML, 0o644); err != nil {
		return "", fmt.Errorf("ghi %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", fmt.Errorf("đổi tên %s -> %s: %w", tmp, path, err)
	}
	return path, nil
}
