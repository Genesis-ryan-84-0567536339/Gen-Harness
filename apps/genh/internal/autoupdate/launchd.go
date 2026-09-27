package autoupdate

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"
)

// enableDarwin ghi plist LaunchAgent rồi `launchctl load -w` — dùng cú pháp
// "load/unload" cổ điển (không phải "bootstrap/bootout gui/<uid>") vì nó
// hoạt động nhất quán trên mọi phiên bản macOS còn phổ biến mà không cần tự
// dò UID người dùng hiện tại.
func enableDarwin(ctx context.Context, deps Deps) (string, error) {
	home, err := deps.homeDir()
	if err != nil {
		return "", fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	runner := deps.runner()

	dir := launchAgentDir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("tạo %s: %w", dir, err)
	}
	path := launchAgentPath(home)

	// Gỡ bản cũ trước (nếu có) để `load` không báo "đã tải" khi Enable gọi
	// lại (ví dụ Owner đổi ý bật lại sau khi disable, hoặc genh install gọi
	// Enable lần hai) — bỏ qua lỗi (chưa từng load thì unload thất bại,
	// không sao).
	_, _ = runner.Output(ctx, "launchctl", []string{"unload", path})

	minute := parseMinuteFromClock(time.Now().Format("15:04:05"))
	plist := LaunchdPlist(deps.GenhPath, deps.LogFile, minute)
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		return "", fmt.Errorf("ghi %s: %w", path, err)
	}
	if _, err := runner.Output(ctx, "launchctl", []string{"load", "-w", path}); err != nil {
		return "", fmt.Errorf("launchctl load -w %s: %w", path, err)
	}
	return "Đã bật tự cập nhật hằng đêm lúc ~03:00 (LaunchAgent) — tắt bằng `genh auto-update disable`", nil
}

func disableDarwin(ctx context.Context, deps Deps) (string, error) {
	home, err := deps.homeDir()
	if err != nil {
		return "", fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	runner := deps.runner()
	path := launchAgentPath(home)

	_, _ = runner.Output(ctx, "launchctl", []string{"unload", path})
	_ = os.Remove(path)
	return "Đã tắt tự cập nhật hằng đêm.", nil
}

func statusDarwin(ctx context.Context, deps Deps) (Status, error) {
	home, err := deps.homeDir()
	if err != nil {
		return Status{}, fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	if _, err := os.Stat(launchAgentPath(home)); err != nil {
		return Status{Enabled: false, Detail: "chưa bật (không có LaunchAgent)"}, nil
	}
	runner := deps.runner()
	out, err := runner.Output(ctx, "launchctl", []string{"list"})
	if err != nil {
		return Status{Enabled: false, Detail: "có tệp LaunchAgent nhưng `launchctl list` lỗi: " + err.Error()}, nil
	}
	if strings.Contains(string(out), launchAgentLabel()) {
		return Status{Enabled: true, Detail: "LaunchAgent: đã nạp"}, nil
	}
	return Status{Enabled: false, Detail: "có tệp LaunchAgent nhưng chưa nạp (launchctl load)"}, nil
}
