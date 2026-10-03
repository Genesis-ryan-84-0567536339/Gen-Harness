package install

import (
	"context"
	"crypto/tls"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/hostlink"
)

// tlsReadyServer dựng một httptest.Server TLS giả lập proxy thật — trả 200
// ở readyPath sau notReadyUntil lần gọi đầu (mặc định 0 = luôn sẵn sàng),
// và 503 trước đó, giống hệt cách apps/api/gh/shell/routes.py trả 503 khi
// db/redis chưa "ok". Không đụng mạng/Docker thật.
func tlsReadyServer(t *testing.T, notReadyUntil int) (*httptest.Server, *int) {
	t.Helper()
	calls := 0
	mux := http.NewServeMux()
	mux.HandleFunc(readyPath, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls <= notReadyUntil {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	srv := httptest.NewTLSServer(mux)
	t.Cleanup(srv.Close)
	return srv, &calls
}

// insecureClient giống client thật của servicesStep (InsecureSkipVerify, xem
// steps_services.go): URL giờ gọi "localhost" chứ không phải 127.0.0.1, mà
// chứng chỉ của httptest chỉ có SAN 127.0.0.1/::1/example.com.
func insecureClient() *http.Client {
	return &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}} //nolint:gosec // chỉ trong test
}

func portFromServerURL(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse %s: %v", srv.URL, err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("port từ %s: %v", srv.URL, err)
	}
	return port
}

func TestServicesStep_HappyPath_UpThenReady(t *testing.T) {
	composePath := testComposePath(t)
	srv, _ := tlsReadyServer(t, 0)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d", "api", "worker", "bridge", "browser-egress", "browser", "web", "proxy"), Output: []byte("")},
	}}

	step := servicesStep{
		runner:    fr,
		locate:    func(string) (string, error) { return composePath, nil },
		client:    insecureClient(),
		timeout:   time.Second,
		pollEvery: time.Millisecond,
	}

	env := testEnvWithSecrets(t)
	env.Port = portFromServerURL(t, srv)

	var progresses []Progress
	rep := ReporterFunc(func(p Progress) { progresses = append(progresses, p) })

	if err := step.Run(context.Background(), env, rep); err != nil {
		t.Fatalf("Run: %v", err)
	}

	last := progresses[len(progresses)-1]
	if last.Status != StatusOK || last.Percent != 100 {
		t.Errorf("progress cuối = %+v, muốn StatusOK/100", last)
	}

	if len(fr.Calls) != 1 {
		t.Fatalf("số lệnh docker compose up = %d, muốn đúng 1", len(fr.Calls))
	}
}

func TestServicesStep_ReadyAfterRetries(t *testing.T) {
	composePath := testComposePath(t)
	srv, calls := tlsReadyServer(t, 2) // 2 lần 503 rồi mới 200

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
	}}

	step := servicesStep{
		runner:    fr,
		locate:    func(string) (string, error) { return composePath, nil },
		client:    insecureClient(),
		timeout:   2 * time.Second,
		pollEvery: 5 * time.Millisecond,
	}

	env := testEnvWithSecrets(t)
	env.Port = portFromServerURL(t, srv)

	var progresses []Progress
	rep := ReporterFunc(func(p Progress) { progresses = append(progresses, p) })

	if err := step.Run(context.Background(), env, rep); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if *calls < 3 {
		t.Errorf("số lần gọi %s = %d, muốn >= 3 (2 lần 503 rồi 200)", readyPath, *calls)
	}

	sawRunning := false
	for _, p := range progresses {
		if p.Status == StatusRunning && p.Percent >= 20 && p.Percent < 100 {
			sawRunning = true
		}
	}
	if !sawRunning {
		t.Error("phải báo ít nhất một mốc StatusRunning trong lúc chờ ready")
	}
}

func TestServicesStep_ReadyTimeout_ReturnsStructuredError(t *testing.T) {
	composePath := testComposePath(t)
	srv, _ := tlsReadyServer(t, 1000000) // không bao giờ sẵn sàng trong thời gian test

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
	}}

	step := servicesStep{
		runner:    fr,
		locate:    func(string) (string, error) { return composePath, nil },
		client:    insecureClient(),
		timeout:   50 * time.Millisecond,
		pollEvery: 5 * time.Millisecond,
	}

	env := testEnvWithSecrets(t)
	env.Port = portFromServerURL(t, srv)

	err := step.Run(context.Background(), env, ReporterFunc(func(Progress) {}))
	se, ok := err.(*StepError)
	if !ok {
		t.Fatalf("lỗi phải là *StepError, được %T", err)
	}
	if se.Code != ErrCodeServiceNotReady {
		t.Errorf("Code = %q, muốn %q", se.Code, ErrCodeServiceNotReady)
	}
}

