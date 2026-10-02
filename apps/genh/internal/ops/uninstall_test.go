package ops

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/autoupdate"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/hostlink"
)

// fakeOffsiteScheduler ghi lại lời gọi bật/tắt lịch tuần (không đụng systemd/cron thật).
type fakeOffsiteScheduler struct {
	enabled   bool
	mechanism string
	enableErr error
	enables   int
	disables  int
}

func (f *fakeOffsiteScheduler) Enable(context.Context) (string, string, error) {
	f.enables++
	if f.enableErr != nil {
		return "", "", f.enableErr
	}
	f.enabled = true
	if f.mechanism == "" {
		f.mechanism = autoupdate.ScheduleCron
	}
	return "Đã bật lịch sao lưu ra ổ ngoài mỗi Chủ nhật ~05:30 (giả)", f.mechanism, nil
}

func (f *fakeOffsiteScheduler) Disable(context.Context) (string, error) {
	f.disables++
	f.enabled = false
	return "Đã tắt lịch sao lưu ra ổ ngoài hằng tuần.", nil
}

func (f *fakeOffsiteScheduler) Status(context.Context) (autoupdate.OffsiteScheduleStatus, error) {
	if !f.enabled {
		return autoupdate.OffsiteScheduleStatus{Detail: "chưa bật"}, nil
	}
	return autoupdate.OffsiteScheduleStatus{Enabled: true, Mechanism: f.mechanism, Detail: "giả"}, nil
}

func hasVolumes(args []string) bool {
	for _, a := range args {
		if a == "--volumes" {
			return true
		}
	}
	return false
}

func downRunner() *fake.Runner {
	return &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("down"), Output: []byte("")}}}
}

// v0.1.40: mặc định GIỮ dữ liệu — không có --volumes; gỡ luôn lịch tuần offsite.
func TestRunUninstall_MacDinh_GiuDuLieu_KhongVolumes(t *testing.T) {
	env := testEnv(t, testComposePath(t, ""))
	fr := downRunner()
	sched := &fakeOffsiteScheduler{enabled: true, mechanism: "cron"}
	var out strings.Builder
	if err := RunUninstall(context.Background(), env, UninstallOptions{AutoApprove: true, Offsite: sched}, fr, strings.NewReader(""), &out); err != nil {
		t.Fatalf("RunUninstall: %v", err)
	}
	if len(fr.Calls) != 1 || hasVolumes(fr.Calls[0].Cmd.Args) {
		t.Fatalf("mặc định KHÔNG được --volumes, calls=%+v", fr.Calls)
	}
	if sched.disables != 1 {
		t.Fatalf("uninstall phải gỡ lịch tuần offsite (Disable gọi %d lần)", sched.disables)
	}
	if strings.Contains(out.String(), "Chưa có bản sao ngoài máy gần đây") {
		t.Fatal("giữ dữ liệu thì không cần cảnh báo bản sao ngoài máy")
	}
}

