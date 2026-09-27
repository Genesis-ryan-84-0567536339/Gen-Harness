// Package selfupdate cho `genh update` khả năng tự thay BINARY genh đang
// chạy bằng bản mới nhất trên GitHub Releases, TRƯỚC KHI chạy phần nâng cấp
// dịch vụ (internal/ops.RunUpdate) — xem docs/handoff/05-installer.md mục
// "Phát hành" và docs/reports/HANDOFF-v0.1.1.md mục v0.1.5.
//
// Owner không rành code: mục tiêu là sau khi cài một lần, KHÔNG BAO GIỜ phải
// tự tải lại install.sh/install.ps1 để lấy genh mới — `genh update` (tự chạy
// mỗi đêm qua internal/autoupdate) tự lo hết.
//
// Gói này CHỈ lo phần "tải + kiểm checksum + thay tệp trên đĩa" — việc
// RE-EXEC lại chính nó bằng code mới (để phần nâng cấp dịch vụ chạy đúng
// compose.yaml nhúng mới) nằm ở cmd/genh/main.go (xem cờ nội bộ
// --self-updated), vì đó là quyết định của lệnh gọi, không phải của gói này.
package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Options cấu hình một lần chạy Run — mọi trường có URL/HTTP đều có thể
// tiêm giả (httptest.Server) khi test, KHÔNG BAO GIỜ gọi thật github.com
// trong unit test.
type Options struct {
	// Owner/Repo xác định repo GitHub phát hành genh, ví dụ
	// "Genesis-ryan-84-0567536339" / "Gen-Harness".
	Owner string
	Repo  string

	// CurrentVersion là main.version của binary đang chạy. "" hoặc "dev" ⇒
	// Run luôn bỏ qua (bản dev không có gì để so semver, và không nên bị
	// một `genh update` tự động âm thầm thay bằng bản release).
	CurrentVersion string

	// GOOS/GOARCH chọn asset đúng nền tảng — mặc định runtime.GOOS/GOARCH
	// nếu để rỗng, tách riêng để test dựng asset cho nền tảng khác máy chạy
	// test.
	GOOS   string
	GOARCH string

	// ExecutablePath là đường dẫn tệp binary ĐANG CHẠY cần thay — thường
	// os.Executable() đã resolve. Bắt buộc phải khác rỗng để Run tự thay
	// binary; để trống nếu chỉ muốn hỏi bản mới nhất mà không thay gì (dùng
	// khi test bước so sánh).
	ExecutablePath string

	// Client là *http.Client dùng cho mọi request — nil dùng
	// http.DefaultClient với Timeout riêng theo HTTPTimeout.
	Client *http.Client
	// HTTPTimeout áp cho từng request (metadata lẫn tải asset) khi Client
	// nil — mặc định 20s, đủ cho asset genh (vài chục MB) qua mạng chậm mà
	// không treo `genh update` vô thời hạn nếu mạng đứt giữa chừng.
	HTTPTimeout time.Duration

	// APIBase mặc định "https://api.github.com" — tiêm httptest.Server.URL
	// khi test.
	APIBase string
	// DownloadBase mặc định "https://github.com" (asset tải qua
	// /<owner>/<repo>/releases/download/<tag>/<asset>) — tiêm khi test.
	DownloadBase string

	// Out nhận các dòng tiến độ/cảnh báo — nil dùng io.Discard. Quiet=true
	// chỉ in dòng QUAN TRỌNG (có bản mới hơn / lỗi mạng-checksum / đã thay
	// xong), bỏ các dòng "đang kiểm tra…".
	Out   io.Writer
	Quiet bool
}

// Result là kết quả một lần Run.
type Result struct {
	Updated bool   // đã thay binary trên đĩa hay chưa
	From    string // CurrentVersion
	To      string // tag bản mới (rỗng nếu Updated == false)
	Skipped bool   // true nếu Run chủ động bỏ qua (bản dev, đã mới nhất, lỗi mạng...)
	Reason  string // vì sao bỏ qua/không thay — LUÔN có giá trị khi Skipped
}

