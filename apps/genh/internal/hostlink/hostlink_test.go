package hostlink

import (
	"os"
	"testing"
)

func TestRoundTrip(t *testing.T) {
	root := t.TempDir()
	if err := WriteInfo(root, "v0.1.17", "systemd"); err != nil {
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
	if err := WriteInfo(root, "v0.1.20", "cron"); err != nil {
		t.Fatal(err)
	}
	if info, _ := ReadInfo(root); len(info.Requests) != 2 || info.Requests[1] != "restore" {
		t.Fatalf("genh.json phải báo watcher nhận cả update lẫn restore: %+v", info)
	}
	if err := WriteInfo(root, "v0.1.20", ""); err != nil {
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
