package autoupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// RequestTaskName là tên watcher nhận yêu cầu từ Console — "Cập nhật ngay" và
// (v0.1.20) "Khôi phục" (systemd <RequestTaskName>.path/.service, Label
// LaunchAgent). Giữ nguyên tên cũ để cài lại ghi đè đúng unit của bản trước.
const RequestTaskName = "gen-harness-update-request"

// CrontabRequestMarker đánh dấu dòng cron mỗi phút của watcher (fallback khi
// không có systemd --user) — tách khỏi CrontabMarker để bật/tắt riêng.
const CrontabRequestMarker = "# gen-harness-update-request (nut Cap nhat ngay trong Console) — KHONG sua tay"

// Các giá trị "updater" ghi vào run/genh.json cho Console biết nút bấm có
// người nhận hay chưa.
const (
	UpdaterSystemd = "systemd"
	UpdaterCron    = "cron"
	UpdaterLaunchd = "launchd"
)

// requestArgs là đối số watcher: `genh handle-requests` tự chọn việc theo tệp
// trong hộp thư (update.json → `genh update --if-requested`, restore.json →
// `genh restore --if-requested`, offsite.json (v0.1.40) → `genh offsite
// … --if-requested`, doctor.json (v0.1.44) → `genh doctor --if-requested`,
// watchdog.json (v0.1.44) → `genh doctor --notify --test`). Port > 0 (bản cài không dùng cổng mặc định)
// được truyền theo để bước kiểm /ready gọi đúng cổng.
func requestArgs(port int) []string {
	args := []string{"handle-requests", "--quiet"}
	if port > 0 {
		args = append(args, "--port", strconv.Itoa(port))
	}
	return args
}

func updateRequestCmd(genhPath string, port int) string {
	return quoteUnitArg(genhPath) + " " + strings.Join(requestArgs(port), " ")
}

// SystemdRequestServiceUnit: chạy `genh handle-requests` một lần (genh tự xoá
// tệp yêu cầu trước khi làm nên path unit không kích lặp). KillMode=mixed +
// TimeoutStopSec=900: như SystemdServiceUnit (lúc tắt máy giới hạn thật vẫn là
// ~120 giây của user@.service — xem chú thích ở đó).
func SystemdRequestServiceUnit(genhPath, logFile string, rp RequestPaths) string {
	env := ""
	for _, kv := range rp.env() {
		env += fmt.Sprintf("Environment=%s\n", quoteUnitArg(kv))
	}
	port := rp.Port
	return fmt.Sprintf(`[Unit]
Description=Gen-Harness — cap nhat/khoi phuc khi Owner bam nut trong Console

[Service]
Type=oneshot
%sExecStart=%s
KillMode=mixed
TimeoutStopSec=900
StandardOutput=append:%s
StandardError=append:%s
`, env, updateRequestCmd(genhPath, port), logFile, logFile)
}

// SystemdRequestPathUnit: kích service khi MỘT trong các tệp yêu cầu xuất
// hiện (nhiều dòng PathExists= là "hoặc").
func SystemdRequestPathUnit(requestPaths ...string) string {
	var exists strings.Builder
	for _, p := range requestPaths {
		if p != "" {
			exists.WriteString("PathExists=" + p + "\n")
		}
	}
	return fmt.Sprintf(`[Unit]
Description=Gen-Harness — cho yeu cau cap nhat/khoi phuc tu Console

[Path]
%sUnit=%s.service

[Install]
WantedBy=default.target
`, exists.String(), RequestTaskName)
}

// CrontabRequestLine: mỗi phút kiểm các tệp yêu cầu, có tệp nào thì chạy.
func CrontabRequestLine(genhPath, logFile string, rp RequestPaths) string {
	env := ""
	for _, kv := range rp.env() {
		k, v, _ := strings.Cut(kv, "=")
		env += k + "=" + shellQuote(v) + " "
	}
	tests := []string{}
	for _, f := range rp.files() {
		tests = append(tests, "[ -f "+shellQuote(f)+" ]")
	}
	cond := tests[0]
	if len(tests) > 1 {
		cond = "{ " + strings.Join(tests, " || ") + "; }"
	}
	return fmt.Sprintf("* * * * * %s && %s%s >> %s 2>&1",
		cond, env, updateRequestCmd(genhPath, rp.Port), shellQuote(logFile))
}

