package ops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

const fakeBackupLogLine = "INFO:gh.backup:Backup mới: backups/20260925T120000Z-abcd1234.pgcustom.enc (123 byte, CSDL gen_harness)"

func TestRunBackup_HappyPath_ParsesKeyFromLog(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{fakeBackupLogLine}},
	}}

	var out strings.Builder
	if err := RunBackup(context.Background(), env, "", fr, &out); err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	if !strings.Contains(out.String(), "backups/20260925T120000Z-abcd1234.pgcustom.enc") {
		t.Errorf("output phải chứa khoá backup, được %q", out.String())
	}
}

func TestRunBackup_ContainerCommandFails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Err: errors.New("db down")},
	}}

	err := RunBackup(context.Background(), env, "", fr, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeBackupFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeBackupFailed)
	}
}

func TestRunBackup_WithToPath_CopiesBytesToHost(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	toPath := filepath.Join(t.TempDir(), "out.enc")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{fakeBackupLogLine}},
		{Match: fake.MatchArgsContain("python", "-c"), Output: []byte("fake-encrypted-bytes")},
	}}

	if err := RunBackup(context.Background(), env, toPath, fr, &strings.Builder{}); err != nil {
		t.Fatalf("RunBackup: %v", err)
	}
	data, err := os.ReadFile(toPath)
	if err != nil {
		t.Fatalf("đọc lại %s: %v", toPath, err)
	}
	if string(data) != "fake-encrypted-bytes" {
		t.Errorf("nội dung ghi ra host = %q, muốn %q", data, "fake-encrypted-bytes")
	}
}

func TestRunRestore_HappyPath_ByKey(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "restore", "--key", "backups/x.enc"), Output: []byte("")},
	}}

	var out strings.Builder
	if err := RunRestore(context.Background(), env, "backups/x.enc", fr, &out); err != nil {
		t.Fatalf("RunRestore: %v", err)
	}
	if !strings.Contains(out.String(), "backups/x.enc") {
		t.Errorf("output phải xác nhận khoá đã khôi phục, được %q", out.String())
	}
}

func TestRunRestore_ArbitraryHostFile_ReturnsClearLimitationError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	hostFile := filepath.Join(t.TempDir(), "some-backup.enc")
	if err := os.WriteFile(hostFile, []byte("data"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	err := RunRestore(context.Background(), env, hostFile, &fake.Runner{}, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeRestoreFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeRestoreFailed)
	}
	if !strings.Contains(opErr.Why, "backup.py::restore_backup()") && !strings.Contains(opErr.Why, "restore_backup()") {
		t.Errorf("Why phải giải thích giới hạn restore_backup(), được %q", opErr.Why)
	}
}

func TestRunRestore_ContainerCommandFails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("restore", "--key"), Err: errors.New("khoá không tồn tại")},
	}}

	err := RunRestore(context.Background(), env, "backups/missing.enc", fr, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeRestoreFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeRestoreFailed)
	}
}
