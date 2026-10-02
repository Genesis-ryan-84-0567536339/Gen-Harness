package autoupdate

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

// enableLinux thử systemd --user trước (dùng `systemctl --user
// daemon-reload` như phép thử máy CÓ systemd --user hoạt động thật — một số
// container/WSL có binary systemctl nhưng KHÔNG có user session/D-Bus, lệnh
// này thất bại rõ ràng trong trường hợp đó); fallback sang crontab người
// dùng nếu systemd --user không dùng được.
func enableLinux(ctx context.Context, deps Deps) (string, error) {
	home, err := deps.homeDir()
	if err != nil {
		return "", fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	runner := deps.runner()

	if systemdUserAvailable(ctx, runner, deps.lookPath()) {
		dir := systemdUserDir(home)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return "", fmt.Errorf("tạo %s: %w", dir, err)
		}
		svc := SystemdServiceUnit(deps.GenhPath, deps.LogFile)
		tim := SystemdTimerUnit()
		if err := os.WriteFile(serviceUnitPath(home), []byte(svc), 0o644); err != nil {
			return "", fmt.Errorf("ghi %s: %w", serviceUnitPath(home), err)
		}
		if err := os.WriteFile(timerUnitPath(home), []byte(tim), 0o644); err != nil {
			return "", fmt.Errorf("ghi %s: %w", timerUnitPath(home), err)
		}
		if _, err := runner.Output(ctx, "systemctl", []string{"--user", "daemon-reload"}); err != nil {
			return "", fmt.Errorf("systemctl --user daemon-reload: %w", err)
		}
		if _, err := runner.Output(ctx, "systemctl", []string{"--user", "enable", "--now", TaskName + ".timer"}); err != nil {
			return "", fmt.Errorf("systemctl --user enable --now: %w", err)
		}
		msg := "Đã bật tự cập nhật hằng đêm lúc ~03:00 (systemd --user timer) — tắt bằng `genh auto-update disable`"
		// Timer systemd --user chỉ chạy khi user đang có phiên đăng nhập, trừ
		// khi bật "linger" — máy chủ chạy suốt đêm không ai đăng nhập sẽ
		// không bao giờ tự cập nhật nếu thiếu bước này. Không bật được (polkit
		// đòi mật khẩu, ví dụ qua SSH) chỉ cảnh báo, không coi là lỗi.
		if _, err := runner.Output(ctx, "loginctl", []string{"enable-linger"}); err != nil {
			msg += "\nCảnh báo: chưa bật được linger — timer chỉ chạy khi bạn đang đăng nhập. Chạy `sudo loginctl enable-linger $USER` một lần để tự cập nhật cả khi không đăng nhập."
		}
		return msg, nil
	}

	// Fallback crontab.
	minute := parseMinuteFromClock(time.Now().Format("15:04:05"))
	line := CrontabLine(deps.GenhPath, deps.LogFile, minute)
	existing, _ := runner.Output(ctx, "crontab", []string{"-l"}) // lỗi (chưa có crontab nào) coi như rỗng
	merged := MergeCrontab(string(existing), line, false)
	if err := installCrontab(ctx, runner, merged); err != nil {
		return "", fmt.Errorf("cài crontab: %w", err)
	}
	return "Đã bật tự cập nhật hằng đêm lúc ~03:00 (crontab — máy này không có systemd --user) — tắt bằng `genh auto-update disable`", nil
}

