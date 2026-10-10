package autoupdate

import (
	"context"
	"strings"
	"time"
)

// enableWindows tạo/ghi đè một Scheduled Task chạy `genhPath update --yes
// --quiet [--install-dir …]` hằng ngày lúc 03:00 — /RL LIMITED nên KHÔNG cần
// chạy PowerShell nâng quyền.
func enableWindows(ctx context.Context, deps Deps) (EnableResult, error) {
	runner := deps.runner()
	if _, err := runner.Output(ctx, "schtasks", SchtasksCreateArgs(deps.GenhPath, deps.LogFile, deps.job())); err != nil {
		return EnableResult{}, err
	}
	return EnableResult{
		Msg:       "Đã bật tự cập nhật hằng đêm lúc ~03:00 (Task Scheduler) — tắt bằng `genh auto-update disable`",
		Mechanism: ScheduleSchtasks,
		Linger:    "not_applicable",
	}, nil
}

func disableWindows(ctx context.Context, deps Deps) (string, error) {
	runner := deps.runner()
	// Bỏ qua lỗi "không tìm thấy task" (chưa từng bật) — idempotent.
	_, _ = runner.Output(ctx, "schtasks", SchtasksDeleteArgs())
	return "Đã tắt tự cập nhật hằng đêm.", nil
}

func statusWindows(ctx context.Context, deps Deps) (Status, error) {
	runner := deps.runner()
	st := Status{Linger: "not_applicable"}
	out, err := runner.Output(ctx, "schtasks", SchtasksQueryArgs())
	if err != nil {
		st.Detail = "chưa bật (không có Scheduled Task)"
		return st, nil
	}
	text := string(out)
	st.Mechanism = ScheduleSchtasks
	st.UnitPresent = true
	st.Enabled = strings.Contains(text, "Ready") || strings.Contains(text, "Running") || !strings.Contains(text, "Disabled")
	if st.Enabled {
		st.Active = "active"
	} else {
		st.Active = "inactive"
	}
	st.LastRun = schtasksTime(lineValue(text, "Last Run Time"))
	st.NextRun = schtasksTime(lineValue(text, "Next Run Time"))
	st.Detail = "Task Scheduler: " + firstLineContaining(text, "Status")
	return st, nil
}

// lineValue: giá trị sau "Tên:" của dòng đầu tiên bắt đầu bằng name trong đầu ra
// `schtasks /Query /FO LIST /V` ("" nếu không có).
func lineValue(text, name string) string {
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, name+":") {
			return strings.TrimSpace(strings.TrimPrefix(line, name+":"))
		}
	}
	return ""
}

var schtasksLayouts = []string{
	"1/2/2006 3:04:05 PM", "1/2/2006 15:04:05", "2/1/2006 15:04:05", "02/01/2006 15:04:05",
	"2006-01-02 15:04:05", "2006/01/02 15:04:05", "2.1.2006 15:04:05",
}

// schtasksTime đọc mốc giờ schtasks in theo vùng/ngôn ngữ của Windows (best-effort,
// "N/A" hay định dạng lạ ⇒ zero).
func schtasksTime(s string) time.Time {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, "N/A") {
		return time.Time{}
	}
	for _, layout := range schtasksLayouts {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil && t.Year() > 2000 {
			return t // "30/11/1999" = chưa từng chạy
		}
	}
	return time.Time{}
}

func firstLineContaining(text, needle string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.Contains(line, needle) {
			return strings.TrimSpace(line)
		}
	}
	return strings.TrimSpace(text)
}
