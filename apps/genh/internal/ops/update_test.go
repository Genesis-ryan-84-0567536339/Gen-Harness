package ops

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
)

// updateTestComposeYAML phản ánh đúng dạng thật của deploy/compose.yaml:
// proxy/redis/objects có "image:" cố định (pull được), api/web/bridge/db
// dùng "build:" cục bộ (KHÔNG pull được) — đúng resolveUpdateServices phải
// tách hai nhóm này ra.
const updateTestComposeYAML = `name: gen-harness
services:
  proxy:
    image: caddy:2-alpine
  redis:
    image: redis:7-alpine
  objects:
    image: minio/minio:latest
  api:
    build: { context: .. }
  web:
    build: { context: .. }
  bridge:
    build: { context: .. }
  db:
    build: { context: .. }
`

const updateTestBackupLine = "INFO:gh.backup:Backup mới: backups/20260925T100000Z-deadbeef.pgcustom.enc (999 byte, CSDL gen_harness)"

// updateHappyFakeRunner dựng fake.Runner khớp đúng 4 lệnh của luồng cập
// nhật bình thường (backup/pull/migrate/restart), tất cả đều thành công.
func updateHappyFakeRunner() *fake.Runner {
	return &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{updateTestBackupLine}},
		{Match: fake.MatchArgsContain("pull"), Output: []byte("")},
		{Match: fake.MatchArgsContain("run", "--rm", "-T", "--no-deps", "migrate"), Lines: []string{}},
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
	}}
}

// listenReadyServer bind một httptest TLS server vào 127.0.0.1:0 (cổng ngẫu
// nhiên do hệ điều hành cấp), trả về server + cổng — dùng để test RunUpdate
// đường "readiness thành công thật" (waitReady gọi thẳng
// https://127.0.0.1:<port>/api/v1/ready qua localURL, không có cách tiêm
// URL khác, nên phải bind đúng cổng env.Port sẽ dùng).
func listenReadyServer(t *testing.T, healthy bool) (srv *httptest.Server, port int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("net.Listen: %v", err)
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status := http.StatusServiceUnavailable
		if healthy {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"db": "ok"})
	})
	srv = httptest.NewUnstartedServer(handler)
	srv.Listener = ln
	srv.TLS = &tls.Config{}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv, ln.Addr().(*net.TCPAddr).Port
}

func fastUpdateDeps(runner dockercli.Runner) UpdateDeps {
	return UpdateDeps{Runner: runner, Timeout: 200 * time.Millisecond, PollEvery: 5 * time.Millisecond}
}

func TestRunUpdate_HappyPath_ReadySucceeds_NoRollback(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	_, port := listenReadyServer(t, true)
	env.Port = port

	fr := updateHappyFakeRunner()

	var out strings.Builder
	if err := RunUpdate(context.Background(), env, UpdateOptions{Channel: "stable"}, fastUpdateDeps(fr), &out); err != nil {
		t.Fatalf("RunUpdate: %v", err)
	}
	if !strings.Contains(out.String(), "Cập nhật xong") {
		t.Errorf("output phải xác nhận cập nhật xong, được %q", out.String())
	}

	restoreCalls := 0
	for _, c := range fr.Calls {
		if strings.Contains(strings.Join(c.Cmd.Args, " "), "restore") {
			restoreCalls++
		}
	}
	if restoreCalls != 0 {
		t.Errorf("KHÔNG được gọi restore khi cập nhật thành công, restoreCalls=%d", restoreCalls)
	}
}

func TestRunUpdate_ReadyNeverBecomesHealthy_TriggersRollback(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	_, port := listenReadyServer(t, false) // luôn 503
	env.Port = port

	fr := updateHappyFakeRunner()
	fr.Responses = append(fr.Responses, fake.Response{
		Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "restore", "--key"), Output: []byte(""),
	})

	var out strings.Builder
	err := RunUpdate(context.Background(), env, UpdateOptions{}, fastUpdateDeps(fr), &out)
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T (%v)", err, err)
	}
	if opErr.Code != ErrCodeUpdateRolledBack {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdateRolledBack)
	}
	if !strings.Contains(out.String(), "Rollback xong") {
		t.Errorf("output phải xác nhận rollback xong, được %q", out.String())
	}
}

