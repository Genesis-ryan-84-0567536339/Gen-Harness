package autoupdate

import (
	"fmt"
	"strconv"
	"strings"
)

// randomizedDelaySec là biên độ lùi giờ chạy NGẪU NHIÊN mà systemd/launchd
// tự áp — tránh mọi máy Owner trên thế giới cùng gọi GitHub API đúng 03:00:00
// giờ máy chính xác (RandomizedDelaySec của systemd; macOS không có tương
// đương trực tiếp nên dùng phút lẻ khác nhau — xem launchdPlist).
const randomizedDelaySec = 30 * 60 // 30 phút

// SystemdServiceUnit sinh nội dung "<TaskName>.service" — chạy đúng MỘT lần
// `genhPath update --yes --quiet` mỗi khi timer kích hoạt, log gộp cả
// stdout+stderr nối vào logFile (StandardOutput=append: cần systemd >= 236,
// có trên mọi bản phân phối chính còn được hỗ trợ tại thời điểm viết —
// distro cũ hơn vẫn ghi log qua journal như mặc định, chỉ mất phần nối vào
// logFile, không mất chức năng tự cập nhật).
//
// KillMode=mixed + TimeoutStopSec=900 (v0.1.37, F-34): khi unit bị dừng,
// systemd chỉ gửi SIGTERM cho tiến trình genh CHÍNH (genh tự chuyển tiếp cho
// tiến trình con sau tự cập nhật) — mặc định control-group SIGTERM cả docker CLI
// con giữa lúc quay về bản cũ. TimeoutStopSec=900 chỉ có tác dụng khi dừng unit
// lúc máy VẪN chạy (`systemctl --user stop`, đăng xuất có linger…). LÚC TẮT MÁY
// nó KHÔNG nới được gì: user@.service (TimeoutStopSec=120s) SIGKILL cả user
// manager cùng cgroup sau khoảng 2 phút, và docker.service (unit hệ thống, không
// xếp thứ tự với user@) có thể đang dừng song song — vì vậy genh nhận SIGTERM
// sau khi đã đụng CSDL thì KHÔNG bắt đầu khôi phục (xem ops.ErrShutdownSignal).
func SystemdServiceUnit(genhPath, logFile string) string {
	return fmt.Sprintf(`[Unit]
Description=Gen-Harness — tu dong cap nhat genh + dich vu hang dem

[Service]
Type=oneshot
ExecStart=%s update --yes --quiet
KillMode=mixed
TimeoutStopSec=900
StandardOutput=append:%s
StandardError=append:%s
`, quoteUnitArg(genhPath), logFile, logFile)
}

// SystemdTimerUnit sinh nội dung "<TaskName>.timer" — chạy hằng ngày lúc
// ~03:00 giờ máy (giờ ĐỊA PHƯƠNG, mặc định của OnCalendar), Persistent=true
// bù lại lần chạy bị lỡ nếu máy tắt lúc 03:00 (chạy ngay khi máy bật lại
// thay vì chờ tới đêm sau — quan trọng với laptop Owner thường tắt máy).
func SystemdTimerUnit() string {
	return fmt.Sprintf(`[Unit]
Description=Gen-Harness — lich tu dong cap nhat hang dem (~03:00)

[Timer]
OnCalendar=*-*-* 03:00:00
Persistent=true
RandomizedDelaySec=%d

[Install]
WantedBy=timers.target
`, randomizedDelaySec)
}

// quoteUnitArg bọc đường dẫn trong dấu ngoặc kép nếu có khoảng trắng — tệp
// unit systemd tách ExecStart theo khoảng trắng, đường dẫn cài đặt có thể có
// khoảng trắng trên một số máy (ví dụ thư mục home tuỳ biến).
func quoteUnitArg(path string) string {
	if strings.ContainsAny(path, " \t") {
		return `"` + path + `"`
	}
	return path
}

// CrontabMarker là dòng chú thích đứng NGAY TRƯỚC dòng cron do genh quản lý
// — dùng để tìm/xoá đúng dòng đó khi Disable, không đụng các dòng cron khác
// của Owner.
const CrontabMarker = "# gen-harness-auto-update (genh auto-update) — KHONG sua tay, dung `genh auto-update disable` de tat"

// CrontabLine sinh dòng crontab chạy `genhPath update --yes --quiet` mỗi
// ngày lúc 03:<minute> (phút lẻ hoá trong khoảng 0-29 dựa trên chính giờ
// hiện tại lúc Enable chạy — xem randomizedMinute — để không phải mọi máy
// dùng crontab đều gọi đúng 03:00:00) — fallback khi máy không có
// systemd --user (xem enableLinux).
func CrontabLine(genhPath, logFile string, minute int) string {
	minute = ((minute % 30) + 30) % 30
	return fmt.Sprintf("%d 3 * * * %s update --yes --quiet >> %s 2>&1", minute, genhPath, logFile)
}

