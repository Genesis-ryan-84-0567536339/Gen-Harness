package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGitHub dựng một httptest.Server giả cả API metadata lẫn tải asset,
// dùng chung một base URL cho cả Options.APIBase và Options.DownloadBase
// (đường dẫn phân biệt bằng path, không cần 2 server riêng).
func fakeGitHub(t *testing.T, tag string, assetBytes map[string][]byte, checksums string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/repos/o/r/releases/latest", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("User-Agent") == "" {
			t.Errorf("thiếu User-Agent trên request tới GitHub API")
		}
		fmt.Fprintf(w, `{"tag_name": %q}`, tag)
	})
	mux.HandleFunc(fmt.Sprintf("/o/r/releases/download/%s/checksums.txt", tag), func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(checksums))
	})
	for name, data := range assetBytes {
		data := data
		mux.HandleFunc(fmt.Sprintf("/o/r/releases/download/%s/%s", tag, name), func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write(data)
		})
	}
	return httptest.NewServer(mux)
}

func sumHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestRun_SameVersion_DoesNothing(t *testing.T) {
	srv := fakeGitHub(t, "v0.1.5", nil, "")
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
	srv := fakeGitHub(t, "v0.1.5", map[string][]byte{asset: newContent}, sums)
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
	info, err := os.Stat(execPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm()&0o111 == 0 {
		t.Fatalf("binary mới phải có quyền thực thi, được %v", info.Mode())
	}
}

func TestRun_ChecksumMismatch_RejectsAndKeepsOldBinary(t *testing.T) {
	newContent := []byte("noi dung ban moi bi hong hoac bi thay doi giua duong")
	asset := AssetName("linux", "amd64")
	// checksums.txt cố tình sai (không khớp sha256 thật của newContent).
	badSum := strings.Repeat("0", 64)
	sums := fmt.Sprintf("%s  %s\n", badSum, asset)
	srv := fakeGitHub(t, "v9.9.9", map[string][]byte{asset: newContent}, sums)
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