func shellQuote(s string) string {
	if !strings.ContainsAny(s, " \t'\"$`\\") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// LaunchdRequestPlist: QueueDirectories chạy job khi thư mục yêu cầu có tệp,
// dừng khi genh đã xoá tệp.
func LaunchdRequestPlist(genhPath, logFile string, rp RequestPaths) string {
	var argXML, envXML strings.Builder
	for _, a := range requestArgs(rp.Port) {
		argXML.WriteString("\t\t<string>" + a + "</string>\n")
	}
	for _, kv := range rp.env() {
		k, v, _ := strings.Cut(kv, "=")
		envXML.WriteString("\t\t<key>" + k + "</key>\n\t\t<string>" + v + "</string>\n")
	}
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.gen-harness.update-request</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
%s	</array>
	<key>EnvironmentVariables</key>
	<dict>
%s	</dict>
	<key>QueueDirectories</key>
	<array>
		<string>%s</string>
	</array>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
</dict>
</plist>
`, genhPath, argXML.String(), envXML.String(), rp.RequestDir, logFile, logFile)
}

// RequestPaths là đường dẫn hộp thư mà watcher cần biết.
type RequestPaths struct {
	InstallDir  string
	RequestDir  string
	RequestFile string
	// RestoreFile là tệp yêu cầu khôi phục (v0.1.20; rỗng = chỉ nhận cập nhật).
	RestoreFile string
	// OffsiteFile là tệp yêu cầu bản sao ngoài máy (v0.1.40; rỗng = không nhận).
	OffsiteFile string
	// DoctorFile là tệp yêu cầu gói chẩn đoán (v0.1.44; rỗng = không nhận).
	DoctorFile string
	// WatchdogFile là tệp yêu cầu "Gửi thử" của trực canh (v0.1.44; rỗng = không nhận).
	WatchdogFile string
	// Port là cổng HTTPS của bản cài khi KHÁC mặc định (0 = mặc định).
	Port int
	// Env là biến môi trường "KEY=VALUE" cần mang theo (ví dụ GENH_COMPOSE_FILE
	// khi bản cài dùng compose.yaml ngoài thư mục genh quản lý) — watcher chạy
	// ngoài phiên shell của Owner nên không tự có các biến này.
	Env []string
}

func (rp RequestPaths) files() []string {
	out := []string{rp.RequestFile}
	if rp.RestoreFile != "" {
		out = append(out, rp.RestoreFile)
	}
	if rp.OffsiteFile != "" {
		out = append(out, rp.OffsiteFile)
	}
	if rp.DoctorFile != "" {
		out = append(out, rp.DoctorFile)
	}
	if rp.WatchdogFile != "" {
		out = append(out, rp.WatchdogFile)
	}
	return out
}

func (rp RequestPaths) env() []string {
	out := []string{}
	if rp.InstallDir != "" {
		out = append(out, "GEN_HARNESS_HOME="+rp.InstallDir)
	}
	return append(out, rp.Env...)
}

// EnsureRequestWatcher cài (idempotent) watcher nhận yêu cầu "Cập nhật ngay"
// từ Console, trả cơ chế đã dùng (UpdaterSystemd/UpdaterCron/UpdaterLaunchd).
// Windows chưa hỗ trợ → lỗi; Console khi đó hiện lệnh để Owner tự chạy.
func EnsureRequestWatcher(ctx context.Context, deps Deps, rp RequestPaths) (string, error) {
	if deps.GenhPath == "" {
		return "", fmt.Errorf("thiếu đường dẫn binary genh")
	}
	home, err := deps.homeDir()
	if err != nil {
		return "", fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	runner := deps.runner()
	switch deps.goos() {
	case "linux":
		if systemdUserAvailable(ctx, runner, deps.lookPath()) {
			dir := systemdUserDir(home)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return "", fmt.Errorf("tạo %s: %w", dir, err)
			}
			svc := filepath.Join(dir, RequestTaskName+".service")
			path := filepath.Join(dir, RequestTaskName+".path")
			if err := os.WriteFile(svc, []byte(SystemdRequestServiceUnit(deps.GenhPath, deps.LogFile, rp)), 0o644); err != nil {
				return "", fmt.Errorf("ghi %s: %w", svc, err)
			}
			if err := os.WriteFile(path, []byte(SystemdRequestPathUnit(rp.files()...)), 0o644); err != nil {
				return "", fmt.Errorf("ghi %s: %w", path, err)
			}
			if _, err := runner.Output(ctx, "systemctl", []string{"--user", "daemon-reload"}); err != nil {
				return "", err
			}
			if _, err := runner.Output(ctx, "systemctl", []string{"--user", "enable", "--now", RequestTaskName + ".path"}); err != nil {
				return "", err
			}
			return UpdaterSystemd, nil
		}
		existing, _ := runner.Output(ctx, "crontab", []string{"-l"})
		merged := mergeCrontabMarked(string(existing), CrontabRequestMarker,
			CrontabRequestLine(deps.GenhPath, deps.LogFile, rp), false)
		if err := installCrontab(ctx, runner, merged); err != nil {
			return "", fmt.Errorf("cài crontab: %w", err)
		}
		return UpdaterCron, nil
	case "darwin":
		dir := launchAgentDir(home)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("tạo %s: %w", dir, err)
		}
		path := filepath.Join(dir, "com.gen-harness.update-request.plist")
		_, _ = runner.Output(ctx, "launchctl", []string{"unload", path})
		if err := os.WriteFile(path, []byte(LaunchdRequestPlist(deps.GenhPath, deps.LogFile, rp)), 0o644); err != nil {
			return "", fmt.Errorf("ghi %s: %w", path, err)
		}
		if _, err := runner.Output(ctx, "launchctl", []string{"load", "-w", path}); err != nil {
			return "", err
		}
		return UpdaterLaunchd, nil
	default:
		return "", fmt.Errorf("chưa hỗ trợ nút cập nhật trong Console trên %s", deps.goos())
	}
}

// DisableRequestWatcher gỡ watcher (best-effort, idempotent).
func DisableRequestWatcher(ctx context.Context, deps Deps) {
	home, err := deps.homeDir()
	if err != nil {
		return
	}
	runner := deps.runner()
	switch deps.goos() {
	case "linux":
		_, _ = runner.Output(ctx, "systemctl", []string{"--user", "disable", "--now", RequestTaskName + ".path"})
		dir := systemdUserDir(home)
		_ = os.Remove(filepath.Join(dir, RequestTaskName+".service"))
		_ = os.Remove(filepath.Join(dir, RequestTaskName+".path"))
		_, _ = runner.Output(ctx, "systemctl", []string{"--user", "daemon-reload"})
		if existing, err := runner.Output(ctx, "crontab", []string{"-l"}); err == nil {
			_ = installCrontab(ctx, runner, mergeCrontabMarked(string(existing), CrontabRequestMarker, "", true))
		}
	case "darwin":
		path := filepath.Join(launchAgentDir(home), "com.gen-harness.update-request.plist")
		_, _ = runner.Output(ctx, "launchctl", []string{"unload", path})
		_ = os.Remove(path)
	}
}