// MergeCrontab trả về nội dung crontab MỚI: bỏ mọi dòng marker+lệnh genh cũ
// (nếu có, ở BẤT KỲ đâu trong crontab hiện tại) rồi nối thêm marker+newLine
// vào cuối — thuần hàm chuỗi, test không cần gọi `crontab` thật.
//
// removeOnly==true (dùng bởi Disable): chỉ bỏ dòng cũ, KHÔNG nối gì thêm —
// trả về "" nếu sau khi bỏ, crontab không còn dòng nào (một số bản `crontab`
// coi input rỗng là "xoá crontab", hành vi đó chấp nhận được: Owner tắt
// auto-update trên máy trước đó CHỈ dùng crontab cho việc này thì không còn
// gì để giữ).
func MergeCrontab(existing, newLine string, removeOnly bool) string {
	return mergeCrontabMarked(existing, CrontabMarker, newLine, removeOnly)
}

// mergeCrontabMarked là MergeCrontab cho một marker bất kỳ (dòng hằng đêm và
// dòng watcher "Cập nhật ngay" dùng hai marker riêng, bật/tắt độc lập).
func mergeCrontabMarked(existing, marker, newLine string, removeOnly bool) string {
	lines := strings.Split(existing, "\n")
	kept := make([]string, 0, len(lines))
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.TrimSpace(line) == marker {
			// Bỏ marker VÀ dòng lệnh ngay sau nó (nếu có).
			if i+1 < len(lines) {
				i++
			}
			continue
		}
		kept = append(kept, line)
	}
	if !removeOnly {
		kept = append(kept, marker, newLine)
	}
	if len(kept) == 0 {
		return ""
	}
	return strings.Join(kept, "\n") + "\n"
}

// LaunchdPlist sinh nội dung "<launchAgentLabel>.plist" cho macOS
// LaunchAgent — StartCalendarInterval chạy hằng ngày lúc 03:<minute>
// (không có tương đương RandomizedDelaySec trên launchd, nên phút lẻ hoá
// ngay trong plist thay vì luôn đúng 03:00 — xem randomizedMinute).
func LaunchdPlist(genhPath, logFile string, minute int) string {
	minute = ((minute % 30) + 30) % 30
	return fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
		<string>update</string>
		<string>--yes</string>
		<string>--quiet</string>
	</array>
	<key>StartCalendarInterval</key>
	<dict>
		<key>Hour</key>
		<integer>3</integer>
		<key>Minute</key>
		<integer>%d</integer>
	</dict>
	<key>StandardOutPath</key>
	<string>%s</string>
	<key>StandardErrorPath</key>
	<string>%s</string>
	<key>RunAtLoad</key>
	<false/>
</dict>
</plist>
`, launchAgentLabel(), genhPath, minute, logFile, logFile)
}

// SchtasksCreateArgs sinh args cho `schtasks /Create` — dùng `cmd.exe /c`
// nối stdout+stderr vào logFile (schtasks tự nó không hỗ trợ redirect log),
// /F ghi đè nếu task đã tồn tại (idempotent, Enable gọi lại an toàn),
// /RL LIMITED chạy quyền người dùng thường (không cần admin — đúng tinh
// thần "không cần quyền admin" của toàn bộ trình cài).
func SchtasksCreateArgs(genhPath, logFile string) []string {
	tr := fmt.Sprintf(`cmd.exe /c ""%s" update --yes --quiet >> "%s" 2>&1"`, genhPath, logFile)
	return []string{
		"/Create", "/TN", TaskName,
		"/TR", tr,
		"/SC", "DAILY",
		"/ST", "03:00",
		"/RL", "LIMITED",
		"/F",
	}
}

// SchtasksDeleteArgs sinh args cho `schtasks /Delete` (xoá task, /F bỏ qua
// hỏi xác nhận — genh tự chịu trách nhiệm, Owner đã xác nhận qua `genh
// auto-update disable`).
func SchtasksDeleteArgs() []string {
	return []string{"/Delete", "/TN", TaskName, "/F"}
}

// SchtasksQueryArgs sinh args cho `schtasks /Query` — dùng để hỏi task đã
// tồn tại/đang bật hay chưa (`genh auto-update status`).
func SchtasksQueryArgs() []string {
	return []string{"/Query", "/TN", TaskName, "/FO", "LIST"}
}

// parseMinuteFromClock rút phút hiện tại từ một chuỗi "HH:MM:SS" (dùng bởi
// enableLinux/enableDarwin để lẻ hoá giờ chạy dựa trên thời điểm Enable —
// KHÔNG dùng time.Now() trực tiếp ở content.go để giữ gói này thuần, dễ
// test) — trả 0 nếu chuỗi không đúng dạng, không lỗi (chỉ ảnh hưởng việc lẻ
// hoá, không phải chức năng chính).
func parseMinuteFromClock(hhmmss string) int {
	parts := strings.Split(hhmmss, ":")
	if len(parts) < 2 {
		return 0
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0
	}
	return m
}
