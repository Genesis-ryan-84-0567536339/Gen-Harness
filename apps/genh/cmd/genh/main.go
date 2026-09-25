// Lệnh genh — trình cài đặt/vận hành một-lệnh của Gen-Harness, theo
// docs/handoff/05-installer.md.
//
// `genh install` chạy thật cả 8 bước cài đặt (Kiểm tra máy … Hoàn tất — xem
// internal/install.Registry), hiển thị qua TUI khi có TTY hoặc chế độ dòng
// khi không có (CI, pipe), và kết thúc bằng màn "Hoàn tất" thật (URL/mã
// thiết lập/trạng thái mở trình duyệt lấy từ Bước 4 và Bước 8). Các lệnh vận
// hành (status/logs/update/backup/restore/doctor/reset-setup/stop/start/
// uninstall) CHƯA có trong bản này.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/config"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/install"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/secretgen"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/tui"
)

// version được ghi đè lúc build phát hành thật qua:
//
//	go build -ldflags "-X main.version=v2.2.0"
//
// Chưa có pipeline phát hành trong phần A nên giữ "dev".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		printUsage(os.Stdout)
		return 2
	}

	switch args[0] {
	case "install":
		return runInstall(args[1:])
	case "version", "-v", "--version":
		fmt.Println("genh " + version)
		return 0
	case "help", "-h", "--help":
		printUsage(os.Stdout)
		return 0
	default:
		fmt.Fprintf(os.Stderr, "genh: lệnh không rõ %q\n\n", args[0])
		printUsage(os.Stderr)
		return 2
	}
}

func printUsage(w *os.File) {
	fmt.Fprint(w, `genh — trình cài đặt/vận hành một lệnh của Gen-Harness

Cách dùng:
  genh install [--port N] [--install-dir DIR] [--yes]   cài đặt, hoặc tiếp tục bản dở
  genh version                                   in phiên bản
  genh help                                      in hướng dẫn này

Trạng thái bản này: cả 8 bước cài đặt (kiểm tra máy, container runtime,
tải image, sinh bí mật, khởi động dữ liệu, migration, khởi động dịch vụ,
hoàn tất) đã chạy thật và idempotent — chạy lại genh install sau khi bị
ngắt sẽ tiếp tục từ bước dở. Các lệnh vận hành (status/logs/update/backup/
restore/doctor/reset-setup/stop/start/uninstall) chưa có trong bản này —
xem docs/handoff/05-installer.md.
`)
}

func runInstall(args []string) int {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	port := fs.Int("port", machine.DefaultPort, "cổng HTTPS cho proxy")
	installDir := fs.String("install-dir", "", "thư mục cài đặt (mặc định ~/.gen-harness)")
	yes := fs.Bool("yes", false, "đồng ý trước cho các thao tác hệ thống rộng (sudo cho Docker rootless, UAC cho WSL2, tin cậy CA nội bộ)")
	if err := fs.Parse(args); err != nil {
		return 2
	}

	dir := *installDir
	if dir == "" {
		d, err := config.DefaultRoot()
		if err != nil {
			fmt.Fprintf(os.Stderr, "genh: không xác định được thư mục cài đặt: %v\n", err)
			return 1
		}
		dir = d
	}

	env := &install.Env{InstallDir: dir, Port: *port, AutoApprove: *yes}
	runner := install.NewRunner(env, install.Registry())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var runErr error
	if tui.IsTerminal(os.Stdout) {
		runErr = runInteractive(ctx, runner, env)
	} else {
		runErr = runLineMode(ctx, runner, env)
	}

	printSummary(runner.Snapshot(), runErr)

	if runErr != nil {
		return 1
	}
	return 0
}

// programObserver chuyển install.Snapshot thành tui.SnapshotMsg gửi vào
// vòng lặp Bubble Tea — Runner không biết gì về TUI, chỉ biết Reporter.
type programObserver struct{ p *tea.Program }

func (o programObserver) Observe(s install.Snapshot) { o.p.Send(tui.SnapshotMsg(s)) }

