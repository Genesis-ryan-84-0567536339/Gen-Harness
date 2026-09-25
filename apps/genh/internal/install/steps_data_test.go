package install

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli/fake"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/secretgen"
)

// speedUpComposePolling giảm compose.PollInterval trong lúc test chạy để
// WaitHealthy không tốn giây thật giữa mỗi lần thăm dò — trả về hàm khôi
// phục giá trị gốc, gọi qua defer.
func speedUpComposePolling(d time.Duration) func() {
	orig := compose.PollInterval
	compose.PollInterval = d
	return func() { compose.PollInterval = orig }
}

func testEnvWithSecrets(t *testing.T) *Env {
	t.Helper()
	res, err := secretgen.Ensure(t.TempDir())
	if err != nil {
		t.Fatalf("secretgen.Ensure: %v", err)
	}
	return &Env{Secrets: res}
}

func TestDataStep_HappyPath_UpThenHealthy(t *testing.T) {
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
		{
			Match: fake.MatchArgsContain("ps", "--format", "json"),
			OutputSeq: [][]byte{
				[]byte(`[{"Service":"db","State":"running","Health":"starting"},{"Service":"redis","State":"running","Health":"healthy"},{"Service":"objects","State":"running","Health":"starting"}]`),
				[]byte(`[{"Service":"db","State":"running","Health":"healthy"},{"Service":"redis","State":"running","Health":"healthy"},{"Service":"objects","State":"running","Health":"healthy"}]`),
			},
		},
	}}

	origInterval := speedUpComposePolling(time.Millisecond)
	defer origInterval()

	step := dataStep{runner: fr, locate: func(string) (string, error) { return "/tmp/compose.yaml", nil }, timeout: time.Second}

	var progresses []Progress
	rep := ReporterFunc(func(p Progress) { progresses = append(progresses, p) })

	if err := step.Run(context.Background(), testEnvWithSecrets(t), rep); err != nil {
		t.Fatalf("Run: %v", err)
	}

	last := progresses[len(progresses)-1]
	if last.Status != StatusOK || last.Percent != 100 {
		t.Errorf("progress cuối = %+v, muốn StatusOK/100", last)
	}

	// Kiểm lệnh `up -d` mang đúng env POSTGRES_PASSWORD/MINIO_ROOT_PASSWORD.
	var upCall *fake.Call
	for i := range fr.Calls {
		if strings.Contains(strings.Join(fr.Calls[i].Cmd.Args, " "), "up") {
			upCall = &fr.Calls[i]
			break
		}
	}
	if upCall == nil {
		t.Fatal("không thấy lệnh `docker compose up`")
	}
	foundPG := false
	for _, e := range upCall.Cmd.Env {
		if strings.HasPrefix(e, "POSTGRES_PASSWORD=") && e != "POSTGRES_PASSWORD=" {
			foundPG = true
		}
	}
	if !foundPG {
		t.Errorf("lệnh up phải mang POSTGRES_PASSWORD khác rỗng, Env=%v", upCall.Cmd.Env)
	}
}

func TestDataStep_ComposeUpFails_ReturnsStructuredError(t *testing.T) {
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Err: errors.New("cổng đã dùng")},
	}}

	step := dataStep{runner: fr, locate: func(string) (string, error) { return "/tmp/compose.yaml", nil }}
	err := step.Run(context.Background(), testEnvWithSecrets(t), ReporterFunc(func(Progress) {}))

	se, ok := err.(*StepError)
	if !ok {
		t.Fatalf("lỗi phải là *StepError, được %T", err)
	}
	if se.Code != ErrCodeComposeUpFailed {
		t.Errorf("Code = %q, muốn %q", se.Code, ErrCodeComposeUpFailed)
	}
}

func TestDataStep_MissingSecrets_ReturnsStructuredError(t *testing.T) {
	fr := &fake.Runner{}
	step := dataStep{runner: fr, locate: func(string) (string, error) { return "/tmp/compose.yaml", nil }}

	err := step.Run(context.Background(), &Env{}, ReporterFunc(func(Progress) {}))
	if err == nil {
		t.Fatal("muốn lỗi khi Env.Secrets rỗng")
	}
	if len(fr.Calls) != 0 {
		t.Error("không được gọi docker khi chưa có bí mật")
	}
}

func TestDataStep_HealthTimeout_ReturnsStructuredError(t *testing.T) {
	fr := &fake.Runner{Responses: []fake.Response{
		{Match: fake.MatchArgsContain("up", "-d"), Output: []byte("")},
		{Match: fake.MatchArgsContain("ps", "--format", "json"), Output: []byte(`[{"Service":"db","State":"running","Health":"starting"}]`)},
	}}

	origInterval := speedUpComposePolling(time.Millisecond)
	defer origInterval()

	step := dataStep{runner: fr, locate: func(string) (string, error) { return "/tmp/compose.yaml", nil }, timeout: 20 * time.Millisecond}
	err := step.Run(context.Background(), testEnvWithSecrets(t), ReporterFunc(func(Progress) {}))

	se, ok := err.(*StepError)
	if !ok {
		t.Fatalf("lỗi phải là *StepError, được %T", err)
	}
	if se.Code != ErrCodeDataNotHealthy {
		t.Errorf("Code = %q, muốn %q", se.Code, ErrCodeDataNotHealthy)
	}
}

func TestDataHealthPercent(t *testing.T) {
	if got := dataHealthPercent(nil); got != 20 {
		t.Errorf("dataHealthPercent(nil) = %v, muốn 20", got)
	}
	all3 := map[string]string{"db": "healthy", "redis": "healthy", "objects": "healthy"}
	if got := dataHealthPercent(all3); got != 95 {
		t.Errorf("dataHealthPercent(3/3 healthy) = %v, muốn 95 (chưa phải 100 — Run tự đặt 100 sau)", got)
	}
}
