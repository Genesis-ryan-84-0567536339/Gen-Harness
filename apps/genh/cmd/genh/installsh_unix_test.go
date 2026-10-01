//go:build !windows

// Kiểm install.sh (bootstrap một lệnh ở gốc repo) bằng cách chạy thật với
// `sh`, thay curl bằng một script giả (đọc tệp từ thư mục fixture, không gọi
// mạng) và genh bằng một script giả ghi lại đối số nó được gọi — để biết
// install.sh giao lại cho `genh install`, `genh update` hay
// `genh update --no-self-update`. Chỉ chạy trên Linux/macOS (install.sh
// không dành cho Windows — Windows dùng install.ps1).

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type installShEnv struct {
	home     string // GEN_HARNESS_HOME = HOME
	fixtures string // tệp curl giả trả về, theo tên cuối URL
	argsFile string // đối số genh giả nhận được
	urlsFile string // các URL curl giả đã được gọi
	pathDir  string // thư mục chứa curl giả, đặt đầu PATH
}

func installShAsset(t *testing.T) string {
	t.Helper()
	arch := runtime.GOARCH
	if arch != "amd64" && arch != "arm64" {
		t.Skipf("install.sh chỉ hỗ trợ amd64/arm64, máy test là %s", arch)
	}
	return fmt.Sprintf("genh-%s-%s", runtime.GOOS, arch)
}

