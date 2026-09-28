package autoupdate

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// RequestTaskName là tên watcher nhận yêu cầu "Cập nhật ngay" từ Console
// (systemd <RequestTaskName>.path/.service, Label LaunchAgent).
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

// requestArgs là đối số `genh update` của watcher; Port > 0 (bản cài không
// dùng cổng mặc định) được truyền theo để bước kiểm /ready gọi đúng cổng.
func requestArgs(port int) []string {
	args := []string{"update", "--yes", "--quiet", "--if-requested"}
	if port > 0 {
		args = append(args, "--port", strconv.Itoa(port))
	}
	return args
}

func updateRequestCmd(genhPath string, port int) string {
	return quoteUnitArg(genhPath) + " " + strings.Join(requestArgs(port), " ")
}

// SystemdRequestServiceUnit: chạy `genh update --if-requested` một lần
// (genh tự xoá tệp yêu cầu trước khi cập nhật nên path unit không kích lặp).
func SystemdRequestServiceUnit(genhPath, logFile, installDir string, port int) string {
	env := ""
	if installDir != "" {
		env = fmt.Sprintf("Environment=GEN_HARNESS_HOME=%s\n", quoteUnitArg(installDir))
	}
	return fmt.Sprintf(`[Unit]
Description=Gen-Harness — cap nhat khi Owner bam "Cap nhat ngay" trong Console

[Service]
Type=oneshot
%sExecStart=%s
StandardOutput=append:%s
StandardError=append:%s
`, env, updateRequestCmd(genhPath, port), logFile, logFile)
}

// SystemdRequestPathUnit: kích service khi tệp yêu cầu xuất hiện.
func SystemdRequestPathUnit(requestPath string) string {
	return fmt.Sprintf(`[Unit]
Description=Gen-Harness — cho yeu cau cap nhat tu Console

[Path]
PathExists=%s
Unit=%s.service

[Install]
WantedBy=default.target
`, requestPath, RequestTaskName)
}

// CrontabRequestLine: mỗi phút kiểm tệp yêu cầu, có thì cập nhật.
func CrontabRequestLine(genhPath, logFile, installDir, requestPath string, port int) string {
	env := ""
	if installDir != "" {
		env = "GEN_HARNESS_HOME=" + shellQuote(installDir) + " "
	}
	return fmt.Sprintf("* * * * * [ -f %s ] && %s%s >> %s 2>&1",
		shellQuote(requestPath), env, updateRequestCmd(genhPath, port), shellQuote(logFile))
}

func shellQuote(s string) string {
	if !strings.ContainsAny(s, " \t'\"$`\\") {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// LaunchdRequestPlist: QueueDirectories chạy job khi thư mục yêu cầu có tệp,
// dừng khi genh đã xoá tệp.
func LaunchdRequestPlist(genhPath, logFile, installDir, requestDir string, port int) string {
	var argXML strings.Builder
	for _, a := range requestArgs(port) {
		argXML.WriteString("\t\t<string>" + a + "</string>\n")
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
		<key>GEN_HARNESS_HOME</key>
		<string>%s</string>
	</dict>
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
`, genhPath, argXML.String(), installDir, requestDir, logFile, logFile)
}

// RequestPaths là đường dẫn hộp thư mà watcher cần biết.
type RequestPaths struct {
	InstallDir  string
	RequestDir  string
	RequestFile string
	// Port là cổng HTTPS của bản cài khi KHÁC mặc định (0 = mặc định).
	Port int
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
			if err := os.WriteFile(svc, []byte(SystemdRequestServiceUnit(deps.GenhPath, deps.LogFile, rp.InstallDir, rp.Port)), 0o644); err != nil {
				return "", fmt.Errorf("ghi %s: %w", svc, err)
			}
			if err := os.WriteFile(path, []byte(SystemdRequestPathUnit(rp.RequestFile)), 0o644); err != nil {
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
			CrontabRequestLine(deps.GenhPath, deps.LogFile, rp.InstallDir, rp.RequestFile, rp.Port), false)
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
		if err := os.WriteFile(path, []byte(LaunchdRequestPlist(deps.GenhPath, deps.LogFile, rp.InstallDir, rp.RequestDir, rp.Port)), 0o644); err != nil {
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