func TestRunUpdate_BackupFails_NoRollbackAttempted(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Err: errors.New("db down")},
	}}

	err := RunUpdate(context.Background(), env, UpdateOptions{}, fastUpdateDeps(fr), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUpdateBackupFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdateBackupFailed)
	}
	if len(fr.Calls) != 1 {
		t.Errorf("Calls = %d, muốn 1 (chỉ backup, KHÔNG được thử rollback khi backup chính là bước thất bại)", len(fr.Calls))
	}
}

func TestRunUpdate_PullFails_TriggersRollback(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{updateTestBackupLine}},
		{Match: fake.MatchArgsContain("pull"), Err: errors.New("net down")},
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "restore", "--key"), Output: []byte("")},
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
	}}

	var out strings.Builder
	err := RunUpdate(context.Background(), env, UpdateOptions{}, fastUpdateDeps(fr), &out)
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUpdateRolledBack {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdateRolledBack)
	}
	if !strings.Contains(out.String(), "Rollback xong") {
		t.Errorf("output phải xác nhận rollback xong, được %q", out.String())
	}

	var sawRestore bool
	for _, c := range fr.Calls {
		if strings.Contains(strings.Join(c.Cmd.Args, " "), "restore --key backups/20260925T100000Z-deadbeef.pgcustom.enc") {
			sawRestore = true
		}
	}
	if !sawRestore {
		t.Errorf("phải gọi restore đúng khoá vừa backup, Calls=%+v", fr.Calls)
	}
}

func TestRunUpdate_MigrateFails_TriggersRollback_RestoreAndRestartCalled(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{updateTestBackupLine}},
		{Match: fake.MatchArgsContain("pull"), Output: []byte("")},
		{Match: fake.MatchArgsContain("run", "--rm", "-T", "--no-deps", "migrate"), Err: errors.New("alembic: lock timeout")},
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "restore", "--key"), Output: []byte("")},
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
	}}

	err := RunUpdate(context.Background(), env, UpdateOptions{}, fastUpdateDeps(fr), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUpdateRolledBack {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdateRolledBack)
	}
	if !strings.Contains(opErr.What, "rollback") {
		t.Errorf("What phải nói rõ đã rollback, được %q", opErr.What)
	}

	restoreCalls, upCalls := 0, 0
	for _, c := range fr.Calls {
		if hasExactArgs(c.Cmd.Args, "restore", "--key") {
			restoreCalls++
		}
		// "up"/"-d" phải khớp CHÍNH XÁC từng phần tử args (không phải chuỗi
		// con đã nối lại) — "up" là chuỗi con của "gh.backup" nên so khớp
		// kiểu Contains trên chuỗi nối sẽ đếm nhầm cả lệnh backup/restore.
		if hasExactArgs(c.Cmd.Args, "up", "-d") {
			upCalls++
		}
	}
	if restoreCalls != 1 {
		t.Errorf("restoreCalls = %d, muốn 1", restoreCalls)
	}
	if upCalls != 1 {
		t.Errorf("upCalls = %d, muốn 1 (chỉ lần rollback — bước restart chính chưa tới vì migrate lỗi trước)", upCalls)
	}
}

// hasExactArgs trả true nếu mọi phần tử trong want xuất hiện NGUYÊN VẸN
// (không phải chuỗi con) trong args.
func hasExactArgs(args []string, want ...string) bool {
	set := make(map[string]bool, len(args))
	for _, a := range args {
		set[a] = true
	}
	for _, w := range want {
		if !set[w] {
			return false
		}
	}
	return true
}

