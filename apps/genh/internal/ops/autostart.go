package ops

import (
	"context"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/autoupdate"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/hostlink"
)

// autostartCmdTimeout giới hạn MỖI lệnh kiểm tự khởi động (docker info,
// systemctl, loginctl) — máy có systemd treo/D-Bus chết không được làm treo
// genh status/doctor.
const autostartCmdTimeout = 10 * time.Second

// AutostartDeps cho phép tiêm Runner giả/GOOS/UID khi test — rỗng dùng giá trị thật.
type AutostartDeps struct {
	Runner dockercli.Runner
	GOOS   string // "" = runtime.GOOS
	UID    string // "" = os.Getuid()
}

// CheckAutostart (v0.1.37, F-73) kiểm máy có tự chạy lại Gen-Harness sau khi
// bật/khởi động lại không:
//   - Docker: dịch vụ docker (system: `systemctl is-enabled docker.service`;
//     rootless: `systemctl --user is-enabled docker.service`) phải được bật;
//   - linger (systemd --user chạy khi chưa đăng nhập): bắt buộc nếu có lịch
//     đêm/watcher systemd --user HOẶC Docker rootless.
//
// macOS/Windows: Docker Desktop tự lo — not_applicable. KHÔNG BAO GIỜ trả lỗi:
// lệnh lỗi → "unknown" (status/doctor vẫn chạy tiếp).
func CheckAutostart(ctx context.Context, deps AutostartDeps) hostlink.AutostartStatus {
	goos := deps.GOOS
	if goos == "" {
		goos = runtime.GOOS
	}
	st := hostlink.AutostartStatus{OS: goos, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if goos != "linux" {
		st.Linger, st.DockerEnabled, st.DockerMode = "not_applicable", "not_applicable", "desktop"
		return st
	}
	runner := deps.Runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	uid := deps.UID
	if uid == "" {
		uid = fmt.Sprint(os.Getuid())
	}
	run := func(name string, args ...string) ([]byte, error) {
		cctx, cancel := context.WithTimeout(ctx, autostartCmdTimeout)
		defer cancel()
		return runner.Output(cctx, dockercli.Cmd{Name: name, Args: args})
	}

	// Docker system hay rootless.
	st.DockerMode = "unknown"
	if out, err := run("docker", "info", "--format", "{{json .SecurityOptions}}"); err == nil {
		if strings.Contains(string(out), "rootless") {
			st.DockerMode = "rootless"
		} else {
			st.DockerMode = "system"
		}
	}

	// Docker có tự chạy khi bật máy không.
	switch st.DockerMode {
	case "rootless":
		st.DockerEnabled = normalizeIsEnabled(run("systemctl", "--user", "is-enabled", "docker.service"))
	default:
		// "unknown": vẫn hỏi systemd hệ thống (trường hợp phổ biến nhất) —
		// không có docker.service thì lệnh lỗi ⇒ "unknown".
		st.DockerEnabled = normalizeIsEnabled(run("systemctl", "is-enabled", "docker.service"))
	}

	// linger.
	st.Linger = "unknown"
	if out, err := run("loginctl", "show-user", uid, "--property=Linger", "--value"); err == nil {
		switch strings.TrimSpace(string(out)) {
		case "yes":
			st.Linger = "yes"
		case "no":
			st.Linger = "no"
		}
	}
	st.LingerRequired = st.DockerMode == "rootless"
	for _, unit := range []string{autoupdate.RequestTaskName + ".path", autoupdate.TaskName + ".timer"} {
		if st.LingerRequired {
			break
		}
		if normalizeIsEnabled(run("systemctl", "--user", "is-enabled", unit)) == "yes" {
			st.LingerRequired = true
		}
	}
	return st
}

// normalizeIsEnabled chuẩn hoá stdout của `systemctl is-enabled`: lệnh trả mã
// ≠0 khi "disabled"/"masked" nhưng stdout vẫn có trạng thái — đọc stdout trước,
// chỉ coi là "unknown" khi không nhận ra trạng thái nào (không có systemctl,
// không có unit, D-Bus lỗi…). enabled-runtime: mất sau khởi động lại ⇒ "no".
func normalizeIsEnabled(out []byte, _ error) string {
	state := ""
	if f := strings.Fields(string(out)); len(f) > 0 {
		state = f[0]
	}
	switch {
	case state == "enabled" || state == "static" || state == "alias" || state == "indirect" || state == "generated":
		return "yes"
	case state == "disabled" || state == "masked" || state == "enabled-runtime" || strings.HasPrefix(state, "linked"):
		return "no"
	default:
		return "unknown"
	}
}

// autostartLines là các dòng "Tự chạy lại khi bật máy" cho genh status/doctor:
// (Docker, linger) — mỗi dòng: nhãn, OK hay không, mô tả kèm lệnh sửa khi "no".
func autostartLines(st hostlink.AutostartStatus) []diagLine {
	if st.OS != "linux" {
		return []diagLine{
			{"Docker tự chạy", true, "Docker Desktop tự quản lý (bật \"Start Docker Desktop when you sign in\")"},
			{"Linger (systemd --user)", true, "không áp dụng trên " + st.OS},
		}
	}
	var docker diagLine
	docker.Check = "Docker tự chạy"
	mode := st.DockerMode
	switch st.DockerEnabled {
	case "yes":
		docker.OK, docker.Info = true, "có ("+mode+")"
	case "no":
		fix := "sudo systemctl enable docker"
		if mode == "rootless" {
			fix = "systemctl --user enable docker"
		}
		docker.Info = "KHÔNG — sau khi khởi động lại máy, Gen-Harness sẽ không tự lên. Sửa: " + fix
	default:
		docker.Info = "không rõ (không hỏi được systemd)"
	}

	linger := diagLine{Check: "Linger (systemd --user)"}
	switch {
	case st.Linger == "yes":
		linger.OK, linger.Info = true, "có"
	case !st.LingerRequired:
		linger.OK, linger.Info = true, "không cần (không có lịch/dịch vụ systemd --user)"
		if st.Linger == "no" {
			linger.Info = "tắt — không cần (không có lịch/dịch vụ systemd --user)"
		}
	case st.Linger == "no":
		linger.Info = "KHÔNG — lịch tự cập nhật/nút Console (và Docker rootless) chỉ chạy khi bạn đang đăng nhập. Sửa: sudo loginctl enable-linger $USER"
	default:
		linger.Info = "không rõ (không hỏi được loginctl)"
	}
	return []diagLine{docker, linger}
}

// printAutostart in mục "Tự chạy lại khi bật máy:" (genh status).
func printAutostart(out io.Writer, st hostlink.AutostartStatus) {
	_, _ = fmt.Fprintln(out, "Tự chạy lại khi bật máy:")
	for _, l := range autostartLines(st) {
		_, _ = fmt.Fprintln(out, "  "+l.String())
	}
}