// v0.1.45: siết hộp thư run/ (EnsureRunPerms) chạy SAU `docker compose up`
// thành công, TRƯỚC khi chờ /api/v1/ready; siết không được chỉ cảnh báo.
func TestServicesStep_EnsureRunPermsAfterUp(t *testing.T) {
	composePath := testComposePath(t)
	srv, readyCalls := tlsReadyServer(t, 0)
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
	}}
	type seen struct {
		dockerCalls, readyCalls int
		installDir, composePath string
		envOverlay              int
	}
	var got []seen
	step := servicesStep{
		runner:    fr,
		locate:    func(string) (string, error) { return composePath, nil },
		client:    insecureClient(),
		timeout:   time.Second,
		pollEvery: time.Millisecond,
		ensureRunPerms: func(_ context.Context, _ dockercli.Runner, installDir, cp string, overlay []string) (string, error) {
			got = append(got, seen{len(fr.Calls), *readyCalls, installDir, cp, len(overlay)})
			return hostlink.RunModeOpen, errors.New("docker lỗi")
		},
	}
	env := testEnvWithSecrets(t)
	env.InstallDir = t.TempDir()
	env.Port = portFromServerURL(t, srv)
	var progresses []Progress
	if err := step.Run(context.Background(), env, ReporterFunc(func(p Progress) { progresses = append(progresses, p) })); err != nil {
		t.Fatalf("siết quyền run/ thất bại không được chặn cài đặt: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("EnsureRunPerms phải được gọi đúng 1 lần, có %d", len(got))
	}
	if got[0].dockerCalls != 1 || got[0].readyCalls != 0 {
		t.Fatalf("EnsureRunPerms phải chạy ngay sau up, trước khi chờ ready: %+v", got[0])
	}
	if got[0].installDir != env.InstallDir || got[0].composePath != composePath || got[0].envOverlay == 0 {
		t.Fatalf("tham số EnsureRunPerms = %+v", got[0])
	}
	warned := false
	for _, p := range progresses {
		if strings.Contains(p.Detail, "run/ vẫn mở cho mọi người dùng trên máy") {
			warned = true
		}
	}
	if !warned {
		t.Fatal("mode open phải hiện cảnh báo")
	}

	// up thất bại → không siết.
	got = nil
	fr2 := &fake.Runner{Responses: []fake.Response{{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("x")}}}
	step.runner = fr2
	_ = step.Run(context.Background(), env, ReporterFunc(func(Progress) {}))
	if len(got) != 0 {
		t.Fatal("up lỗi thì không được siết quyền run/")
	}
}

func TestServicesStep_UpFails_ReturnsStructuredError(t *testing.T) {
	composePath := testComposePath(t)

	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("cổng đã dùng")},
	}}

	step := servicesStep{runner: fr, locate: func(string) (string, error) { return composePath, nil }}
	err := step.Run(context.Background(), testEnvWithSecrets(t), ReporterFunc(func(Progress) {}))

	se, ok := err.(*StepError)
	if !ok {
		t.Fatalf("lỗi phải là *StepError, được %T", err)
	}
	if se.Code != ErrCodeServicesUpFailed {
		t.Errorf("Code = %q, muốn %q", se.Code, ErrCodeServicesUpFailed)
	}
}

func TestServicesStep_MissingSecrets_ReturnsStructuredError(t *testing.T) {
	composePath := testComposePath(t)
	fr := &fake.Runner{}
	step := servicesStep{runner: fr, locate: func(string) (string, error) { return composePath, nil }}

	err := step.Run(context.Background(), &Env{}, ReporterFunc(func(Progress) {}))
	se, ok := err.(*StepError)
	if !ok {
		t.Fatalf("lỗi phải là *StepError, được %T", err)
	}
	if se.Code != ErrCodeServicesUpFailed {
		t.Errorf("Code = %q, muốn %q", se.Code, ErrCodeServicesUpFailed)
	}
	if len(fr.Calls) != 0 {
		t.Error("không được gọi docker khi chưa có bí mật")
	}
}

func TestServicesStep_ComposeNotFound_ReturnsStructuredError(t *testing.T) {
	step := servicesStep{locate: func(string) (string, error) { return "", errors.New("không thấy") }}
	err := step.Run(context.Background(), testEnvWithSecrets(t), ReporterFunc(func(Progress) {}))

	se, ok := err.(*StepError)
	if !ok {
		t.Fatalf("lỗi phải là *StepError, được %T", err)
	}
	if se.Code != ErrCodeComposeNotFound {
		t.Errorf("Code = %q, muốn %q", se.Code, ErrCodeComposeNotFound)
	}
}

func TestWaitReadyPercent_MonotonicWithinRange(t *testing.T) {
	timeout := 10 * time.Second
	now := time.Now()
	early := waitReadyPercent(now.Add(timeout), timeout)
	late := waitReadyPercent(now.Add(time.Second), timeout)
	if !(early < late) {
		t.Errorf("waitReadyPercent phải tăng khi gần hết thời gian hơn: early=%v late=%v", early, late)
	}
	if early < 20 || late > 95 {
		t.Errorf("waitReadyPercent phải nằm trong [20,95], được early=%v late=%v", early, late)
	}
}
