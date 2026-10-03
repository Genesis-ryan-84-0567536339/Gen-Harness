package ops

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

func TestRunStop_HappyPath(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("stop"), Output: []byte("")}}}

	var out strings.Builder
	if err := RunStop(context.Background(), env, fr, &out); err != nil {
		t.Fatalf("RunStop: %v", err)
	}
	if len(fr.Calls) != 1 {
		t.Fatalf("Calls = %d, muốn 1", len(fr.Calls))
	}
}

func TestRunStop_Fails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("stop"), Err: errors.New("boom")}}}

	err := RunStop(context.Background(), env, fr, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeStopFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeStopFailed)
	}
}

func TestRunStart_HappyPath(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")}}}

	var out strings.Builder
	if err := RunStart(context.Background(), env, fr, &out); err != nil {
		t.Fatalf("RunStart: %v", err)
	}
}

func TestRunStart_Fails_ReturnsOpError(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	fr := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("boom")}}}

	err := RunStart(context.Background(), env, fr, &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeStartFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeStartFailed)
	}
}

// v0.1.44 (F-6b): genh stop ghi đánh dấu "Owner chủ động dừng" (trực canh không
// tự khởi động lại), genh start xoá; stop lỗi thì không ghi.
func TestStopStart_DanhDauTamDung(t *testing.T) {
	composePath := testComposePath(t, "")
	env := testEnv(t, composePath)
	bad := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("stop"), Err: errors.New("boom")}}}
	_ = RunStop(context.Background(), env, bad, &strings.Builder{})
	if OwnerPaused(env.InstallDir) {
		t.Fatal("stop lỗi không được ghi đánh dấu tạm dừng")
	}
	fr := &fake.Runner{Responses: []fake.Response{{Output: []byte("")}}}
	if err := RunStop(context.Background(), env, fr, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if !OwnerPaused(env.InstallDir) {
		t.Fatal("genh stop phải ghi config/paused-by-owner.json")
	}
	b, err := os.ReadFile(OwnerPausePath(env.InstallDir))
	if err != nil || !strings.Contains(string(b), `"at"`) {
		t.Fatalf("nội dung %s, %v", b, err)
	}
	if fi, _ := os.Stat(OwnerPausePath(env.InstallDir)); fi.Mode().Perm() != 0o600 {
		t.Fatalf("quyền %v, muốn 0600", fi.Mode().Perm())
	}
	if err := RunStart(context.Background(), env, fr, &strings.Builder{}); err != nil {
		t.Fatal(err)
	}
	if OwnerPaused(env.InstallDir) {
		t.Fatal("genh start phải xoá đánh dấu tạm dừng")
	}
	if err := ClearOwnerPause(env.InstallDir); err != nil {
		t.Fatalf("xoá lần hai không lỗi: %v", err)
	}
}
