package autoupdate

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var testRP = RequestPaths{InstallDir: "/home/u/.gen-harness", RequestDir: "/home/u/.gen-harness/run/request", RequestFile: "/home/u/.gen-harness/run/request/update.json"}

func TestEnsureRequestWatcher_SystemdPathUnit(t *testing.T) {
	home := t.TempDir()
	runner := newFakeRunner()
	deps := Deps{Runner: runner, GenhPath: "/home/u/.gen-harness/bin/genh", LogFile: "/home/u/.gen-harness/logs/auto-update.log",
		HomeDir: home, GOOS: "linux", LookPath: func(string) (string, error) { return "/usr/bin/systemctl", nil }}
	got, err := EnsureRequestWatcher(context.Background(), deps, testRP)
	if err != nil || got != UpdaterSystemd {
		t.Fatalf("EnsureRequestWatcher = %q, %v", got, err)
	}
	dir := filepath.Join(home, ".config", "systemd", "user")
	path, _ := os.ReadFile(filepath.Join(dir, RequestTaskName+".path"))
	mustContain(t, string(path), "PathExists="+testRP.RequestFile)
	mustContain(t, string(path), "Unit="+RequestTaskName+".service")
	svc, _ := os.ReadFile(filepath.Join(dir, RequestTaskName+".service"))
	mustContain(t, string(svc), "update --yes --quiet --if-requested")
	mustContain(t, string(svc), "Environment=GEN_HARNESS_HOME=/home/u/.gen-harness")
	// Cổng khác mặc định được truyền theo để bước kiểm /ready gọi đúng cổng.
	mustContain(t, SystemdRequestServiceUnit("/g/genh", "/g/log", "/r", 9443), "--if-requested --port 9443")
	mustContain(t, LaunchdRequestPlist("/g/genh", "/g/log", "/r", "/r/run/request", 9443), "<string>--port</string>")
	if !runner.calledWith("systemctl", "--user", "enable", "--now", RequestTaskName+".path") {
		t.Fatalf("phải enable --now path unit: %+v", runner.calls)
	}
}

func TestEnsureRequestWatcher_CronFallbackKeepsNightlyLine(t *testing.T) {
	runner := newFakeRunner()
	runner.errs["systemctl|--user|daemon-reload"] = errors.New("no user bus")
	runner.outputs["crontab|-l"] = []byte("0 1 * * * backup.sh\n" + CrontabMarker + "\n7 3 * * * genh update --yes --quiet\n")
	deps := Deps{Runner: runner, GenhPath: "/g/genh", LogFile: "/g/log", HomeDir: t.TempDir(), GOOS: "linux",
		LookPath: func(string) (string, error) { return "/usr/bin/systemctl", nil }}
	got, err := EnsureRequestWatcher(context.Background(), deps, testRP)
	if err != nil || got != UpdaterCron {
		t.Fatalf("EnsureRequestWatcher = %q, %v", got, err)
	}
	line := CrontabRequestLine("/g/genh", "/g/log", testRP.InstallDir, testRP.RequestFile, 0)
	mustContain(t, line, "* * * * * [ -f "+testRP.RequestFile+" ] && GEN_HARNESS_HOME=")
	mustContain(t, line, "--if-requested")
	merged := mergeCrontabMarked(string(runner.outputs["crontab|-l"]), CrontabRequestMarker, line, false)
	for _, want := range []string{"backup.sh", CrontabMarker, CrontabRequestMarker, "--if-requested"} {
		mustContain(t, merged, want)
	}
	// Gỡ watcher không đụng dòng hằng đêm.
	removed := mergeCrontabMarked(merged, CrontabRequestMarker, "", true)
	if strings.Contains(removed, "--if-requested") || !strings.Contains(removed, CrontabMarker) {
		t.Fatalf("gỡ watcher phải giữ dòng hằng đêm:\n%s", removed)
	}
}

func TestEnsureRequestWatcher_LaunchdQueueDirectory(t *testing.T) {
	home := t.TempDir()
	runner := newFakeRunner()
	deps := Deps{Runner: runner, GenhPath: "/g/genh", LogFile: "/g/log", HomeDir: home, GOOS: "darwin"}
	got, err := EnsureRequestWatcher(context.Background(), deps, testRP)
	if err != nil || got != UpdaterLaunchd {
		t.Fatalf("EnsureRequestWatcher = %q, %v", got, err)
	}
	b, _ := os.ReadFile(filepath.Join(home, "Library", "LaunchAgents", "com.gen-harness.update-request.plist"))
	mustContain(t, string(b), "<key>QueueDirectories</key>")
	mustContain(t, string(b), testRP.RequestDir)
	mustContain(t, string(b), "--if-requested")
}

func TestEnsureRequestWatcher_WindowsUnsupported(t *testing.T) {
	_, err := EnsureRequestWatcher(context.Background(), Deps{Runner: newFakeRunner(), GenhPath: "g", HomeDir: t.TempDir(), GOOS: "windows"}, testRP)
	if err == nil {
		t.Fatal("Windows chưa hỗ trợ — phải trả lỗi để Console hiện lệnh tay")
	}
}