const defaultHTTPTimeout = 20 * time.Second

func (o Options) client() *http.Client {
	if o.Client != nil {
		return o.Client
	}
	timeout := o.HTTPTimeout
	if timeout <= 0 {
		timeout = defaultHTTPTimeout
	}
	return &http.Client{Timeout: timeout}
}

func (o Options) apiBase() string {
	if o.APIBase != "" {
		return strings.TrimSuffix(o.APIBase, "/")
	}
	return "https://api.github.com"
}

func (o Options) downloadBase() string {
	if o.DownloadBase != "" {
		return strings.TrimSuffix(o.DownloadBase, "/")
	}
	return "https://github.com"
}

func (o Options) goos() string {
	if o.GOOS != "" {
		return o.GOOS
	}
	return runtime.GOOS
}

func (o Options) goarch() string {
	if o.GOARCH != "" {
		return o.GOARCH
	}
	return runtime.GOARCH
}

func (o Options) logf(important bool, format string, args ...any) {
	if o.Out == nil {
		return
	}
	if o.Quiet && !important {
		return
	}
	_, _ = fmt.Fprintf(o.Out, format+"\n", args...)
}

// AssetName trả về tên tệp binary phát hành đúng quy ước của install.sh/
// install.ps1 (docs/handoff/05-installer.md): "genh-<os>-<arch>", thêm
// ".exe" trên Windows.
func AssetName(goos, goarch string) string {
	if goos == "windows" {
		return fmt.Sprintf("genh-windows-%s.exe", goarch)
	}
	return fmt.Sprintf("genh-%s-%s", goos, goarch)
}

// Run thực hiện toàn bộ khung: hỏi bản mới nhất -> so semver với
// CurrentVersion -> nếu mới hơn, tải asset + checksums.txt của ĐÚNG tag đó
// (không dùng /latest/download để tránh lệch bản giữa lúc hỏi metadata và
// lúc tải nếu có release mới xen vào giữa chừng) -> kiểm SHA-256 (BẮT BUỘC,
// sai -> từ chối, KHÔNG thay gì) -> thay ExecutablePath an toàn.
//
// LỖI MẠNG khi hỏi bản mới nhất KHÔNG làm Run trả lỗi — theo đúng yêu cầu
// "báo và tiếp tục với binary hiện tại": trả Result{Skipped:true} với Reason
// mô tả lỗi, err == nil. Run chỉ trả err khác nil khi ĐÃ CHẮC có bản mới hơn
// nhưng tải/kiểm checksum/thay tệp thất bại — khi đó gọi bên ngoài (cmd/genh)
// tự quyết định có coi là lỗi chặn `genh update` hay chỉ cảnh báo (bản thân
// gói này không biết mức độ nghiêm trọng người gọi muốn).
func Run(ctx context.Context, opts Options) (Result, error) {
	current := strings.TrimSpace(opts.CurrentVersion)
	if current == "" || current == "dev" {
		return Result{Skipped: true, Reason: "binary bản dev (chưa gắn phiên bản phát hành) — bỏ qua tự cập nhật"}, nil
	}

	opts.logf(false, "genh: đang hỏi bản genh mới nhất (%s/%s)…", opts.Owner, opts.Repo)
	latest, err := latestTag(ctx, opts)
	if err != nil {
		reason := fmt.Sprintf("không hỏi được bản mới nhất (%v) — tiếp tục với bản hiện tại %s", err, current)
		opts.logf(true, "genh: %s", reason)
		return Result{Skipped: true, Reason: reason}, nil
	}

	if !IsNewer(current, latest) {
		opts.logf(false, "genh: đã ở bản mới nhất (%s).", current)
		return Result{Skipped: true, Reason: "đã ở bản mới nhất"}, nil
	}

	opts.logf(true, "genh: có bản mới %s (đang chạy %s) — đang tải…", latest, current)

	if opts.ExecutablePath == "" {
		return Result{Skipped: true, Reason: "không có ExecutablePath để thay"}, nil
	}

	asset := AssetName(opts.goos(), opts.goarch())
	data, err := downloadVerified(ctx, opts, latest, asset)
	if err != nil {
		return Result{}, fmt.Errorf("tải/kiểm checksum %s bản %s: %w", asset, latest, err)
	}

	if err := replaceExecutable(opts.ExecutablePath, data); err != nil {
		return Result{}, fmt.Errorf("thay binary %s: %w", opts.ExecutablePath, err)
	}

	opts.logf(true, "genh: đã tự cập nhật lên %s (bản cũ %s).", latest, current)
	return Result{Updated: true, From: current, To: latest}, nil
}

