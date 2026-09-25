// Lệnh genh — trình cài đặt/vận hành một-lệnh của Gen-Harness, theo
// docs/handoff/05-installer.md.
//
// `genh install` chạy thật cả 8 bước cài đặt (Kiểm tra máy … Hoàn tất — xem
// internal/install.Registry), hiển thị qua TUI khi có TTY hoặc chế độ dòng
// khi không có (CI, pipe), và kết thúc bằng màn "Hoàn tất" thật (URL/mã
// thiết lập/trạng thái mở trình duyệt lấy từ Bước 4 và Bước 8). Các lệnh vận
// hành (status/open/logs/update/backup/restore/doctor/reset-setup/stop/
// start/uninstall — xem internal/ops) cũng đã triển khai thật ở phiên này.
package main

import (
	"bufio"
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
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/ops"
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
	case "status":
		return runStatus(args[1:])
	case "open":
		return runOpen(args[1:])
	case "logs":
		return runLogs(args[1:])
	case "update":
		return runUpdate(args[1:])
	case "backup":
		return runBackup(args[1:])
	case "restore":
		return runRestore(args[1:])
	case "doctor":
		return runDoctor(args[1:])
	case "reset-setup":
		return runResetSetup(args[1:])
	case "stop":
		return runStop(args[1:])
	case "start":
		return runStart(args[1:])
	case "uninstall":
		return runUninstall(args[1:])
	case "version", "-v", "--version":
		fmt.Println("genh " + version)
		return 0
	case "help", "-h", "--help":
		printUsage(os.Stdout)
		return 0
	default:
		_, _ = fmt.Fprintf(os.Stderr, "genh: lệnh không rõ %q\n\n", args[0])
		printUsage(os.Stderr)
		return 2
	}
}

func printUsage(w *os.File) {
	_, _ = fmt.Fprint(w, `genh — trình cài đặt/vận hành một lệnh của Gen-Harness

Cách dùng:
  genh install [--port N] [--install-dir DIR] [--yes]   cài đặt, hoặc tiếp tục bản dở

Lệnh vận hành (cờ chung mọi lệnh dưới đây: --port N, --install-dir DIR):
  genh status                            bảng dịch vụ + healthy + phiên bản + dung lượng
  genh open                              mở Console trong trình duyệt
  genh logs [dịch vụ...] [-f]            log gọn (tail 200), -f để theo dõi liên tục
  genh update [--channel stable|beta]    tải bản mới, backup tự động, migrate, khởi động
                                          lại theo thứ tự; lỗi ở bất kỳ bước nào → tự rollback
  genh backup [--to path]                sao lưu vào ObjectStore nội bộ (--to: copy thêm ra host)
  genh restore <khoá>                    khôi phục một bản backup theo khoá (xem giới hạn trong
                                          báo cáo lệnh: chưa hỗ trợ file host tuỳ ý)
  genh doctor [--out report.zip]         chẩn đoán runtime/cổng/chứng chỉ/dung lượng/đồng hồ/
                                          kết nối kênh, xuất báo cáo zip
  genh reset-setup [--yes]               sinh mã thiết lập mới (hỏi xác nhận trừ khi --yes)
  genh stop                              dừng toàn bộ dịch vụ (giữ dữ liệu)
  genh start                             khởi động lại toàn bộ dịch vụ
  genh uninstall [--keep-data]           gỡ container/volume/lối tắt/PATH (hỏi xác nhận)

  genh version                                   in phiên bản
  genh help                                      in hướng dẫn này

Trạng thái bản này: cả 8 bước cài đặt (kiểm tra máy, container runtime,
tải image, sinh bí mật, khởi động dữ liệu, migration, khởi động dịch vụ,
hoàn tất) VÀ toàn bộ lệnh vận hành ở trên đã triển khai thật — một số lệnh
có giới hạn đã biết, ghi rõ trong thông báo của chính lệnh đó (ví dụ genh
restore chưa nhận file host tuỳ ý, genh update chưa có pipeline phát hành
theo kênh — xem docs/handoff/05-installer.md).
`)
}

// opsFlagSet dựng flag.FlagSet chung cho mọi lệnh vận hành (--port/
// --install-dir, cùng mặc định với runInstall) — trả về FlagSet CHƯA Parse
// (caller tự thêm cờ riêng của lệnh trước khi gọi fs.Parse) cùng 2 con trỏ
// để đọc lại sau Parse.
func opsFlagSet(name string) (fs *flag.FlagSet, port *int, installDir *string) {
	fs = flag.NewFlagSet(name, flag.ContinueOnError)
	port = fs.Int("port", machine.DefaultPort, "cổng HTTPS của proxy")
	installDir = fs.String("install-dir", "", "thư mục cài đặt (mặc định ~/.gen-harness)")
	return fs, port, installDir
}

