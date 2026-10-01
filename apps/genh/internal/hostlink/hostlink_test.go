package hostlink

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// v0.1.33: genh.json mang trạng thái lịch tự cập nhật đêm cho Console (gh/system_api/update.py).
func TestAutoUpdateEnabled(t *testing.T) {
	root := t.TempDir()
	// Không rõ ⇒ không có khoá (api trả null).
	if err := WriteInfo(root, "v0.1.33", "systemd", nil); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(filepath.Join(Dir(root), InfoFile))
	if strings.Contains(string(raw), "auto_update_enabled") {
		t.Fatalf("nil phải bỏ khoá auto_update_enabled: %s", raw)
	}
	off := false
	if err := WriteInfo(root, "v0.1.33", "systemd", &off); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(filepath.Join(Dir(root), InfoFile))
	if !strings.Contains(string(raw), `"auto_update_enabled": false`) {
		t.Fatalf("false phải ghi rõ (không omitempty): %s", raw)
	}
	// auto-update enable: chỉ đổi cờ, giữ version/updater/requests.
	if err := SetAutoUpdate(root, "v9.9.9", true); err != nil {
		t.Fatal(err)
	}
	info, err := ReadInfo(root)
	if err != nil || info.AutoUpdateEnabled == nil || !*info.AutoUpdateEnabled || info.Version != "v0.1.33" ||
		info.Updater != "systemd" || len(info.Requests) != 2 {
		t.Fatalf("SetAutoUpdate(true) = %+v, %v", info, err)
	}
	if err := SetAutoUpdate(root, "v9.9.9", false); err != nil {
		t.Fatal(err)
	}
	if info, _ := ReadInfo(root); info.AutoUpdateEnabled == nil || *info.AutoUpdateEnabled {
		t.Fatalf("SetAutoUpdate(false) = %+v", info)
	}
	// Chưa có genh.json ⇒ ghi mới với version cho trước, chưa có watcher.
	fresh := t.TempDir()
	if err := SetAutoUpdate(fresh, "v0.1.33", true); err != nil {
		t.Fatal(err)
	}
	if info, err := ReadInfo(fresh); err != nil || info.Version != "v0.1.33" || info.Updater != "" ||
		info.AutoUpdateEnabled == nil || !*info.AutoUpdateEnabled {
		t.Fatalf("SetAutoUpdate trên máy chưa có genh.json = %+v, %v", info, err)
	}
}

func TestRoundTrip(t *testing.T) {
	root := t.TempDir()
	if err := WriteInfo(root, "v0.1.17", "systemd", nil); err != nil {
		t.Fatal(err)
	}
	info, err := ReadInfo(root)
	if err != nil || info.Version != "v0.1.17" || info.Updater != "systemd" {
		t.Fatalf("info = %+v, %v", info, err)
	}
	st, _ := os.Stat(Dir(root))
	if st.Mode().Perm() != 0o777 {
		t.Fatalf("run dir perm = %v, want 0777 (api container ghi yêu cầu)", st.Mode().Perm())
	}

	if HasRequest(root) || ConsumeRequest(root) {
		t.Fatal("chưa có yêu cầu mà HasRequest/ConsumeRequest báo có")
	}
	if err := os.WriteFile(RequestPath(root), []byte(`{"requested_at":"x"}`), 0o666); err != nil {
		t.Fatal(err)
	}
	if !HasRequest(root) || !ConsumeRequest(root) || HasRequest(root) {
		t.Fatal("ConsumeRequest phải báo có rồi xoá tệp yêu cầu")
	}

	if err := Start(root, "v0.1.16"); err != nil {
		t.Fatal(err)
	}
	if err := Finish(root, "done", "v0.1.17", "xong"); err != nil {
		t.Fatal(err)
	}
	s, err := ReadStatus(root)
	if err != nil || s.State != "done" || s.From != "v0.1.16" || s.To != "v0.1.17" || s.StartedAt == "" || s.FinishedAt == "" {
		t.Fatalf("status = %+v, %v", s, err)
	}
}

func TestRestoreRequestRoundTrip(t *testing.T) {
	root := t.TempDir()
	if err := WriteInfo(root, "v0.1.20", "cron", nil); err != nil {
		t.Fatal(err)
	}
	if info, _ := ReadInfo(root); len(info.Requests) != 2 || info.Requests[1] != "restore" {
		t.Fatalf("genh.json phải báo watcher nhận cả update lẫn restore: %+v", info)
	}
	if err := WriteInfo(root, "v0.1.20", "", nil); err != nil {
		t.Fatal(err)
	}
	if info, _ := ReadInfo(root); len(info.Requests) != 0 {
		t.Fatalf("chưa có watcher thì không báo loại yêu cầu nào: %+v", info)
	}

	if HasRestoreRequest(root) {
		t.Fatal("chưa có yêu cầu khôi phục")
	}
	if _, err := ConsumeRestoreRequest(root); err == nil {
		t.Fatal("không có tệp thì phải lỗi")
	}
	key := "backups/20260929T010203Z-abcdef12.pgcustom.enc"
	if err := os.WriteFile(RestoreRequestPath(root), []byte(`{"id":"r1","key":"`+key+`"}`), 0o666); err != nil {
		t.Fatal(err)
	}
	if !HasRestoreRequest(root) {
		t.Fatal("phải thấy yêu cầu khôi phục")
	}
	req, err := ConsumeRestoreRequest(root)
	if err != nil || req.Key != key || HasRestoreRequest(root) {
		t.Fatalf("ConsumeRestoreRequest = %+v, %v (phải xoá tệp)", req, err)
	}
	// Tệp hỏng: vẫn bị xoá để watcher không kích lặp.
	_ = os.WriteFile(RestoreRequestPath(root), []byte(`{"key":""}`), 0o666)
	if _, err := ConsumeRestoreRequest(root); err == nil || HasRestoreRequest(root) {
		t.Fatal("yêu cầu thiếu khoá phải lỗi và bị xoá")
	}

	if err := StartRestore(root, key); err != nil {
		t.Fatal(err)
	}
	if err := FinishRestore(root, "done", "backups/safe.enc", ""); err != nil {
		t.Fatal(err)
	}
	s, err := ReadRestoreStatus(root)
	if err != nil || s.State != "done" || s.Key != key || s.SafetyKey != "backups/safe.enc" || s.StartedAt == "" || s.FinishedAt == "" {
		t.Fatalf("restore status = %+v, %v", s, err)
	}
}

func TestPendingDispatch(t *testing.T) {
	root := t.TempDir()
	if err := EnsureDir(root); err != nil {
		t.Fatal(err)
	}
	if got := Pending(root); got != "" {
		t.Fatalf("hộp thư trống, Pending = %q", got)
	}
	_ = os.WriteFile(RestoreRequestPath(root), []byte(`{"key":"k"}`), 0o666)
	if got := Pending(root); got != "restore" {
		t.Fatalf("Pending = %q, muốn restore", got)
	}
	_ = os.WriteFile(RequestPath(root), []byte(`{}`), 0o666)
	if got := Pending(root); got != "update" {
		t.Fatalf("có cả hai thì cập nhật trước, Pending = %q", got)
	}
}