// releaseMeta là phần JSON cần của response GitHub
// GET /repos/{owner}/{repo}/releases/latest.
type releaseMeta struct {
	TagName string `json:"tag_name"`
}

func latestTag(ctx context.Context, opts Options) (string, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases/latest", opts.apiBase(), opts.Owner, opts.Repo)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	// GitHub API từ chối request không có User-Agent (403) — xem
	// https://docs.github.com/en/rest/overview/resources-in-the-rest-api.
	req.Header.Set("User-Agent", "gen-harness-genh")
	req.Header.Set("Accept", "application/vnd.github+json")

	resp, err := opts.client().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("GET %s: %s — %s", url, resp.Status, strings.TrimSpace(string(body)))
	}

	var meta releaseMeta
	if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
		return "", fmt.Errorf("giải mã JSON release: %w", err)
	}
	if meta.TagName == "" {
		return "", errors.New("response không có tag_name")
	}
	return meta.TagName, nil
}

// downloadVerified tải asset + checksums.txt của đúng tag, kiểm SHA-256
// BẮT BUỘC (giống install.sh verify_checksum) trước khi trả bytes — không
// bao giờ trả bytes chưa kiểm.
func downloadVerified(ctx context.Context, opts Options, tag, asset string) ([]byte, error) {
	base := fmt.Sprintf("%s/%s/%s/releases/download/%s", opts.downloadBase(), opts.Owner, opts.Repo, tag)

	sums, err := fetchBytes(ctx, opts, base+"/checksums.txt")
	if err != nil {
		return nil, fmt.Errorf("tải checksums.txt: %w", err)
	}
	want, err := findChecksum(string(sums), asset)
	if err != nil {
		return nil, err
	}

	data, err := fetchBytes(ctx, opts, base+"/"+asset)
	if err != nil {
		return nil, fmt.Errorf("tải %s: %w", asset, err)
	}

	got := sha256Hex(data)
	if !strings.EqualFold(got, want) {
		return nil, fmt.Errorf("SHA-256 của %s không khớp checksums.txt (muốn %s, được %s) — từ chối, không thay binary", asset, want, got)
	}
	return data, nil
}

func fetchBytes(ctx context.Context, opts Options, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "gen-harness-genh")

	resp, err := opts.client().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("GET %s: %s — %s", url, resp.Status, strings.TrimSpace(string(body)))
	}
	return io.ReadAll(resp.Body)
}

// sha256Hex trả về SHA-256 của data dạng chuỗi hex thường (khớp định dạng
// checksums.txt do `sha256sum`/`shasum -a 256` sinh ra — xem install.sh
// sha256_of).
func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// findChecksum tìm dòng "<sha256>  <tên tệp>" khớp basename asset trong nội
// dung checksums.txt — cùng cách so khớp với install.sh (bỏ tiền tố "./").
func findChecksum(checksums, asset string) (string, error) {
	for _, line := range strings.Split(checksums, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		name := strings.TrimPrefix(fields[1], "./")
		if name == asset {
			return fields[0], nil
		}
	}
	return "", fmt.Errorf("không tìm thấy %s trong checksums.txt", asset)
}