// newInstallShEnv dựng fixture: asset genh giả (script ghi đối số) +
// checksums.txt đúng SHA-256 của nó, và curl giả. withAsset=false ⇒ curl giả
// trả 404 cho mọi tệp (tag không tồn tại).
func newInstallShEnv(t *testing.T, withAsset bool) installShEnv {
	t.Helper()
	root := t.TempDir()
	e := installShEnv{
		home:     filepath.Join(root, "home"),
		fixtures: filepath.Join(root, "fixtures"),
		argsFile: filepath.Join(root, "genh-args.txt"),
		urlsFile: filepath.Join(root, "curl-urls.txt"),
		pathDir:  filepath.Join(root, "bin"),
	}
	for _, d := range []string{e.home, e.fixtures, e.pathDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if withAsset {
		asset := installShAsset(t)
		genh := []byte("#!/bin/sh\nprintf '%s' \"$*\" > \"$GENH_ARGS_FILE\"\n")
		if err := os.WriteFile(filepath.Join(e.fixtures, asset), genh, 0o644); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(genh)
		sums := fmt.Sprintf("%s  %s\n", hex.EncodeToString(sum[:]), asset)
		if err := os.WriteFile(filepath.Join(e.fixtures, "checksums.txt"), []byte(sums), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// install.sh gọi: curl -fsSL -o <đích> <url>.
	curl := `#!/bin/sh
dest="$3"
url="$4"
printf '%s\n' "$url" >> "$CURL_URLS_FILE"
name="${url##*/}"
if [ -f "$FIXTURES_DIR/$name" ]; then
	cp "$FIXTURES_DIR/$name" "$dest"
	exit 0
fi
echo "curl: (22) The requested URL returned error: 404" >&2
exit 22
`
	if err := os.WriteFile(filepath.Join(e.pathDir, "curl"), []byte(curl), 0o755); err != nil {
		t.Fatal(err)
	}
	return e
}

func (e installShEnv) markInstalled(t *testing.T) {
	t.Helper()
	cfg := filepath.Join(e.home, "config")
	if err := os.MkdirAll(cfg, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cfg, "secrets.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// run chạy install.sh của repo với tag ghim (rỗng = không đặt biến), trả
// (stderr+stdout, lỗi thoát).
func (e installShEnv) run(t *testing.T, tag string) (string, error) {
	t.Helper()
	script, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "install.sh"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(script); err != nil {
		t.Fatalf("không thấy install.sh ở gốc repo (%s): %v", script, err)
	}
	cmd := exec.Command("sh", script)
	cmd.Env = []string{
		"PATH=" + e.pathDir + string(os.PathListSeparator) + os.Getenv("PATH"),
		"HOME=" + e.home,
		"GEN_HARNESS_HOME=" + e.home,
		"SHELL=/bin/sh",
		"TMPDIR=" + t.TempDir(),
		"FIXTURES_DIR=" + e.fixtures,
		"CURL_URLS_FILE=" + e.urlsFile,
		"GENH_ARGS_FILE=" + e.argsFile,
	}
	if tag != "" {
		cmd.Env = append(cmd.Env, "GEN_HARNESS_RELEASE_TAG="+tag)
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (e installShEnv) genhArgs(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(e.argsFile)
	if err != nil {
		t.Fatalf("genh giả chưa được gọi (install.sh không exec genh): %v", err)
	}
	return string(b)
}

func (e installShEnv) urls(t *testing.T) string {
	t.Helper()
	b, _ := os.ReadFile(e.urlsFile)
	return string(b)
}

func TestInstallSh_TagSaiDang_TuChoi(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("máy test không có sh")
	}
	for _, tag := range []string{"v1a.2b.3c", "0.1.33", "v0.1", "v0.1.33-", "v0.1.33\nv0.1.34", "v0.1.33;rm"} {
		e := newInstallShEnv(t, true)
		out, err := e.run(t, tag)
		if err == nil {
			t.Fatalf("tag %q sai dạng mà install.sh vẫn chạy tiếp:\n%s", tag, out)
		}
		if !strings.Contains(out, "GEN_HARNESS_RELEASE_TAG không hợp lệ") {
			t.Errorf("tag %q: thiếu lời báo dễ hiểu, được:\n%s", tag, out)
		}
		if e.urls(t) != "" {
			t.Errorf("tag %q sai dạng mà vẫn gọi curl: %q", tag, e.urls(t))
		}
	}
}

func TestInstallSh_TagKhongTonTai_BaoLoiDeHieu(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("máy test không có sh")
	}
	e := newInstallShEnv(t, false) // curl giả trả 404 cho mọi tệp
	out, err := e.run(t, "v9.9.9")
	if err == nil {
		t.Fatalf("tag không tồn tại mà install.sh thoát 0:\n%s", out)
	}
	want := "của bản v9.9.9 (tag không tồn tại hoặc Release thiếu asset)"
	if !strings.Contains(out, want) {
		t.Fatalf("thiếu lời báo %q, được:\n%s", want, out)
	}
}

func TestInstallSh_GhimTag_MayDaCai_KhongTuCapNhatBinary(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("máy test không có sh")
	}
	e := newInstallShEnv(t, true)
	e.markInstalled(t)
	out, err := e.run(t, "v0.1.33-rc.1")
	if err != nil {
		t.Fatalf("install.sh lỗi: %v\n%s", err, out)
	}
	if got := e.genhArgs(t); got != "update --no-self-update" {
		t.Fatalf("máy đã cài + ghim tag: muốn `genh update --no-self-update` (không để selfupdate thay bản ghim bằng latest), được %q", got)
	}
	if !strings.Contains(e.urls(t), "/releases/download/v0.1.33-rc.1/") {
		t.Fatalf("phải tải đúng tag ghim, các URL đã gọi:\n%s", e.urls(t))
	}
}

func TestInstallSh_KhongGhim_MayDaCai_GenhUpdate(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("máy test không có sh")
	}
	e := newInstallShEnv(t, true)
	e.markInstalled(t)
	out, err := e.run(t, "")
	if err != nil {
		t.Fatalf("install.sh lỗi: %v\n%s", err, out)
	}
	if got := e.genhArgs(t); got != "update" {
		t.Fatalf("máy đã cài, không ghim: muốn `genh update`, được %q", got)
	}
	if !strings.Contains(e.urls(t), "/releases/latest/download/") {
		t.Fatalf("không ghim thì phải tải từ releases/latest, các URL đã gọi:\n%s", e.urls(t))
	}
}

func TestInstallSh_GhimTag_MaySach_GenhInstall(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("máy test không có sh")
	}
	e := newInstallShEnv(t, true)
	out, err := e.run(t, "v0.1.33")
	if err != nil {
		t.Fatalf("install.sh lỗi: %v\n%s", err, out)
	}
	if got := e.genhArgs(t); got != "install" {
		t.Fatalf("máy sạch: muốn `genh install`, được %q", got)
	}
}