func TestRunUpdate_MigrateFails_RollbackAlsoFails_ReportsBothFailures(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{updateTestBackupLine}},
		{Match: fake.MatchArgsContain("pull"), Output: []byte("")},
		{Match: fake.MatchArgsContain("run", "--rm", "-T", "--no-deps", "migrate"), Err: errors.New("alembic: lock timeout")},
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "restore", "--key"), Err: errors.New("khoá không tồn tại")},
		{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("container không khởi động lại được")},
	}}

	var out strings.Builder
	err := RunUpdate(context.Background(), env, UpdateOptions{}, fastUpdateDeps(fr), &out)
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUpdateRolledBack {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdateRolledBack)
	}
	if !strings.Contains(opErr.What, "ROLLBACK") {
		t.Errorf("What phải cảnh báo RÕ RÀNG rollback cũng thất bại, được %q", opErr.What)
	}
	if !strings.Contains(opErr.Next, "chạy tay") {
		t.Errorf("Next phải hướng dẫn Owner chạy tay khi rollback tự động cũng thất bại, được %q", opErr.Next)
	}
	if !strings.Contains(out.String(), "ROLLBACK THẤT BẠI") {
		t.Errorf("output phải cảnh báo rõ rollback thất bại, được %q", out.String())
	}
}

func TestRunUpdate_RestartFails_TriggersRollback(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "run"), Lines: []string{updateTestBackupLine}},
		{Match: fake.MatchArgsContain("pull"), Output: []byte("")},
		{Match: fake.MatchArgsContain("run", "--rm", "-T", "--no-deps", "migrate"), Lines: []string{}},
		{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("port already in use")},
		{Match: fake.MatchArgsContain("exec", "-T", "api", "python", "-m", "gh.backup", "restore", "--key"), Output: []byte("")},
	}}

	err := RunUpdate(context.Background(), env, UpdateOptions{}, fastUpdateDeps(fr), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUpdateRolledBack {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdateRolledBack)
	}
}

func TestRunUpdate_InvalidChannel_ReturnsErrorBeforeAnyDockerCall(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	env := testEnv(t, composePath)
	fr := &fake.Runner{}

	err := RunUpdate(context.Background(), env, UpdateOptions{Channel: "nightly"}, fastUpdateDeps(fr), &strings.Builder{})
	opErr, ok := err.(*OpError)
	if !ok {
		t.Fatalf("lỗi phải là *OpError, được %T", err)
	}
	if opErr.Code != ErrCodeUpdatePullFailed {
		t.Errorf("Code = %q, muốn %q", opErr.Code, ErrCodeUpdatePullFailed)
	}
	if len(fr.Calls) != 0 {
		t.Error("không được gọi docker khi --channel không hợp lệ")
	}
}

func TestResolveUpdateServices_SplitsPullableAndSkipped(t *testing.T) {
	composePath := testComposePath(t, updateTestComposeYAML)
	cf, err := compose.Load(composePath)
	if err != nil {
		t.Fatalf("compose.Load: %v", err)
	}
	pullable, skipped := resolveUpdateServices(cf)

	wantPullable := map[string]bool{"proxy": true, "redis": true, "objects": true}
	for _, p := range pullable {
		if !wantPullable[p] {
			t.Errorf("pullable chứa %q không mong đợi", p)
		}
		delete(wantPullable, p)
	}
	if len(wantPullable) != 0 {
		t.Errorf("thiếu trong pullable: %v", wantPullable)
	}

	wantSkipped := map[string]bool{"api": true, "web": true, "bridge": true, "db": true}
	for _, s := range skipped {
		if !wantSkipped[s] {
			t.Errorf("skipped chứa %q không mong đợi", s)
		}
		delete(wantSkipped, s)
	}
	if len(wantSkipped) != 0 {
		t.Errorf("thiếu trong skipped: %v", wantSkipped)
	}
}