// replaceExecutable ghi data ra một tệp tạm CÙNG THƯ MỤC với execPath (đảm
// bảo rename là cùng filesystem, atomic trên Linux/macOS) rồi thay execPath:
//
//   - Linux/macOS: os.Rename thẳng đè lên execPath — hệ điều hành cho phép
//     thay/xoá tệp thực thi đang chạy (inode cũ vẫn sống cho tới khi tiến
//     trình đang dùng nó thoát), tiến trình genh hiện tại tiếp tục chạy bình
//     thường bằng nội dung CŨ cho tới khi re-exec (cmd/genh/main.go).
//   - Windows: KHÔNG rename được lên một .exe đang chạy (file bị khoá) — đổi
//     tên bản cũ thành ".old" trước (Windows cho phép rename tệp đang chạy,
//     chỉ không cho ghi đè/xoá), rồi đặt bản mới đúng tên cũ. Tệp ".old" dọn
//     best-effort ở lần chạy genh KẾ TIẾP (os.Remove không lỗi thì thôi, có
//     lỗi cũng không sao — không phải tệp quan trọng).
func replaceExecutable(execPath string, data []byte) error {
	dir := filepath.Dir(execPath)
	tmp, err := os.CreateTemp(dir, ".genh-update-*")
	if err != nil {
		return fmt.Errorf("tạo tệp tạm trong %s: %w", dir, err)
	}
	tmpPath := tmp.Name()
	_, writeErr := tmp.Write(data)
	closeErr := tmp.Close()
	if writeErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("ghi tệp tạm: %w", writeErr)
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("đóng tệp tạm: %w", closeErr)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("chmod tệp tạm: %w", err)
	}

	if runtime.GOOS == "windows" {
		oldPath := execPath + ".old"
		_ = os.Remove(oldPath) // dọn tàn dư lần thay trước, nếu có — bỏ qua lỗi
		if err := os.Rename(execPath, oldPath); err != nil {
			_ = os.Remove(tmpPath)
			return fmt.Errorf("đổi tên bản cũ %s -> %s: %w", execPath, oldPath, err)
		}
		if err := os.Rename(tmpPath, execPath); err != nil {
			// Cố khôi phục bản cũ để không để máy không có genh.exe nào chạy được.
			_ = os.Rename(oldPath, execPath)
			return fmt.Errorf("đặt bản mới vào %s: %w", execPath, err)
		}
		_ = os.Remove(oldPath)
		return nil
	}

	if err := os.Rename(tmpPath, execPath); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("đổi tên %s -> %s: %w", tmpPath, execPath, err)
	}
	return nil
}

// --- so sánh semver ---

// IsNewer báo true nếu latest là một bản semver MỚI HƠN current theo đúng
// nghĩa (major, minor, patch) — bản tiền phát hành (-rc1, -beta…) bị bỏ qua
// phần hậu tố, chỉ so 3 số chính; latest/current không đúng dạng
// "vMAJOR.MINOR.PATCH[...]" -> false (không bao giờ tự nhận "mới hơn" một
// chuỗi không so được, an toàn hơn là lỡ tự cập nhật nhầm).
func IsNewer(current, latest string) bool {
	cm, cn, cp, ok := parseSemver(current)
	if !ok {
		return false
	}
	lm, ln, lp, ok := parseSemver(latest)
	if !ok {
		return false
	}
	if lm != cm {
		return lm > cm
	}
	if ln != cn {
		return ln > cn
	}
	return lp > cp
}

func parseSemver(s string) (major, minor, patch int, ok bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return 0, 0, 0, false
	}
	nums := make([]int, 3)
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return 0, 0, 0, false
		}
		nums[i] = n
	}
	return nums[0], nums[1], nums[2], true
}
