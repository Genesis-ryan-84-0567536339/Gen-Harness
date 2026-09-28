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
