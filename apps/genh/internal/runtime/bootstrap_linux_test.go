//go:build linux

package runtime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

func TestDockerArchName(t *testing.T) {
	if got := dockerArchName("amd64"); got != "x86_64" {
		t.Errorf("amd64 -> %q, muốn x86_64", got)
	}
	if got := dockerArchName("arm64"); got != "aarch64" {
		t.Errorf("arm64 -> %q, muốn aarch64", got)
	}
}

func TestStaticDownloadURL(t *testing.T) {
	got := StaticDownloadURL("https://download.docker.com", "amd64", "27.3.1")
	want := "https://download.docker.com/linux/static/stable/x86_64/docker-27.3.1.tgz"
	if got != want {
		t.Errorf("StaticDownloadURL = %q, muốn %q", got, want)
	}
}

// fakeTarGz trả về nội dung .tar.gz hợp lệ, tối giản (chỉ đủ để
// ExtractTarGz chạy qua, không cần binary docker thật).
func fakeTarGz(t *testing.T) []byte {
	t.Helper()
	return buildTarGz(t, map[string]string{
		"docker/docker":                        "fake-docker-binary",
		"docker/dockerd":                       "fake-dockerd-binary",
		"docker/dockerd-rootless-setuptool.sh": "#!/bin/sh\necho ok\n",
	}, 0o755)
}

// newBootstrapTestServer dựng một httptest.Server đóng vai download.docker.com:
// phục vụ đúng 2 tarball (chính + rootless-extras) và một SHA256SUMS khớp.
func newBootstrapTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	tarball := fakeTarGz(t)
	sum := sha256.Sum256(tarball)
	sumHex := hex.EncodeToString(sum[:])

	mainName := "docker-27.3.1.tgz"
	extrasName := "docker-rootless-extras-27.3.1.tgz"
	checksums := sumHex + "  " + mainName + "\n" + sumHex + "  " + extrasName + "\n"

	mux := http.NewServeMux()
	mux.HandleFunc("/linux/static/stable/x86_64/SHA256SUMS", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(checksums))
	})
	mux.HandleFunc("/linux/static/stable/x86_64/"+mainName, func(w http.ResponseWriter, r *http.Request) {
		w.Write(tarball)
	})
	mux.HandleFunc("/linux/static/stable/x86_64/"+extrasName, func(w http.ResponseWriter, r *http.Request) {
		w.Write(tarball)
	})
	srv := httptest.NewServer(mux)
	return srv, sumHex
}

func TestBootstrap_DownloadsExtractsAndStopsWithoutAutoApprove(t *testing.T) {
	srv, _ := newBootstrapTestServer(t)
	defer srv.Close()

	dir := t.TempDir()
	opts := BootstrapOptions{
		RuntimeDir:  filepath.Join(dir, "runtime"),
		GOARCH:      "amd64",
		BaseURL:     srv.URL,
		Version:     "27.3.1",
		HTTP:        srv.Client(),
		AutoApprove: false,
	}

	out, err := Bootstrap(context.Background(), opts)
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	if !out.Installed {
		t.Error("Installed phải true sau khi tải+giải nén xong")
	}
	if out.ServiceStarted {
		t.Error("ServiceStarted phải false khi AutoApprove=false")
	}
	if out.ManualNextSteps == "" {
		t.Error("phải có hướng dẫn thủ công khi chưa tự chạy setuptool")
	}
	if !strings.Contains(out.ManualNextSteps, "dockerd-rootless-setuptool.sh") {
		t.Errorf("hướng dẫn phải nhắc tới dockerd-rootless-setuptool.sh, được: %s", out.ManualNextSteps)
	}

	binPath := filepath.Join(opts.RuntimeDir, "docker", "docker")
	if _, err := os.Stat(binPath); err != nil {
		t.Errorf("docker binary phải được giải nén tại %s: %v", binPath, err)
	}
}

