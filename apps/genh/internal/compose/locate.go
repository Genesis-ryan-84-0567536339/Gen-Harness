package compose

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// NoticeWriter là nơi Locate (biến thể KHÔNG đồng bộ, xem doc-comment của
// Locate/LocateAndSync bên dưới) in dòng nhắc một-dòng khi phát hiện
// compose.yaml GENH QUẢN LÝ đã lệch bản nhúng của binary đang chạy — mặc
// định os.Stderr, đổi được trong test để bắt output mà không cần ghi ra
// stderr thật.
var NoticeWriter io.Writer = os.Stderr

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
// trả về đường dẫn đầu tiên tồn tại — dùng cho MỌI lệnh vận hành ĐỌC compose
// (status/open/logs/backup/…). KHÔNG tự ghi đè compose.yaml GENH QUẢN LÝ nếu
// đã lệch bản nhúng của binary đang chạy — xem SỬA LỖI ở doc-comment
// LocateAndSync; ở đây chỉ in một dòng nhắc qua NoticeWriter nếu phát hiện
// lệch, để Owner biết chạy `genh update`. Nếu không tìm thấy ở đâu cả
// (trường hợp thật: genh chạy độc lập trên máy Owner, không có checkout repo
// gần đó), rơi về ghi compose.yaml NHÚNG SẴN trong binary (embeddedComposeYAML,
// xem embed.go) ra "<installDir>/deploy/compose.yaml" rồi trả về đường dẫn đó
// — CHỈ khi installDir khác rỗng VÀ tệp đó CHƯA từng tồn tại (không phải
// đồng bộ lại — đó là việc của LocateAndSync).
func Locate(installDir string) (string, error) {
	return locate(installDir, false)
}

// LocateAndSync là biến thể của Locate CHỈ dùng trong `genh update` (và
// `genh install`, xem internal/install) — hai lệnh có TRÁCH NHIỆM đưa máy
// lên đúng phiên bản mới, khác mọi lệnh vận hành khác (status/open/logs/
// backup/doctor/…) chỉ ĐỌC trạng thái hiện có.
//
// ĐỒNG BỘ tệp GENH QUẢN LÝ (SỬA LỖI docs/reports/HANDOFF-v0.1.1.md mục "Lỗi
// cần sửa" #5): candidate "<installDir>/deploy/compose.yaml" khác mọi
// candidate khác ở chỗ CHÍNH genh đã ghi ra nó (lần cài đầu, hoặc lần chạy
// trước của một bản genh cũ hơn) — không phải một checkout repo Owner tự
// quản lý. Vì vậy, mỗi lần candidate này đã tồn tại, LocateAndSync tự đối
// chiếu với bản nhúng CỦA CHÍNH BINARY ĐANG CHẠY và ghi lại (giữ bản cũ ở
// "compose.yaml.bak") nếu khác.
//
// SỬA LỖI TIẾP (v0.1.2, mục #3): bản v0.1.1 gọi hành vi đồng bộ này từ
// NGAY TRONG Locate — chạy ở MỌI lệnh `genh ...` (kể cả `genh status`/`genh
// logs`/`genh backup`…, vì mọi lệnh đều LocatePath() để biết compose.yaml ở
// đâu), nên bất kỳ lệnh vận hành nào cũng có thể ÂM THẦM ghi đè compose.yaml
// của Owner (kể cả compose.yaml Owner đã tự sửa tay) ngoài ý muốn, chỉ vì
// binary genh đang chạy mang một bản nhúng khác. Từ bản này, CHỈ
// LocateAndSync (update/install) mới thật sự ghi; Locate (mọi lệnh khác)
// chỉ in một dòng nhắc.
func LocateAndSync(installDir string) (string, error) {
	return locate(installDir, true)
}