// --keep-data vẫn hợp lệ (script cũ) — giữ dữ liệu như mặc định.
func TestRunUninstall_KeepData_VanHopLe(t *testing.T) {
	env := testEnv(t, testComposePath(t, ""))
	fr := downRunner()
	if err := RunUninstall(context.Background(), env, UninstallOptions{KeepData: true, AutoApprove: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(""), &strings.Builder{}); err != nil {
		t.Fatalf("RunUninstall: %v", err)
	}
	if hasVolumes(fr.Calls[0].Cmd.Args) {
		t.Errorf("không được truyền --volumes khi --keep-data, args=%v", fr.Calls[0].Cmd.Args)
	}
}

// --delete-data --yes (CI): có --volumes; chưa có bản sao ngoài máy gần đây → cảnh báo đỏ.
func TestRunUninstall_DeleteData_Yes_CoVolumesVaCanhBao(t *testing.T) {
	env := testEnv(t, testComposePath(t, ""))
	fr := downRunner()
	var out strings.Builder
	if err := RunUninstall(context.Background(), env, UninstallOptions{DeleteData: true, AutoApprove: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(""), &out); err != nil {
		t.Fatalf("RunUninstall: %v", err)
	}
	if !hasVolumes(fr.Calls[0].Cmd.Args) {
		t.Errorf("--delete-data phải truyền --volumes, args=%v", fr.Calls[0].Cmd.Args)
	}
	if !strings.Contains(out.String(), "Chưa có bản sao ngoài máy gần đây") || !strings.Contains(out.String(), ansiRed) {
		t.Fatalf("thiếu cảnh báo đỏ:\n%s", out.String())
	}

	// Có bản sao thành công 2 ngày trước → không cảnh báo.
	now := time.Date(2026, 10, 4, 6, 0, 0, 0, time.UTC)
	if err := hostlink.WriteOffsiteStatus(env.InstallDir, hostlink.OffsiteStatus{State: "ok", LastSuccessAt: "2026-10-02T05:40:00Z"}); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := RunUninstall(context.Background(), env, UninstallOptions{DeleteData: true, AutoApprove: true, Offsite: &fakeOffsiteScheduler{}, Now: func() time.Time { return now }},
		downRunner(), strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out.String(), "Chưa có bản sao ngoài máy gần đây") {
		t.Fatalf("có bản sao 2 ngày trước thì không cảnh báo:\n%s", out.String())
	}
	// Quá 7 ngày → cảnh báo lại.
	out.Reset()
	later := func() time.Time { return now.Add(9 * 24 * time.Hour) }
	if err := RunUninstall(context.Background(), env, UninstallOptions{DeleteData: true, AutoApprove: true, Offsite: &fakeOffsiteScheduler{}, Now: later},
		downRunner(), strings.NewReader(""), &out); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "Chưa có bản sao ngoài máy gần đây") {
		t.Fatalf("bản sao 11 ngày trước phải cảnh báo:\n%s", out.String())
	}
}

// --delete-data KHÔNG --yes: phải gõ đúng "XOÁ DỮ LIỆU"; gõ "y" là huỷ.
func TestRunUninstall_DeleteData_PhaiGoDungCumTu(t *testing.T) {
	env := testEnv(t, testComposePath(t, ""))
	for _, typed := range []string{"y\n", "yes\n", "xoá dữ liệu\n", "\n"} {
		fr := &fake.Runner{}
		err := RunUninstall(context.Background(), env, UninstallOptions{DeleteData: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(typed), &strings.Builder{})
		var opErr *OpError
		if !errors.As(err, &opErr) || opErr.Code != ErrCodeUninstallCancelled || len(fr.Calls) != 0 {
			t.Fatalf("gõ %q phải huỷ, không gọi docker: err=%v calls=%d", typed, err, len(fr.Calls))
		}
	}
	for _, typed := range []string{"XOÁ DỮ LIỆU\n", "  XÓA DỮ LIỆU  \n"} {
		fr := downRunner()
		if err := RunUninstall(context.Background(), env, UninstallOptions{DeleteData: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(typed), &strings.Builder{}); err != nil {
			t.Fatalf("gõ %q phải chạy: %v", typed, err)
		}
		if !hasVolumes(fr.Calls[0].Cmd.Args) {
			t.Fatalf("đã xác nhận xoá dữ liệu phải có --volumes: %v", fr.Calls[0].Cmd.Args)
		}
	}
}

func TestRunUninstall_KeepVaDeleteMauThuan(t *testing.T) {
	env := testEnv(t, testComposePath(t, ""))
	fr := &fake.Runner{}
	err := RunUninstall(context.Background(), env, UninstallOptions{DeleteData: true, KeepData: true, AutoApprove: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(""), &strings.Builder{})
	var opErr *OpError
	if !errors.As(err, &opErr) || len(fr.Calls) != 0 {
		t.Fatalf("hai cờ mâu thuẫn phải dừng trước khi gọi docker: %v", err)
	}
}

func TestRunUninstall_NoConfirmation_Cancels_DoesNotCallDown(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{}
	sched := &fakeOffsiteScheduler{}

	err := RunUninstall(context.Background(), env, UninstallOptions{Offsite: sched}, fr, strings.NewReader("n\n"), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUninstallCancelled {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUninstallCancelled)
	}
	if len(fr.Calls) != 0 || sched.disables != 0 {
		t.Error("không được gọi docker compose down / gỡ lịch khi huỷ xác nhận")
	}
	// Giữ dữ liệu (mặc định): "y" là đủ.
	fr2 := downRunner()
	if err := RunUninstall(context.Background(), env, UninstallOptions{Offsite: sched}, fr2, strings.NewReader("y\n"), &strings.Builder{}); err != nil {
		t.Fatalf("giữ dữ liệu + y phải chạy: %v", err)
	}
}

func TestRunUninstall_DownFails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("down"), Err: errors.New("boom")}}}

	err := RunUninstall(context.Background(), env, UninstallOptions{AutoApprove: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(""), &strings.Builder{})
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
	fr := downRunner()

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
	if err := RunUninstall(context.Background(), env, UninstallOptions{AutoApprove: true, Offsite: &fakeOffsiteScheduler{}}, fr, strings.NewReader(""), &out); err != nil {
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
