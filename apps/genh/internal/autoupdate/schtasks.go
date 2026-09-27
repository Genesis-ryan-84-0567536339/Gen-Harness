package autoupdate

import (
	"context"
	"strings"
)

// enableWindows tạo/ghi đè một Scheduled Task chạy `genhPath update --yes
// --quiet` hằng ngày lúc 03:00 — /RL LIMITED nên KHÔNG cần chạy PowerShell
// nâng quyền.
func enableWindows(ctx context.Context, deps Deps) (string, error) {
	runner := deps.runner()
	if _, err := runner.Output(ctx, "schtasks", SchtasksCreateArgs(deps.GenhPath, deps.LogFile)); err != nil {
		return "", err
	}
	return "Đã bật tự cập nhật hằng đêm lúc ~03:00 (Task Scheduler) — tắt bằng `genh auto-update disable`", nil
}

func disableWindows(ctx context.Context, deps Deps) (string, error) {
	runner := deps.runner()
	// Bỏ qua lỗi "không tìm thấy task" (chưa từng bật) — idempotent.
	_, _ = runner.Output(ctx, "schtasks", SchtasksDeleteArgs())
	return "Đã tắt tự cập nhật hằng đêm.", nil
}

func statusWindows(ctx context.Context, deps Deps) (Status, error) {
	runner := deps.runner()
	out, err := runner.Output(ctx, "schtasks", SchtasksQueryArgs())
	if err != nil {
		return Status{Enabled: false, Detail: "chưa bật (không có Scheduled Task)"}, nil
	}
	text := string(out)
	enabled := strings.Contains(text, "Ready") || strings.Contains(text, "Running") || !strings.Contains(text, "Disabled")
	return Status{Enabled: enabled, Detail: "Task Scheduler: " + firstLineContaining(text, "Status")}, nil
}

func firstLineContaining(text, needle string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, needle) {
			return strings.TrimSpace(line)
		}
	}
	return strings.TrimSpace(text)
}