func runInteractive(ctx context.Context, runner *install.Runner, env *install.Env) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	renderer := lipgloss.NewRenderer(os.Stdout)
	styles := tui.NewStyles(renderer, tui.ColorEnabled(renderer))
	model := tui.NewModel(styles, version, env.InstallDir)

	p := tea.NewProgram(model, tea.WithAltScreen())

	errCh := make(chan error, 1)
	go func() {
		runErr := runner.Run(ctx, programObserver{p: p})
		errCh <- runErr
		if runErr == nil {
			// Cài đặt xong thật: chuyển Model sang màn "Hoàn tất" (mockup cuối
			// docs/handoff/05-installer.md) thay vì thoát ngay — Owner tự bấm q
			// khi đã xem/copy xong URL và mã thiết lập.
			p.Send(tui.FinishMsg(buildFinishInfo(env, runner)))
		} else {
			p.Send(tui.DoneMsg{Err: runErr})
		}
	}()

	finalModel, progErr := p.Run()
	if fm, ok := finalModel.(tui.Model); ok && fm.Cancelled {
		// Owner bấm q: huỷ an toàn — dừng ctx để Step đang chạy có cơ hội
		// dọn dẹp (dừng container đã tạo, giữ image đã tải), rồi chờ nó trả
		// về thay vì bỏ mặc goroutine.
		cancel()
	}
	runErr := <-errCh

	if progErr != nil {
		return progErr
	}
	return runErr
}

func runLineMode(ctx context.Context, runner *install.Runner, env *install.Env) error {
	lr := tui.NewLineRenderer(os.Stdout)
	err := runner.Run(ctx, lr)
	if err == nil {
		lr.Finish(buildFinishInfo(env, runner))
		return nil
	}
	if se, ok := err.(*install.StepError); ok {
		lr.FinishError(se)
	}
	return err
}

// buildFinishInfo dựng tui.FinishInfo từ dữ liệu THẬT sau khi runner.Run()
// trả về thành công: thời lượng từ chính Runner, URL/mã thiết lập từ bí mật
// Bước 4 (env.Secrets, còn sống vì env là cùng một *install.Env đã truyền
// vào NewRunner), và BrowserOpened từ kết quả Bước 8 (đã tự mở trình duyệt
// đúng một lần — xem finalizeStep trong internal/install).
func buildFinishInfo(env *install.Env, runner *install.Runner) tui.FinishInfo {
	info := tui.FinishInfo{Duration: runner.Snapshot().Elapsed}

	res, ok := env.Secrets.(secretgen.Result)
	if !ok {
		return info
	}

	info.SetupURL = install.SetupURL(env, res.Bundle.SetupToken)
	info.SetupCode = res.Bundle.SetupToken
	if !res.Bundle.CreatedAt.IsZero() {
		info.CodeExpiresIn = time.Until(res.Bundle.CreatedAt.Add(24 * time.Hour))
	}
	info.BrowserOpened = env.BrowserOpened
	return info
}

func printSummary(snap install.Snapshot, runErr error) {
	fmt.Println()
	fmt.Printf("Tổng tiến độ: %.0f%%\n", snap.OverallPct)

	for _, s := range snap.Steps {
		fmt.Printf("  %-8s %s", statusLabel(s.Status), s.Name)
		if s.Detail != "" {
			fmt.Printf(" — %s", s.Detail)
		}
		fmt.Println()
	}

	if runErr != nil {
		fmt.Println()
		if se, ok := runErr.(*install.StepError); ok {
			fmt.Printf("Lỗi %s: %s\n", se.Code, se.What)
			if se.Why != "" {
				fmt.Printf("  vì sao: %s\n", se.Why)
			}
			if se.Next != "" {
				fmt.Printf("  làm gì tiếp: %s\n", se.Next)
			}
		} else {
			fmt.Printf("Lỗi: %v\n", runErr)
		}
	}
}

func statusLabel(s install.Status) string {
	switch s {
	case install.StatusOK:
		return "[OK]"
	case install.StatusSkipped:
		return "[=]"
	case install.StatusWarn:
		return "[!]"
	case install.StatusError:
		return "[X]"
	case install.StatusRunning:
		return "[..]"
	default:
		return "[ ]"
	}
}
