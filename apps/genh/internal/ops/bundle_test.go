package ops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

// withBundlePassword đặt GH_BUNDLE_PASSWORD cho thời gian chạy test rồi tự
// gỡ khi xong — dùng để bỏ qua hỏi mật khẩu ẩn (không có TTY thật trong test).
func withBundlePassword(t *testing.T, v string) {
	t.Helper()
	t.Setenv(bundlePasswordEnv, v)
}

// withSecretLines tiêm readSecretLine giả cho một test cần mô phỏng gõ tay
// (mật khẩu ngắn/không khớp) — khôi phục biến gói khi test xong.
func withSecretLines(t *testing.T, lines ...string) {
	t.Helper()
	orig := readSecretLine
	i := 0
	readSecretLine = func() (string, error) {
		if i >= len(lines) {
			t.Fatalf("readSecretLine gọi nhiều hơn %d lần đã chuẩn bị", len(lines))
		}
		v := lines[i]
		i++
		return v, nil
	}
	t.Cleanup(func() { readSecretLine = orig })
}

func TestRunExport_HappyPath_StreamsStdoutToFile(t *testing.T) {
	withBundlePassword(t, "mat-khau-du-dai-123")
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	toPath := filepath.Join(t.TempDir(), "out.ghbundle")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "-e", bundlePasswordEnv, "api", "python", "-m", "gh.bundle", "export", "--out", "-"),
			RunIOStdout: []byte(bundleMagic + "fake-bytes")},
	}}

	var out strings.Builder
	if err := RunExport(context.Background(), env, toPath, ExportDeps{Runner: fr}, &out); err != nil {
		t.Fatalf("RunExport: %v", err)
	}
	data, err := os.ReadFile(toPath)
	if err != nil {
		t.Fatalf("đọc lại %s: %v", toPath, err)
	}
	if string(data) != bundleMagic+"fake-bytes" {
		t.Errorf("nội dung tệp = %q, muốn %q", data, bundleMagic+"fake-bytes")
	}
	if info, err := os.Stat(toPath); err == nil && info.Mode().Perm() != 0o600 {
		t.Errorf("quyền tệp = %o, muốn 0600", info.Mode().Perm())
	}
	// Mật khẩu KHÔNG được xuất hiện trong argv của lệnh đã gọi.
	for _, c := range fr.Calls {
		for _, a := range c.Cmd.Args {
			if strings.Contains(a, "mat-khau-du-dai-123") {
				t.Errorf("mật khẩu lộ vào argv: %v", c.Cmd.Args)
			}
		}
	}
	// Tệp tạm không còn sót lại.
	if _, err := os.Stat(toPath + ".tmp-genh-export"); !os.IsNotExist(err) {
		t.Errorf("tệp tạm phải bị xoá/rename, os.Stat trả err=%v", err)
	}
}

func TestRunExport_PasswordTooShort_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	withSecretLines(t, "curt") // < 12 ký tự, chỉ 1 lần đọc (thất bại trước khi hỏi lại)

	err := RunExport(context.Background(), env, filepath.Join(t.TempDir(), "out.ghbundle"), ExportDeps{Runner: &fake.Runner{}}, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeExportPasswordMismatch {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeExportPasswordMismatch)
	}
}

func TestRunExport_PasswordMismatch_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	withSecretLines(t, "mat-khau-du-dai-123", "mat-khau-khac-han-456")

	err := RunExport(context.Background(), env, filepath.Join(t.TempDir(), "out.ghbundle"), ExportDeps{Runner: &fake.Runner{}}, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeExportPasswordMismatch {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeExportPasswordMismatch)
	}
}

func TestRunExport_ContainerCommandFails_RemovesTmpFile(t *testing.T) {
	withBundlePassword(t, "mat-khau-du-dai-123")
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	toPath := filepath.Join(t.TempDir(), "out.ghbundle")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("gh.bundle", "export"), Err: errors.New("db down")},
	}}

	err := RunExport(context.Background(), env, toPath, ExportDeps{Runner: fr}, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeExportFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeExportFailed)
	}
	if _, statErr := os.Stat(toPath); !os.IsNotExist(statErr) {
		t.Errorf("toPath không được tồn tại khi export lỗi")
	}
	if _, statErr := os.Stat(toPath + ".tmp-genh-export"); !os.IsNotExist(statErr) {
		t.Errorf("tệp tạm phải bị xoá khi export lỗi")
	}
}

// bundleFile dựng một tệp .ghbundle giả hợp lệ (đúng magic) dưới t.TempDir().
func bundleFile(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "in.ghbundle")
	if err := os.WriteFile(path, []byte(bundleMagic+body), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return path
}

const importTestBackupLine = "INFO:gh.backup:Backup mới: backups/20260925T110000Z-c0ffee12.pgcustom.enc (321 byte, CSDL gen_harness)"

