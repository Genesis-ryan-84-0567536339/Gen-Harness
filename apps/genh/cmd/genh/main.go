// Lệnh genh — trình cài đặt/vận hành một-lệnh của Gen-Harness, theo
// docs/handoff/05-installer.md.
//
// Phần A (phiên này) nối được toàn bộ khung: `genh install` chạy thật Bước 1
// (Kiểm tra máy) và Bước 4 (Sinh bí mật & cấu hình), hiển thị qua TUI khi có
// TTY hoặc chế độ dòng khi không có (CI, pipe). Bước 2/3/5/6/7/8 và các lệnh
// vận hành (status/logs/update/backup/…) CHƯA có trong bản này — xem
// internal/install.Registry để biết chỗ cắm vào ở phiên sau.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/config"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/install"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
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

Trạng thái bản này: Bước 1 (Kiểm tra máy) và Bước 4 (Sinh bí mật & cấu
hình) đã chạy thật. Bước 2/3/5/6/7/8 (runtime, tải image, khởi động dữ
liệu, migration, khởi động dịch vụ, hoàn tất) và các lệnh vận hành
(status/logs/update/backup/restore/doctor/reset-setup/stop/start/
uninstall) sẽ có ở phiên sau — xem docs/handoff/05-installer.md.
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
		runErr = runInteractive(ctx, runner, dir)
	} else {
		runErr = runLineMode(ctx, runner, dir)
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

func runInteractive(ctx context.Context, runner *install.Runner, dir string) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	renderer := lipgloss.NewRenderer(os.Stdout)
	styles := tui.NewStyles(renderer, tui.ColorEnabled(renderer))
	model := tui.NewModel(styles, version, dir)

	p := tea.NewProgram(model, tea.WithAltScreen())

	errCh := make(chan error, 1)
	go func() {
		errCh <- runner.Run(ctx, programObserver{p: p})
		p.Send(tui.DoneMsg{})
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

func runLineMode(ctx context.Context, runner *install.Runner, dir string) error {
	lr := tui.NewLineRenderer(os.Stdout)
	err := runner.Run(ctx, lr)
	if se, ok := err.(*install.StepError); ok {
		lr.FinishError(se)
	}
	return err
}

func printSummary(snap install.Snapshot, runErr error) {
	fmt.Println()
	fmt.Printf("Tổng tiến độ: %.0f%%\n", snap.OverallPct)

	hasStub := false
	for _, s := range snap.Steps {
		fmt.Printf("  %-8s %s", statusLabel(s.Status), s.Name)
		if s.Detail != "" {
			fmt.Printf(" — %s", s.Detail)
		}
		fmt.Println()
		if s.Status == install.StatusWarn && s.ID != install.StepMachineCheck {
			hasStub = true
		}
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
		return
	}

	if hasStub {
		fmt.Println()
		fmt.Println("Ghi chú: các bước 2/3/5/6/7/8 (runtime, tải image, khởi động dữ liệu,")
		fmt.Println("migration, khởi động dịch vụ, hoàn tất) chưa được triển khai trong bản")
		fmt.Println("này nên genh CHƯA thật sự dựng được Gen-Harness. Bước 1 và 4 đã chạy")
		fmt.Println("thật và idempotent — chạy lại genh install sau khi các bước còn lại")
		fmt.Println("được thêm sẽ tiếp tục từ đây.")
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
