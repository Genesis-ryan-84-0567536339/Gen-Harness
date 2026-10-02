package ops

import (
	"archive/zip"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

func TestRunDoctor_HappyPath_WritesZipWithReportAndLogs(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	outPath := filepath.Join(t.TempDir(), "report.zip")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("version", "--format"), Output: []byte("27.1.0")},
		{Match: fake.MatchArgsContain("system", "df", "-v"), Output: []byte("VOLUME NAME\ngen-harness_pg_data 1 10MB\n")},
		{Match: fake.MatchArgsContain("logs", "--tail=500"), Output: []byte("api log line 1\ndb log line 1\n")},
	}}

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"db": "ok", "redis": "ok", "objects": "skip", "bridge": "ok"})
	}))
	defer srv.Close()

	deps := DoctorDeps{
		Runner: fr,
		Client: srv.Client(),
		DialTCP: func(address string, timeout time.Duration) error {
			return nil
		},
		DialTLS: func(address string, timeout time.Duration) (string, time.Time, error) {
			return "CN=Gen-Harness Local CA", time.Now().Add(24 * time.Hour), nil
		},
	}

	var out strings.Builder
	if err := RunDoctor(context.Background(), env, outPath, deps, &out); err != nil {
		t.Fatalf("RunDoctor: %v", err)
	}

	if !strings.Contains(out.String(), "Docker runtime") {
		t.Errorf("output thiếu mục Docker runtime: %s", out.String())
	}

	zr, err := zip.OpenReader(outPath)
	if err != nil {
		t.Fatalf("mở zip báo cáo: %v", err)
	}
	defer func() { _ = zr.Close() }()

	names := map[string]bool{}
	for _, f := range zr.File {
		names[f.Name] = true
	}
	if !names["report.txt"] || !names["logs.txt"] {
		t.Fatalf("zip phải có report.txt và logs.txt, được %v", names)
	}
}

func TestRunDoctor_PortDialFails_ReportedButNotFatal(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	outPath := filepath.Join(t.TempDir(), "report.zip")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("version", "--format"), Output: []byte("27.1.0")},
		{Match: fake.MatchArgsContain("system", "df", "-v"), Output: []byte("")},
		{Match: fake.MatchArgsContain("logs", "--tail=500"), Output: []byte("")},
	}}

	deps := DoctorDeps{
		Runner:  fr,
		DialTCP: func(address string, timeout time.Duration) error { return errors.New("connection refused") },
		DialTLS: func(address string, timeout time.Duration) (string, time.Time, error) {
			return "", time.Time{}, errors.New("connection refused")
		},
	}

	var out strings.Builder
	// RunDoctor KHÔNG được trả lỗi chỉ vì cổng/TLS không kết nối được — đó
	// là một MỤC chẩn đoán thất bại (✕), không phải lỗi của chính lệnh
	// doctor (báo cáo vẫn phải xuất ra để Owner gửi hỗ trợ).
	if err := RunDoctor(context.Background(), env, outPath, deps, &out); err != nil {
		t.Fatalf("RunDoctor không được trả lỗi khi một mục chẩn đoán thất bại: %v", err)
	}
	if !strings.Contains(out.String(), "✕") {
		t.Errorf("output phải đánh dấu ✕ cho mục cổng/TLS thất bại: %s", out.String())
	}
}

func TestRunDoctor_ZipWriteFails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	// Đường dẫn đích là một thư mục có thật (t.TempDir()), không phải tên
	// tệp — os.Create sẽ lỗi "is a directory".
	outPath := t.TempDir()

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("version", "--format"), Output: []byte("27.1.0")},
		{Match: fake.MatchArgsContain("system", "df", "-v"), Output: []byte("")},
		{Match: fake.MatchArgsContain("logs", "--tail=500"), Output: []byte("")},
	}}
	deps := DoctorDeps{
		Runner:  fr,
		DialTCP: func(string, time.Duration) error { return nil },
		DialTLS: func(string, time.Duration) (string, time.Time, error) { return "", time.Time{}, nil },
	}

	err := RunDoctor(context.Background(), env, outPath, deps, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T (%v)", err, err)
	}
	if opErr.Code != ErrCodeDoctorReportFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeDoctorReportFailed)
	}
}

// v0.1.36 (F-4): log trong báo cáo doctor phải có dấu thời gian (`docker compose logs -t --tail=500`).
func TestRunDoctor_LogsHaveTimestamps(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	outPath := filepath.Join(t.TempDir(), "report.zip")

	logsMatch := fake.MatchArgsContain("logs", "-t", "--tail=500")
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("version", "--format"), Output: []byte("27.1.0")},
		{Match: fake.MatchArgsContain("system", "df", "-v"), Output: []byte("")},
		{Match: logsMatch, Output: []byte("api  | 2026-10-02T01:02:03.000000000Z dòng có giờ\n")},
	}}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{"db": "ok", "redis": "ok", "objects": "skip", "bridge": "ok"})
	}))
	defer srv.Close()
	deps := DoctorDeps{
		Runner:  fr,
		Client:  srv.Client(),
		DialTCP: func(address string, timeout time.Duration) error { return nil },
		DialTLS: func(address string, timeout time.Duration) (string, time.Time, error) {
			return "CN=Gen-Harness Local CA", time.Now().Add(24 * time.Hour), nil
		},
	}
	var out strings.Builder
	if err := RunDoctor(context.Background(), env, outPath, deps, &out); err != nil {
		t.Fatalf("RunDoctor: %v", err)
	}

	found := false
	for _, c := range fr.Calls {
		if logsMatch(c.Cmd) {
			found = true
		}
	}
	if !found {
		t.Fatalf("doctor phải gọi `docker compose logs -t --tail=500`, các lệnh đã gọi: %v", fr.Calls)
	}

	zr, err := zip.OpenReader(outPath)
	if err != nil {
		t.Fatalf("mở zip báo cáo: %v", err)
	}
	defer func() { _ = zr.Close() }()
	for _, f := range zr.File {
		if f.Name != "logs.txt" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("mở logs.txt: %v", err)
		}
		b, _ := io.ReadAll(rc)
		_ = rc.Close()
		if !strings.Contains(string(b), "2026-10-02T01:02:03") {
			t.Fatalf("logs.txt thiếu dấu thời gian: %q", b)
		}
		return
	}
	t.Fatal("zip thiếu logs.txt")
}