func TestRunImport_HappyPath_BacksUpThenImportsThenRestarts(t *testing.T) {
	withBundlePassword(t, "mat-khau-du-dai-123")
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	bundlePath := bundleFile(t, "noi-dung-goi")

	_, port := listenReadyServer(t, true)
	env.Port = port

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{importTestBackupLine}},
		{Match: fake.MatchArgsContain("gh.bundle", "import"), ExitCode: 0},
		{Match: fake.MatchArgsContain("restart", "api", "worker"), Output: []byte("")},
	}}

	var out strings.Builder
	opts := ImportOptions{AutoApprove: true}
	deps := ImportDeps{Runner: fr, Timeout: 200 * time.Millisecond, PollEvery: 5 * time.Millisecond}
	if err := RunImport(context.Background(), env, bundlePath, opts, deps, strings.NewReader(""), &out); err != nil {
		t.Fatalf("RunImport: %v", err)
	}
	if !strings.Contains(out.String(), "backups/20260925T110000Z-c0ffee12.pgcustom.enc") {
		t.Errorf("output phải nêu khoá backup an toàn, được %q", out.String())
	}

	// Stdin của lệnh import phải đúng bytes tệp gói (đọc từ đầu, kể cả magic).
	for _, c := range fr.Calls {
		if fake.MatchArgsContain("gh.bundle", "import")(c.Cmd) {
			want := bundleMagic + "noi-dung-goi"
			if string(c.Stdin) != want {
				t.Errorf("stdin lệnh import = %q, muốn %q", c.Stdin, want)
			}
		}
	}
}

func TestRunImport_Cancelled_WithoutYes(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	bundlePath := bundleFile(t, "x")

	err := RunImport(context.Background(), env, bundlePath, ImportOptions{}, ImportDeps{Runner: &fake.Runner{}}, strings.NewReader("n\n"), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeImportCancelled {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeImportCancelled)
	}
}

func TestRunImport_NotABundle_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	notBundle := filepath.Join(t.TempDir(), "random.txt")
	if err := os.WriteFile(notBundle, []byte("khong-phai-goi"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	err := RunImport(context.Background(), env, notBundle, ImportOptions{AutoApprove: true}, ImportDeps{Runner: &fake.Runner{}}, strings.NewReader(""), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeImportNotBundle {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeImportNotBundle)
	}
}

func TestRunImport_MissingFile_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)

	err := RunImport(context.Background(), env, filepath.Join(t.TempDir(), "khong-ton-tai.ghbundle"), ImportOptions{AutoApprove: true}, ImportDeps{Runner: &fake.Runner{}}, strings.NewReader(""), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeImportNotBundle {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeImportNotBundle)
	}
}

func TestRunImport_WrongPassword_ExitCode2_MapsToClearError(t *testing.T) {
	withBundlePassword(t, "mat-khau-du-dai-123")
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	bundlePath := bundleFile(t, "x")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{importTestBackupLine}},
		{Match: fake.MatchArgsContain("gh.bundle", "import"), ExitCode: 2},
	}}

	err := RunImport(context.Background(), env, bundlePath, ImportOptions{AutoApprove: true}, ImportDeps{Runner: fr}, strings.NewReader(""), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeImportWrongPassword {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeImportWrongPassword)
	}
	if !strings.Contains(opErr.Next, "backups/20260925T110000Z-c0ffee12.pgcustom.enc") {
		t.Errorf("Next phải nhắc khôi phục từ backup an toàn, được %q", opErr.Next)
	}
}

func TestRunImport_Incompatible_ExitCode3_MapsToClearError(t *testing.T) {
	withBundlePassword(t, "mat-khau-du-dai-123")
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	bundlePath := bundleFile(t, "x")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{importTestBackupLine}},
		{Match: fake.MatchArgsContain("gh.bundle", "import"), ExitCode: 3},
	}}

	err := RunImport(context.Background(), env, bundlePath, ImportOptions{AutoApprove: true}, ImportDeps{Runner: fr}, strings.NewReader(""), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeImportIncompatible {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeImportIncompatible)
	}
}

func TestRunImport_BackupFailsFirst_StopsBeforeTouchingAnything(t *testing.T) {
	withBundlePassword(t, "mat-khau-du-dai-123")
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	bundlePath := bundleFile(t, "x")

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Err: errors.New("db down")},
	}}

	err := RunImport(context.Background(), env, bundlePath, ImportOptions{AutoApprove: true}, ImportDeps{Runner: fr}, strings.NewReader(""), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeImportBackupFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeImportBackupFailed)
	}
	for _, c := range fr.Calls {
		if fake.MatchArgsContain("gh.bundle", "import")(c.Cmd) {
			t.Fatalf("KHÔNG được gọi gh.bundle import khi backup an toàn thất bại")
		}
	}
}

var _ dockercli.Runner = (*fake.Runner)(nil)
