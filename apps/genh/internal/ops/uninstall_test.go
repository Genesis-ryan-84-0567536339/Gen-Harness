package ops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

func TestRunUninstall_AutoApprove_KeepData_DoesNotPassVolumesFlag(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("down"), Output: []byte("")}}}

	if err := RunUninstall(context.Background(), env, UninstallOptions{KeepData: true, AutoApprove: true}, fr, strings.NewReader(""), &strings.Builder{}); err != nil {
		t.Fatalf("RunUninstall: %v", err)
	}
	if len(fr.Calls) != 1 {
		t.Fatalf("Calls = %d, muốn 1", len(fr.Calls))
	}
	for _, a := range fr.Calls[0].Cmd.Args {
		if a == "--volumes" {
			t.Errorf("không được truyền --volumes khi --keep-data, args=%v", fr.Calls[0].Cmd.Args)
		}
	}
}

func TestRunUninstall_AutoApprove_WithoutKeepData_PassesVolumesFlag(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("down"), Output: []byte("")}}}

	if err := RunUninstall(context.Background(), env, UninstallOptions{AutoApprove: true}, fr, strings.NewReader(""), &strings.Builder{}); err != nil {
		t.Fatalf("RunUninstall: %v", err)
	}
	found := false
	for _, a := range fr.Calls[0].Cmd.Args {
		if a == "--volumes" {
			found = true
		}
	}
	if !found {
		t.Errorf("phải truyền --volumes khi không có --keep-data, args=%v", fr.Calls[0].Cmd.Args)
	}
}

func TestRunUninstall_NoConfirmation_Cancels_DoesNotCallDown(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{}

	err := RunUninstall(context.Background(), env, UninstallOptions{}, fr, strings.NewReader("n\n"), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUninstallCancelled {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUninstallCancelled)
	}
	if len(fr.Calls) != 0 {
		t.Error("không được gọi docker compose down khi huỷ xác nhận")
	}
}

func TestRunUninstall_DownFails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("down"), Err: errors.New("boom")}}}

	err := RunUninstall(context.Background(), env, UninstallOptions{AutoApprove: true}, fr, strings.NewReader(""), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUninstallFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUninstallFailed)
	}
}

func TestRunUninstall_RemovesShortcutAndPathLine_Linux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("chỉ kiểm đường dẫn lối tắt/PATH thật trên GOOS=linux")
	}
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("down"), Output: []byte("")}}}

	fakeHome := t.TempDir()
	t.Setenv("HOME", fakeHome)
	t.Setenv("SHELL", "/bin/bash")

	// Lối tắt "đã có" từ một lần genh install trước đó.
	shortcutDir := filepath.Join(fakeHome, ".local", "share", "applications")
	if err := os.MkdirAll(shortcutDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	shortcutPath := filepath.Join(shortcutDir, "gen-harness.desktop")
	if err := os.WriteFile(shortcutPath, []byte("[Desktop Entry]\n"), 0o644); err != nil {
		t.Fatalf("WriteFile shortcut: %v", err)
	}

	// .bashrc "đã có" dòng PATH mà install.sh thêm.
	rcPath := filepath.Join(fakeHome, ".bashrc")
	rcContent := "existing line 1\n\n# Gen-Harness (genh)\nexport PATH=\"" + fakeHome + "/.gen-harness/bin:$PATH\"\nexisting line 2\n"
	if err := os.WriteFile(rcPath, []byte(rcContent), 0o644); err != nil {
		t.Fatalf("WriteFile rc: %v", err)
	}

	var out strings.Builder
	if err := RunUninstall(context.Background(), env, UninstallOptions{AutoApprove: true}, fr, strings.NewReader(""), &out); err != nil {
		t.Fatalf("RunUninstall: %v", err)
	}

	if _, err := os.Stat(shortcutPath); !os.IsNotExist(err) {
		t.Errorf("lối tắt %s phải bị xoá, err=%v", shortcutPath, err)
	}

	gotRC, err := os.ReadFile(rcPath)
	if err != nil {
		t.Fatalf("đọc lại %s: %v", rcPath, err)
	}
	if strings.Contains(string(gotRC), "Gen-Harness") {
		t.Errorf("rc file vẫn còn dòng Gen-Harness sau uninstall: %q", gotRC)
	}
	if !strings.Contains(string(gotRC), "existing line 1") || !strings.Contains(string(gotRC), "existing line 2") {
		t.Errorf("rc file phải giữ nguyên các dòng khác, được %q", gotRC)
	}
}