// locate là phần thân dùng chung của Locate/LocateAndSync — sync=true đồng
// bộ compose.yaml GENH QUẢN LÝ đã lệch bản nhúng (ghi lại + giữ .bak),
// sync=false chỉ in một dòng nhắc qua NoticeWriter nếu lệch, không đụng tệp.
func locate(installDir string, sync bool) (string, error) {
	cwd, _ := os.Getwd()
	exeDir := ""
	if exe, err := os.Executable(); err == nil {
		exeDir = filepath.Dir(exe)
	}

	var managedPath string
	if installDir != "" {
		managedPath = filepath.Join(installDir, "deploy", "compose.yaml")
	}

	for _, c := range SearchCandidates(installDir, cwd, exeDir) {
		info, err := os.Stat(c)
		if err != nil || info.IsDir() {
			continue
		}
		if managedPath != "" && c == managedPath {
			if sync {
				if err := syncEmbeddedCompose(managedPath); err != nil {
					return "", fmt.Errorf("đồng bộ %s với bản nhúng mới: %w", managedPath, err)
				}
			} else {
				noticeIfDrifted(managedPath)
			}
			return managedPath, nil
		}
		return c, nil
	}

	if managedPath != "" {
		if path, err := writeEmbeddedCompose(managedPath); err == nil {
			return path, nil
		}
		// Ghi thất bại (ví dụ không có quyền) — rơi xuống lỗi chung bên dưới,
		// không che giấu bằng cách trả lỗi ghi tệp khó hiểu hơn.
	}

	return "", fmt.Errorf(
		"không tìm thấy deploy/compose.yaml (đã thử biến %s, %s/deploy/compose.yaml, dò lên từ thư mục hiện tại/thư mục chứa genh, và ghi bản nhúng sẵn) — đặt %s=/đường/dẫn/compose.yaml rồi chạy lại",
		EnvOverrideVar, installDir, EnvOverrideVar)
}

// noticeIfDrifted in một dòng nhắc qua NoticeWriter nếu compose.yaml tại path
// khác bản nhúng của binary đang chạy — im lặng bỏ qua lỗi đọc tệp (lỗi thật
// nếu có sẽ lộ ra ngay sau đó khi lệnh gọi thật sự dùng compose.yaml).
func noticeIfDrifted(path string) {
	current, err := os.ReadFile(path)
	if err != nil || bytes.Equal(current, embeddedComposeYAML) {
		return
	}
	_, _ = fmt.Fprintf(NoticeWriter,
		"Lưu ý: %s khác bản compose.yaml nhúng trong genh hiện tại — chạy `genh update` để đồng bộ.\n", path)
}

// writeEmbeddedCompose ghi compose.yaml nhúng sẵn ra path (tạo thư mục cha
// nếu cần) — chỉ gọi khi path CHƯA tồn tại (xem Locate); tệp ĐÃ tồn tại đi
// qua syncEmbeddedCompose thay vì hàm này.
func writeEmbeddedCompose(path string) (string, error) {
	deployDir := filepath.Dir(path)
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

// syncEmbeddedCompose đồng bộ compose.yaml GENH QUẢN LÝ tại path với bản
// nhúng của binary genh ĐANG CHẠY — gọi mỗi khi Locate thấy tệp đó đã có sẵn
// (không chỉ lần ghi đầu, xem SỬA LỖI ở doc-comment của Locate). Không đổi
// gì nếu nội dung đã khớp byte-for-byte (tránh ghi tệp không cần thiết mỗi
// lần Locate chạy — trường hợp phổ biến nhất: genh không đổi phiên bản giữa
// hai lần chạy). Nếu khác, giữ nguyên tệp cũ dưới path+".bak" (Owner có thể
// đã tự sửa tay compose.yaml của mình — thêm service, đổi cổng…; genh không
// cố phân biệt "tự sửa" với "phiên bản genh cũ để lại", chỉ đảm bảo không
// mất trắng nội dung cũ) rồi ghi đè bằng bản nhúng mới, qua tệp tạm + rename
// để không để lại compose.yaml nửa vời nếu tiến trình bị ngắt giữa chừng.
func syncEmbeddedCompose(path string) error {
	current, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("đọc %s: %w", path, err)
	}
	if bytes.Equal(current, embeddedComposeYAML) {
		return nil
	}

	bakPath := path + ".bak"
	if err := os.WriteFile(bakPath, current, 0o644); err != nil {
		return fmt.Errorf("ghi bản sao lưu %s: %w", bakPath, err)
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, embeddedComposeYAML, 0o644); err != nil {
		return fmt.Errorf("ghi %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("đổi tên %s -> %s: %w", tmp, path, err)
	}
	return nil
}