// resolveOpsEnv dựng *ops.Env từ port/installDir đã Parse — in lỗi ra stderr
// và trả ok=false nếu không xác định được thư mục cài đặt mặc định.
func resolveOpsEnv(port int, installDir string) (*ops.Env, bool) {
	dir, err := ops.ResolveInstallDir(installDir)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "genh: không xác định được thư mục cài đặt: %v\n", err)
		return nil, false
	}
	return &ops.Env{InstallDir: dir, Port: ops.ResolvePort(port)}, true
}

// reportOpErr in một lỗi vận hành theo đúng định dạng "chuyện gì · vì sao ·
// làm gì tiếp" (xem internal/ops.OpError) hoặc lỗi thường nếu không phải
// *ops.OpError (không nên xảy ra với các hàm ops.Run*, nhưng phòng hờ).
func reportOpErr(err error) {
	if opErr, ok := err.(*ops.OpError); ok {
		_, _ = fmt.Fprint(os.Stderr, opErr.Report())
		return
	}
	_, _ = fmt.Fprintf(os.Stderr, "genh: %v\n", err)
}

func runStatus(args []string) int {
	fs, port, installDir := opsFlagSet("status")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	if err := ops.RunStatus(context.Background(), env, version, ops.StatusDeps{}, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runOpen(args []string) int {
	fs, port, installDir := opsFlagSet("open")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	if err := ops.RunOpen(env, ops.OpenDeps{}, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runLogs(args []string) int {
	fs, port, installDir := opsFlagSet("logs")
	follow := fs.Bool("f", false, "theo dõi log liên tục (như tail -f)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	opts := ops.LogsOptions{Services: fs.Args(), Follow: *follow}
	if err := ops.RunLogs(ctx, env, opts, nil, os.Stdout, os.Stderr, os.Stdin); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runUpdate(args []string) int {
	fs, port, installDir := opsFlagSet("update")
	channel := fs.String("channel", "stable", "kênh cập nhật: stable hoặc beta")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	opts := ops.UpdateOptions{Channel: *channel}
	if err := ops.RunUpdate(ctx, env, opts, ops.UpdateDeps{}, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runBackup(args []string) int {
	fs, port, installDir := opsFlagSet("backup")
	to := fs.String("to", "", "copy thêm bản backup ra đường dẫn này trên host (tuỳ chọn)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := ops.RunBackup(ctx, env, *to, nil, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runRestore(args []string) int {
	fs, port, installDir := opsFlagSet("restore")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		_, _ = fmt.Fprintln(os.Stderr, "genh: cách dùng: genh restore <khoá-backup>")
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := ops.RunRestore(ctx, env, fs.Arg(0), nil, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runDoctor(args []string) int {
	fs, port, installDir := opsFlagSet("doctor")
	outPath := fs.String("out", "genh-doctor-report.zip", "đường dẫn tệp báo cáo zip xuất ra")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := ops.RunDoctor(ctx, env, *outPath, ops.DoctorDeps{}, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runResetSetup(args []string) int {
	fs, port, installDir := opsFlagSet("reset-setup")
	yes := fs.Bool("yes", false, "bỏ qua hỏi xác nhận")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	opts := ops.ResetSetupOptions{AutoApprove: *yes}
	if err := ops.RunResetSetup(env, opts, bufio.NewReader(os.Stdin), os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runStop(args []string) int {
	fs, port, installDir := opsFlagSet("stop")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	if err := ops.RunStop(context.Background(), env, nil, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runStart(args []string) int {
	fs, port, installDir := opsFlagSet("start")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	if err := ops.RunStart(context.Background(), env, nil, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runUninstall(args []string) int {
	fs, port, installDir := opsFlagSet("uninstall")
	keepData := fs.Bool("keep-data", false, "giữ lại dữ liệu (không xoá volume)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	opts := ops.UninstallOptions{KeepData: *keepData}
	if err := ops.RunUninstall(context.Background(), env, opts, nil, os.Stdin, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
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
			_, _ = fmt.Fprintf(os.Stderr, "genh: không xác định được thư mục cài đặt: %v\n", err)
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