// refreshUnitsLinux ghi lại unit lịch đêm khi nội dung trên đĩa khác bản genh
// này sinh ra (vd thiếu KillMode=mixed/TimeoutStopSec của v0.1.37 — unit chỉ
// được ghi lúc install/enable) rồi `systemctl --user daemon-reload`. Chưa có
// unit (lịch đêm tắt, hoặc dùng crontab) → không làm gì; KHÔNG enable/disable
// gì. Trả true nếu đã ghi lại.
func refreshUnitsLinux(ctx context.Context, deps Deps) (bool, error) {
	home, err := deps.homeDir()
	if err != nil {
		return false, fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	path := serviceUnitPath(home)
	cur, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return false, nil
		}
		return false, fmt.Errorf("đọc %s: %w", path, err)
	}
	want := SystemdServiceUnit(deps.GenhPath, deps.LogFile)
	if string(cur) == want {
		return false, nil
	}
	if err := os.WriteFile(path, []byte(want), 0o644); err != nil {
		return false, fmt.Errorf("ghi %s: %w", path, err)
	}
	if _, err := deps.runner().Output(ctx, "systemctl", []string{"--user", "daemon-reload"}); err != nil {
		return true, fmt.Errorf("systemctl --user daemon-reload: %w", err)
	}
	return true, nil
}

func disableLinux(ctx context.Context, deps Deps) (string, error) {
	home, err := deps.homeDir()
	if err != nil {
		return "", fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	runner := deps.runner()

	// Tắt cả hai cơ chế, best-effort — Owner có thể đã bật bằng cơ chế này
	// rồi máy sau đó thay đổi (có/mất systemd --user), không muốn để sót.
	_, _ = runner.Output(ctx, "systemctl", []string{"--user", "disable", "--now", TaskName + ".timer"})
	_ = os.Remove(serviceUnitPath(home))
	_ = os.Remove(timerUnitPath(home))
	_, _ = runner.Output(ctx, "systemctl", []string{"--user", "daemon-reload"})

	existing, err := runner.Output(ctx, "crontab", []string{"-l"})
	if err == nil {
		merged := MergeCrontab(string(existing), "", true)
		_ = installCrontab(ctx, runner, merged)
	}

	return "Đã tắt tự cập nhật hằng đêm.", nil
}

func statusLinux(ctx context.Context, deps Deps) (Status, error) {
	runner := deps.runner()
	if out, err := runner.Output(ctx, "systemctl", []string{"--user", "is-enabled", TaskName + ".timer"}); err == nil {
		state := strings.TrimSpace(string(out))
		return Status{Enabled: state == "enabled", Detail: "systemd --user timer: " + state}, nil
	}
	if out, err := runner.Output(ctx, "crontab", []string{"-l"}); err == nil {
		if strings.Contains(string(out), CrontabMarker) {
			return Status{Enabled: true, Detail: "crontab: đã có dòng tự cập nhật"}, nil
		}
		return Status{Enabled: false, Detail: "crontab: không có dòng tự cập nhật"}, nil
	}
	return Status{Enabled: false, Detail: "chưa bật (không có systemd --user timer lẫn dòng crontab)"}, nil
}

// systemdUserAvailable thử một lệnh vô hại (`systemctl --user
// daemon-reload`, an toàn để gọi lặp lại) — thành công nghĩa là session
// systemd --user thật sự hoạt động, không chỉ có binary trên PATH.
func systemdUserAvailable(ctx context.Context, runner Runner, lookPath func(string) (string, error)) bool {
	if _, err := lookPath("systemctl"); err != nil {
		return false
	}
	_, err := runner.Output(ctx, "systemctl", []string{"--user", "daemon-reload"})
	return err == nil
}

func installCrontab(ctx context.Context, runner Runner, content string) error {
	// crontab đọc crontab MỚI từ STDIN — Runner interface ở gói này (Output)
	// không có stdin, nên ghi content ra một tệp tạm rồi trỏ `crontab
	// <tệp>` (tương đương, `crontab -` cũng đọc từ stdin mà nhiều bản
	// crontab không hỗ trợ "-" như một quy ước rõ ràng — dùng tệp để chắc
	// chắn chạy được trên mọi biến thể cron phổ biến: cronie, Vixie cron…).
	tmp, err := os.CreateTemp("", "genh-crontab-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	_, err = runner.Output(ctx, "crontab", []string{tmp.Name()})
	return err
}