func TestBootstrap_Idempotent_SkipsRedownloadOnSecondRun(t *testing.T) {
	srv, _ := newBootstrapTestServer(t)
	defer srv.Close()

	dir := t.TempDir()
	opts := BootstrapOptions{
		RuntimeDir: filepath.Join(dir, "runtime"),
		GOARCH:     "amd64",
		BaseURL:    srv.URL,
		Version:    "27.3.1",
		HTTP:       srv.Client(),
	}

	if _, err := Bootstrap(context.Background(), opts); err != nil {
		t.Fatalf("Bootstrap lần 1: %v", err)
	}

	// Lần 2: tắt máy chủ HTTP giả — nếu Bootstrap cố tải lại sẽ lỗi ngay,
	// nên Run thành công chứng minh nó nhận ra đã cài xong (marker) và bỏ qua.
	srv.Close()

	out, err := Bootstrap(context.Background(), opts)
	if err != nil {
		t.Fatalf("Bootstrap lần 2 (idempotent) phải không lỗi dù mạng đã tắt: %v", err)
	}
	if !out.Installed {
		t.Error("Installed phải true ở lần chạy lại")
	}
}

func TestBootstrap_ChecksumMismatch_Fails(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/linux/static/stable/x86_64/SHA256SUMS", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("0000000000000000000000000000000000000000000000000000000000000000  docker-27.3.1.tgz\n"))
	})
	mux.HandleFunc("/linux/static/stable/x86_64/docker-27.3.1.tgz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("noi dung khong khop checksum"))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	dir := t.TempDir()
	_, err := Bootstrap(context.Background(), BootstrapOptions{
		RuntimeDir: filepath.Join(dir, "runtime"),
		GOARCH:     "amd64",
		BaseURL:    srv.URL,
		Version:    "27.3.1",
		HTTP:       srv.Client(),
	})
	if err == nil {
		t.Fatal("muốn lỗi khi checksum không khớp")
	}
	if !strings.Contains(err.Error(), "khớp") && !strings.Contains(err.Error(), "checksum") {
		t.Errorf("lỗi phải nói rõ về checksum, được: %v", err)
	}
}

func TestBootstrap_AutoApprove_RunsSetupTool(t *testing.T) {
	srv, _ := newBootstrapTestServer(t)
	defer srv.Close()

	dir := t.TempDir()
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("install"), Output: []byte("ok\n")},
	}}

	out, err := Bootstrap(context.Background(), BootstrapOptions{
		RuntimeDir:  filepath.Join(dir, "runtime"),
		GOARCH:      "amd64",
		BaseURL:     srv.URL,
		Version:     "27.3.1",
		HTTP:        srv.Client(),
		Runner:      fr,
		AutoApprove: true,
	})
	if err != nil {
		t.Fatalf("Bootstrap: %v", err)
	}
	if !out.ServiceStarted {
		t.Error("ServiceStarted phải true khi AutoApprove=true và setuptool chạy thành công")
	}
	if len(fr.Calls) != 1 {
		t.Fatalf("muốn đúng 1 lệnh gọi tới Runner, được %d", len(fr.Calls))
	}
	if !strings.HasSuffix(fr.Calls[0].Cmd.Name, "dockerd-rootless-setuptool.sh") {
		t.Errorf("lệnh gọi phải là dockerd-rootless-setuptool.sh, được %q", fr.Calls[0].Cmd.Name)
	}
}

func TestBootstrap_AutoApprove_SetupToolFails_ReturnsManualSteps(t *testing.T) {
	srv, _ := newBootstrapTestServer(t)
	defer srv.Close()

	dir := t.TempDir()
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("install"), Err: errors.New("newuidmap: setuid bit is not set")},
	}}

	out, err := Bootstrap(context.Background(), BootstrapOptions{
		RuntimeDir:  filepath.Join(dir, "runtime"),
		GOARCH:      "amd64",
		BaseURL:     srv.URL,
		Version:     "27.3.1",
		HTTP:        srv.Client(),
		Runner:      fr,
		AutoApprove: true,
	})
	if err == nil {
		t.Fatal("muốn lỗi khi setuptool thất bại")
	}
	if out == nil || out.ManualNextSteps == "" {
		t.Error("phải trả hướng dẫn thủ công kể cả khi lỗi")
	}
}

var _ dockercli.Runner = (*fake.Runner)(nil)
