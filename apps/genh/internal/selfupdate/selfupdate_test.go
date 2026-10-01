package selfupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fakeRelease mô tả bản phát hành fakeGitHub trả về ở /releases/latest.
// PublishedAt zero ⇒ KHÔNG có trường published_at trong JSON (giả lập
// response thiếu thời điểm phát hành).
type fakeRelease struct {
	Tag         string
	PublishedAt time.Time
	Prerelease  bool
	Draft       bool
	Assets      map[string][]byte
	Checksums   string
}

// fakeGH là httptest.Server giả GitHub kèm bộ đếm số request tải
// (asset lẫn checksums.txt) — để test khẳng định "bị hoãn thì KHÔNG tải gì".
type fakeGH struct {
	*httptest.Server
	downloads atomic.Int64
}

// fakeGitHub dựng một httptest.Server giả cả API metadata lẫn tải asset,
// dùng chung một base URL cho cả Options.APIBase và Options.DownloadBase
// (đường dẫn phân biệt bằng path, không cần 2 server riêng).
func fakeGitHub(t *testing.T, rel fakeRelease) *fakeGH {
	t.Helper()
	gh := &fakeGH{}
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Errorf("thiếu User-Agent trên request tới GitHub API")
		}
		body := map[string]any{"tag_name": rel.Tag, "prerelease": rel.Prerelease, "draft": rel.Draft}
		if !rel.PublishedAt.IsZero() {
			// Đúng định dạng GitHub trả: RFC 3339, UTC, đơn vị giây.
			body["published_at"] = rel.PublishedAt.UTC().Format(time.RFC3339)
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	mux.HandleFunc(fmt.Sprintf("/o/r/releases/download/%s/checksums.txt", rel.Tag), func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(rel.Checksums))
	})
	for name, data := range rel.Assets {
		data := data
		mux.HandleFunc(fmt.Sprintf("/o/r/releases/download/%s/%s", rel.Tag, name), func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(data)
		})
	}
	gh.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/releases/download/") {
			gh.downloads.Add(1)
		}
		mux.ServeHTTP(w, r)
	}))
	return gh
}

func sumHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestRun_SameVersion_DoesNothing(t *testing.T) {
	srv := fakeGitHub(t, fakeRelease{Tag: "v0.1.5"})
	defer srv.Close()

	res, err := Run(context.Background(), Options{
		Owner: "o", Repo: "r",
		CurrentVersion: "v0.1.5",
		APIBase:        srv.URL,
		DownloadBase:   srv.URL,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Skipped || res.Updated {
		t.Fatalf("muốn Skipped=true, Updated=false — được %+v", res)
	}
}

func TestRun_DevVersion_AlwaysSkipped(t *testing.T) {
	// Không cần server thật — Run phải bỏ qua TRƯỚC KHI gọi mạng.
	res, err := Run(context.Background(), Options{
		Owner: "o", Repo: "r",
		CurrentVersion: "dev",
		APIBase:        "http://127.0.0.1:0", // sẽ lỗi kết nối nếu Run lỡ gọi tới
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Skipped || res.Updated {
		t.Fatalf("muốn Skipped=true cho bản dev — được %+v", res)
	}
}

func TestRun_NetworkError_SkipsWithoutFailing(t *testing.T) {
	res, err := Run(context.Background(), Options{
		Owner: "o", Repo: "r",
		CurrentVersion: "v0.1.4",
		APIBase:        "http://127.0.0.1:1", // cổng không ai lắng nghe -> lỗi kết nối
		HTTPTimeout:    500_000_000,          // 0.5s, khỏi chờ lâu
	})
	if err != nil {
		t.Fatalf("lỗi mạng không được làm Run trả err, được: %v", err)
	}
	if !res.Skipped {
		t.Fatalf("muốn Skipped=true khi lỗi mạng, được %+v", res)
	}
}

func TestRun_NewerVersion_DownloadsVerifiesAndReplaces(t *testing.T) {
	newContent := []byte("genh binary noi dung ban moi v0.1.5")
	asset := AssetName("linux", "amd64")
	sums := fmt.Sprintf("%s  %s\n", sumHex(newContent), asset)
	srv := fakeGitHub(t, fakeRelease{Tag: "v0.1.5", Assets: map[string][]byte{asset: newContent}, Checksums: sums})
	defer srv.Close()

	dir := t.TempDir()
	execPath := filepath.Join(dir, "genh")
	if err := os.WriteFile(execPath, []byte("noi dung binary cu"), 0o755); err != nil {
		t.Fatal(err)
	}

	res, err := Run(context.Background(), Options{
		Owner: "o", Repo: "r",
		CurrentVersion: "v0.1.4",
		GOOS:           "linux", GOARCH: "amd64",
		ExecutablePath: execPath,
		APIBase:        srv.URL,
		DownloadBase:   srv.URL,
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.Updated || res.To != "v0.1.5" || res.From != "v0.1.4" {
		t.Fatalf("muốn Updated=true To=v0.1.5 From=v0.1.4 — được %+v", res)
	}

	got, err := os.ReadFile(execPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(newContent) {
		t.Fatalf("binary trên đĩa chưa được thay đúng nội dung mới")
	}
	// Windows không có bit thực thi (os.Stat luôn trả 0666/0444 cho tệp
	// thường — chạy được hay không do đuôi .exe quyết định), nên chỉ kiểm
	// quyền thực thi trên Linux/macOS.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(execPath)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o111 == 0 {
			t.Fatalf("binary mới phải có quyền thực thi, được %v", info.Mode())
		}
	}
}

func TestRun_ChecksumMismatch_RejectsAndKeepsOldBinary(t *testing.T) {
	newContent := []byte("noi dung ban moi bi hong hoac bi thay doi giua duong")
	asset := AssetName("linux", "amd64")
	// checksums.txt cố tình sai (không khớp sha256 thật của newContent).
	badSum := strings.Repeat("0", 64)
	sums := fmt.Sprintf("%s  %s\n", badSum, asset)
	srv := fakeGitHub(t, fakeRelease{Tag: "v9.9.9", Assets: map[string][]byte{asset: newContent}, Checksums: sums})
	defer srv.Close()

	dir := t.TempDir()
	execPath := filepath.Join(dir, "genh")
	oldContent := []byte("noi dung binary cu, khong duoc doi")
	if err := os.WriteFile(execPath, oldContent, 0o755); err != nil {
		t.Fatal(err)
	}

	_, err := Run(context.Background(), Options{
		Owner: "o", Repo: "r",
		CurrentVersion: "v0.1.4",
		GOOS:           "linux", GOARCH: "amd64",
		ExecutablePath: execPath,
		APIBase:        srv.URL,
		DownloadBase:   srv.URL,
	})
	if err == nil {
		t.Fatalf("muốn Run trả lỗi khi checksum sai, được nil")
	}

	got, rerr := os.ReadFile(execPath)
	if rerr != nil {
		t.Fatal(rerr)
	}
	if string(got) != string(oldContent) {
		t.Fatalf("checksum sai nhưng binary cũ đã bị thay đổi — không được phép")
	}

	// Không được để lại tệp tạm trong thư mục.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("thư mục phải chỉ còn đúng 1 tệp (binary cũ), được %d", len(entries))
	}
}

func TestIsNewer(t *testing.T) {
	cases := []struct {
		current, latest string
		want            bool
	}{
		{"v0.1.4", "v0.1.5", true},
		{"v0.1.5", "v0.1.4", false},
		{"v0.1.5", "v0.1.5", false},
		{"v0.9.9", "v1.0.0", true},
		{"v1.2.3", "v1.2.10", true},
		{"dev", "v0.1.5", false},
		{"v0.1.5", "not-a-version", false},
	}
	for _, c := range cases {
		if got := IsNewer(c.current, c.latest); got != c.want {
			t.Errorf("IsNewer(%q, %q) = %v, muốn %v", c.current, c.latest, got, c.want)
		}
	}
}

// --- thời gian chín (MinAge) + bản thử (prerelease) ---

// fixedNow là "bây giờ" cố định tiêm vào Options.Now — để tuổi bản phát hành
// trong test không phụ thuộc đồng hồ máy chạy test.
var fixedNow = time.Date(2026, 10, 1, 3, 0, 0, 0, time.UTC)

const (
	oldBinary = "noi dung binary cu v0.1.32"
	newBinary = "noi dung binary moi v0.1.33"
)

// minAgeFixture dựng server giả có bản v0.1.33 (asset + checksums đúng) và
// một binary cũ v0.1.32 trên đĩa; trả server, đường dẫn binary và Options
// nền (caller tự đặt MinAge/Out/Quiet).
func minAgeFixture(t *testing.T, rel fakeRelease) (*fakeGH, string, Options) {
	t.Helper()
	asset := AssetName("linux", "amd64")
	rel.Tag = "v0.1.33"
	rel.Assets = map[string][]byte{asset: []byte(newBinary)}
	rel.Checksums = fmt.Sprintf("%s  %s\n", sumHex([]byte(newBinary)), asset)
	srv := fakeGitHub(t, rel)
	t.Cleanup(srv.Close)

	execPath := filepath.Join(t.TempDir(), "genh")
	if err := os.WriteFile(execPath, []byte(oldBinary), 0o755); err != nil {
		t.Fatal(err)
	}
	return srv, execPath, Options{
		Owner: "o", Repo: "r",
		CurrentVersion: "v0.1.32",
		GOOS:           "linux", GOARCH: "amd64",
		ExecutablePath: execPath,
		APIBase:        srv.URL,
		DownloadBase:   srv.URL,
		Now:            func() time.Time { return fixedNow },
	}
}

func readBinary(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// assertNotInstalled: Run bỏ qua, không request tải nào, binary giữ nguyên.
func assertNotInstalled(t *testing.T, res Result, srv *fakeGH, execPath string) {
	t.Helper()
	if !res.Skipped || res.Updated || res.To != "" {
		t.Fatalf("muốn Skipped=true, Updated=false, To rỗng — được %+v", res)
	}
	if res.Reason == "" {
		t.Fatalf("Skipped thì Reason phải có giá trị")
	}
	if n := srv.downloads.Load(); n != 0 {
		t.Fatalf("bản không được cài thì KHÔNG được tải asset/checksums — có %d request tải", n)
	}
	if got := readBinary(t, execPath); got != oldBinary {
		t.Fatalf("binary trên đĩa đã bị thay (%q) — không được phép", got)
	}
}

func assertInstalled(t *testing.T, res Result, execPath string) {
	t.Helper()
	if !res.Updated || res.Skipped || res.Deferred || res.To != "v0.1.33" || res.From != "v0.1.32" {
		t.Fatalf("muốn Updated=true To=v0.1.33 From=v0.1.32 — được %+v", res)
	}
	if got := readBinary(t, execPath); got != newBinary {
		t.Fatalf("binary trên đĩa chưa được thay bằng bản mới, được %q", got)
	}
}

func TestRun_MinAge_BoQuaBanDuoi24h(t *testing.T) {
	srv, execPath, opts := minAgeFixture(t, fakeRelease{PublishedAt: fixedNow.Add(-2 * time.Hour)})
	var out bytes.Buffer
	opts.MinAge = NightlyMinAge
	opts.Out = &out
	opts.Quiet = true // như lịch đêm: --quiet vẫn phải ghi lý do vào log

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertNotInstalled(t, res, srv, execPath)
	if !res.Deferred {
		t.Fatalf("chưa đủ thời gian chín thì Deferred phải = true — được %+v", res)
	}
	for _, want := range []string{"v0.1.33", "2 giờ trước", "24 giờ", "Cập nhật ngay"} {
		if !strings.Contains(res.Reason, want) {
			t.Errorf("Reason thiếu %q: %q", want, res.Reason)
		}
	}
	if !strings.Contains(out.String(), res.Reason) {
		t.Errorf("dòng hoãn cài phải in ra cả khi Quiet (vào logs/auto-update.log), Out = %q", out.String())
	}
}

func TestRun_MinAge_CaiBanDu24h(t *testing.T) {
	srv, execPath, opts := minAgeFixture(t, fakeRelease{PublishedAt: fixedNow.Add(-25 * time.Hour)})
	opts.MinAge = NightlyMinAge

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertInstalled(t, res, execPath)
	if n := srv.downloads.Load(); n != 2 {
		t.Errorf("muốn đúng 2 request tải (checksums.txt + asset), được %d", n)
	}
}

func TestRun_MinAge_BienDung24h(t *testing.T) {
	_, execPath, opts := minAgeFixture(t, fakeRelease{PublishedAt: fixedNow.Add(-NightlyMinAge)})
	opts.MinAge = NightlyMinAge

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertInstalled(t, res, execPath)
}

func TestRun_KhongMinAge_CapNhatNgay(t *testing.T) {
	// Nút "Cập nhật ngay" (và `genh update` gõ tay) chạy với MinAge = 0: bản
	// vừa phát hành 1 phút cũng phải cài được ngay.
	_, execPath, opts := minAgeFixture(t, fakeRelease{PublishedAt: fixedNow.Add(-time.Minute)})
	opts.MinAge = 0

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertInstalled(t, res, execPath)
}

func TestRun_MinAge_ThieuPublishedAt(t *testing.T) {
	srv, execPath, opts := minAgeFixture(t, fakeRelease{}) // không có published_at
	opts.MinAge = NightlyMinAge

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertNotInstalled(t, res, srv, execPath)
	if !strings.Contains(res.Reason, "thời điểm phát hành") {
		t.Errorf("Reason phải nói rõ không đọc được thời điểm phát hành: %q", res.Reason)
	}
}

func TestRun_Prerelease_BoQua(t *testing.T) {
	cases := map[string]fakeRelease{
		"prerelease": {PublishedAt: fixedNow.Add(-48 * time.Hour), Prerelease: true},
		"draft":      {PublishedAt: fixedNow.Add(-48 * time.Hour), Draft: true},
	}
	for name, rel := range cases {
		t.Run(name, func(t *testing.T) {
			srv, execPath, opts := minAgeFixture(t, rel)
			opts.MinAge = 0 // kể cả "Cập nhật ngay" cũng không nhận bản thử/bản nháp

			res, err := Run(context.Background(), opts)
			if err != nil {
				t.Fatalf("Run: %v", err)
			}
			assertNotInstalled(t, res, srv, execPath)
			if res.Deferred {
				t.Errorf("bản thử/bản nháp không phải \"hoãn\" — Deferred phải = false, được %+v", res)
			}
			if !strings.Contains(res.Reason, "chưa phải bản chính thức") {
				t.Errorf("Reason chưa nói rõ đây không phải bản chính thức: %q", res.Reason)
			}
		})
	}
}

func TestRun_MinAge_DongHoThatKhiNowNil(t *testing.T) {
	// Now nil ⇒ dùng time.Now: bản phát hành 1 giờ trước (theo đồng hồ thật)
	// vẫn phải bị hoãn.
	srv, execPath, opts := minAgeFixture(t, fakeRelease{PublishedAt: time.Now().Add(-time.Hour)})
	opts.Now = nil
	opts.MinAge = NightlyMinAge

	res, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	assertNotInstalled(t, res, srv, execPath)
	if !res.Deferred {
		t.Fatalf("muốn Deferred=true — được %+v", res)
	}
}

func TestFormatDurationVi(t *testing.T) {
	cases := []struct {
		d    time.Duration
		want string
	}{
		{24 * time.Hour, "24 giờ"},
		{3*time.Hour + 5*time.Minute, "3 giờ 5 phút"},
		{3*time.Hour + 5*time.Minute + 59*time.Second, "3 giờ 5 phút"},
		{45 * time.Minute, "45 phút"},
		{2 * time.Hour, "2 giờ"},
		{23*time.Hour + 59*time.Minute + 40*time.Second, "23 giờ 59 phút"},
		{30 * time.Second, "chưa đến 1 phút"},
		{-5 * time.Minute, "chưa đến 1 phút"},
	}
	for _, c := range cases {
		if got := formatDurationVi(c.d); got != c.want {
			t.Errorf("formatDurationVi(%v) = %q, muốn %q", c.d, got, c.want)
		}
	}
}
