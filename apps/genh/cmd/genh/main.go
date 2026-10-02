// Lệnh genh — trình cài đặt/vận hành một-lệnh của Gen-Harness, theo
// docs/handoff/05-installer.md.
//
// `genh install` chạy thật cả 8 bước cài đặt (Kiểm tra máy … Hoàn tất — xem
// internal/install.Registry), hiển thị qua TUI khi có TTY hoặc chế độ dòng
// khi không có (CI, pipe), và kết thúc bằng màn "Hoàn tất" thật (URL/mã
// thiết lập/trạng thái mở trình duyệt lấy từ Bước 4 và Bước 8). Các lệnh vận
// hành (status/open/logs/update/backup/restore/doctor/reset-setup/reset-password/trust-ca/stop/
// start/uninstall — xem internal/ops) cũng đã triển khai thật ở phiên này.
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/autoupdate"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/config"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/hostlink"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/install"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/ops"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/secretgen"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/selfupdate"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/tui"
)

// selfupdateOwner/selfupdateRepo là repo GitHub genh tự hỏi bản mới nhất —
// cùng REPO dùng bởi install.sh/install.ps1 (docs/handoff/05-installer.md).
const (
	selfupdateOwner = "Genesis-ryan-84-0567536339"
	selfupdateRepo  = "Gen-Harness"
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
	case "auto-update":
		return runAutoUpdate(args[1:])
	case "backup":
		return runBackup(args[1:])
	case "restore":
		return runRestore(args[1:])
	case "handle-requests":
		return runHandleRequests(args[1:])
	case "doctor":
		return runDoctor(args[1:])
	case "reset-setup":
		return runResetSetup(args[1:])
	case "reset-password":
		return runResetPassword(args[1:])
	case "trust-ca":
		return runTrustCA(args[1:])
	case "stop":
		return runStop(args[1:])
	case "start":
		return runStart(args[1:])
	case "uninstall":
		return runUninstall(args[1:])
	case "export":
		return runExport(args[1:])
	case "import":
		return runImport(args[1:])
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
  genh install [--port N] [--install-dir DIR] [--yes] [--force]   cài đặt, hoặc tiếp tục bản dở
                                          (máy đã cài xong -> dừng, gợi ý genh update; --force để cố tình cài lại)

Lệnh vận hành (cờ chung mọi lệnh dưới đây: --port N, --install-dir DIR):
  genh status                            bảng dịch vụ + healthy + phiên bản + dung lượng
  genh open                              mở Console trong trình duyệt
  genh logs [dịch vụ...] [-f]            log gọn (tail 200), -f để theo dõi liên tục
  genh update [--channel stable|beta] [--yes] [--quiet] [--no-self-update]
                                          tự tải genh mới nhất (kiểm checksum, re-exec bằng
                                          code mới) rồi mới backup tự động, migrate, khởi động
                                          lại theo thứ tự; lỗi ở bất kỳ bước nào → tự rollback.
                                          --yes (lịch đêm dùng cờ này): chỉ nhận bản genh đã là
                                          bản chính thức ≥ 24 giờ (thời gian chín; gõ tay không
                                          --yes hoặc "Cập nhật ngay" trong Console thì cài
                                          luôn) · --quiet: chỉ in dòng quan trọng ·
                                          --no-self-update: chỉ nâng cấp dịch vụ, không đụng
                                          binary genh. Mọi cách chạy: dịch vụ đã khớp bản genh
                                          này thì bỏ qua (không sao lưu, không tải) — dịch vụ
                                          đang dừng/lỗi thì dùng genh start
  genh auto-update enable|disable|status tự chạy "genh update --yes --quiet" mỗi đêm ~03:00
                                          (systemd timer/crontab, LaunchAgent, hoặc Task
                                          Scheduler tuỳ hệ điều hành) — mặc định đã BẬT sau
                                          "genh install" (tắt bằng --no-auto-update lúc cài,
                                          hoặc "genh auto-update disable" sau đó); vì có --yes,
                                          lịch đêm chỉ nhận bản đã là bản chính thức ≥ 24 giờ
  genh backup [--to path]                sao lưu vào ObjectStore nội bộ (--to: copy thêm ra host)
  genh restore <khoá>                    khôi phục một bản backup theo khoá: tự sao lưu an toàn,
                                          dừng api/worker, khôi phục, migrate, khởi động lại
                                          (lỗi → quay về bản an toàn; chưa nhận file host tuỳ ý)
  genh handle-requests                   (watcher gọi) làm yêu cầu Console để lại trong hộp thư
                                          run/request: update.json → cập nhật, restore.json → khôi phục
  genh doctor [--out report.zip]         chẩn đoán runtime/cổng/chứng chỉ/dung lượng/đồng hồ/
                                          kết nối kênh, xuất báo cáo zip
  genh reset-setup [--yes]               sinh mã thiết lập mới (hỏi xác nhận trừ khi --yes)
  genh reset-password                    quên mật khẩu Owner: in email + mật khẩu tạm mới
                                          (giữ nguyên dữ liệu, đăng xuất các phiên cũ)
  genh trust-ca                          tin cậy lại CA nội bộ cho trình duyệt/hệ điều hành
                                          (hết cảnh báo "Not secure"; genh update tự làm)
  genh stop                              dừng toàn bộ dịch vụ (giữ dữ liệu)
  genh start                             khởi động lại toàn bộ dịch vụ
  genh uninstall [--keep-data] [--yes]   gỡ container/volume/lối tắt/PATH (hỏi xác nhận trừ --yes)
  genh export --to <file>                xuất gói hồ sơ .ghbundle (hỏi mật khẩu ẩn 2 lần,
                                          hoặc biến GH_BUNDLE_PASSWORD cho script/test)
  genh import <file> [--yes]             nhập gói .ghbundle — GHI ĐÈ dữ liệu hiện tại (hỏi
                                          xác nhận trừ --yes), tự backup an toàn trước

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

// signalContext là ngữ cảnh bị huỷ khi genh nhận tín hiệu dừng: Ctrl-C
// (os.Interrupt) HOẶC SIGTERM — systemd gửi SIGTERM khi máy tắt/khởi động lại
// hoặc `systemctl stop` (v0.1.37, F-34: trước đây chỉ bắt Ctrl-C nên SIGTERM
// giết genh ngay giữa lúc migrate, không kịp quay về bản cũ). syscall.SIGTERM có
// trên mọi hệ điều hành Go hỗ trợ (Windows: chỉ là hằng, không bao giờ tới).
//
// Nguyên nhân huỷ (context.Cause) nói tín hiệu nào: SIGTERM → ops.ErrShutdownSignal
// (máy tắt — rollback không bắt đầu khôi phục CSDL trong khung ~2 phút trước
// SIGKILL), Ctrl-C → ops.ErrInterruptSignal. Như signal.NotifyContext, sau tín
// hiệu đầu genh VẪN bắt tín hiệu (không chết vì tín hiệu thứ hai) cho tới stop.
func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancelCause(context.Background())
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		select {
		case sig := <-ch:
			cancel(signalCause(sig))
		case <-done:
		}
	}()
	var once sync.Once
	return ctx, func() {
		once.Do(func() {
			signal.Stop(ch)
			close(done)
			cancel(context.Canceled)
		})
	}
}

// signalCause: nguyên nhân huỷ ngữ cảnh ứng với tín hiệu nhận được.
func signalCause(sig os.Signal) error {
	if sig == syscall.SIGTERM {
		return ops.ErrShutdownSignal
	}
	return ops.ErrInterruptSignal
}

// forwardSignal: tín hiệu chuyển cho tiến trình con theo nguyên nhân huỷ ctx —
// giữ đúng loại (Ctrl-C vẫn là SIGINT để con khôi phục như thường, SIGTERM vẫn
// là SIGTERM để con không bắt đầu khôi phục lúc máy đang tắt).
func forwardSignal(ctx context.Context) os.Signal {
	if errors.Is(context.Cause(ctx), ops.ErrInterruptSignal) {
		return os.Interrupt
	}
	return syscall.SIGTERM
}

// lockMode: cách lấy khoá loại trừ (<gốc cài đặt>/genh.lock) theo cách genh
// được gọi.
type lockMode int

const (
	// lockManual: Owner gõ tay — bận ⇒ in lý do ra stderr, thoát 1 (GH-E94A).
	lockManual lockMode = iota
	// lockScheduled: lịch đêm — bận ⇒ in một dòng ra stdout (vào log), thoát 0,
	// KHÔNG đụng hộp thư Console.
	lockScheduled
	// lockRequested: nút trong Console (watcher, --if-requested) — CHỜ tối đa
	// requestLockWait: thoát ngay khi tệp yêu cầu còn đó thì path unit systemd
	// sẽ kích lặp liên tục.
	lockRequested
)

// requestLockWait: thời gian tối đa --if-requested chờ lần khác nhả khoá (biến
// gói để test đặt ngắn).
var requestLockWait = 30 * time.Minute

// lockBusyLine: dòng log khi khoá bận (E2E grep "đang có một lần cập
// nhật/khôi phục khác chạy").
func lockBusyLine(err error) string {
	if pid := hostlink.BusyPID(err); pid > 0 {
		return fmt.Sprintf("genh: đang có một lần cập nhật/khôi phục khác chạy (PID %d) — lần này bỏ qua.", pid)
	}
	return "genh: đang có một lần cập nhật/khôi phục khác chạy — lần này bỏ qua."
}

// acquireOpLock lấy khoá loại trừ cho update/restore/import ở tiến trình NGOÀI
// CÙNG, TRƯỚC khi đụng hộp thư Console. ok=false ⇒ caller trả ngay exitCode.
// stillWanted (lockRequested): kiểm lại yêu cầu sau khi chờ được khoá — lần
// chạy trước (vd lịch đêm) có thể đã nuốt nó. Lỗi khác "bận" (không mở được
// genh.lock…) chỉ cảnh báo rồi chạy tiếp không khoá — không chặn bản vá vì một
// tệp khoá hỏng.
func acquireOpLock(ctx context.Context, installDir string, mode lockMode, stillWanted func() bool, stdout, stderr io.Writer) (lock *hostlink.Lock, exitCode int, ok bool) {
	lock, err := hostlink.AcquireLock(installDir)
	if mode == lockRequested && errors.Is(err, hostlink.ErrLockBusy) {
		// Chỉ MỘT người chờ cùng lúc (watcher crontab kích mỗi phút — xem
		// hostlink.WaitLockFile); người chờ đó sẽ làm yêu cầu, lần này thoát.
		waiter, werr := hostlink.AcquireWaitLock(installDir)
		if errors.Is(werr, hostlink.ErrLockBusy) {
			_, _ = fmt.Fprintln(stdout, "genh: đã có một tiến trình khác đang chờ để làm yêu cầu từ Console — lần này bỏ qua.")
			return nil, 0, false
		}
		_, _ = fmt.Fprintf(stdout, "genh: chờ lần cập nhật/khôi phục đang chạy xong (tối đa %s) rồi làm tiếp yêu cầu từ Console…\n", requestLockWait)
		lock, err = hostlink.AcquireLockWait(ctx, installDir, requestLockWait)
		waiter.Release()
	}
	switch {
	case err == nil:
	case errors.Is(err, hostlink.ErrLockBusy):
		if mode == lockManual {
			_, _ = fmt.Fprintln(stderr, lockBusyLine(err))
			_, _ = fmt.Fprint(stderr, (&ops.OpError{
				Code: ops.ErrCodeUpdateLocked,
				What: "Chưa chạy lệnh này — đang có một lần cập nhật/khôi phục khác",
				Why:  err.Error(),
				Next: "Đợi lần đó chạy xong (xem `genh status` hoặc logs/auto-update.log) rồi chạy lại lệnh này.",
			}).Report())
			return nil, 1, false
		}
		_, _ = fmt.Fprintln(stdout, lockBusyLine(err))
		return nil, 0, false
	case ctx.Err() != nil:
		_, _ = fmt.Fprintln(stderr, "genh: nhận tín hiệu dừng khi đang chờ lần cập nhật/khôi phục khác chạy xong — không làm gì.")
		return nil, 1, false
	default:
		_, _ = fmt.Fprintf(stderr, "genh: cảnh báo — không lấy được khoá loại trừ (%v); vẫn chạy tiếp.\n", err)
	}
	if mode == lockRequested && stillWanted != nil && !stillWanted() {
		lock.Release()
		return nil, 0, false
	}
	return lock, 0, true
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
	ctx, stop := signalContext()
	defer stop()
	opts := ops.LogsOptions{Services: fs.Args(), Follow: *follow}
	if err := ops.RunLogs(ctx, env, opts, nil, os.Stdout, os.Stderr, os.Stdin); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

// updateFlags là các cờ của `genh update` sau khi Parse.
type updateFlags struct {
	port         int
	installDir   string
	channel      string
	yes          bool
	quiet        bool
	noSelfUpdate bool
	selfUpdated  bool
	ifRequested  bool
}

// parseUpdateFlags parse cờ của `genh update` — tách khỏi runUpdate để test
// (cmd/genh/main_test.go) parse đúng bộ cờ thật, ví dụ cờ handle-requests
// chuyển sang (handleRequestUpdateArgs).
func parseUpdateFlags(args []string) (updateFlags, error) {
	fs, port, installDir := opsFlagSet("update")
	channel := fs.String("channel", "stable", "kênh cập nhật: stable hoặc beta")
	yes := fs.Bool("yes", false, "chạy không tương tác — dùng cho lịch tự động (genh auto-update); KHÔNG hỏi gì kể cả khi có TTY, và (không kèm --if-requested) chỉ tự cài bản genh đã là bản chính thức ≥ 24 giờ (thời gian chín) — muốn cài ngay thì bỏ --yes")
	quiet := fs.Bool("quiet", false, "chỉ in các dòng quan trọng (có bản mới/lỗi/xong) — bỏ log tiến độ từng bước")
	noSelfUpdate := fs.Bool("no-self-update", false, "bỏ qua tự cập nhật BINARY genh — chỉ chạy phần nâng cấp dịch vụ (backup/pull/migrate/restart) bằng bản genh hiện tại (như mọi cách chạy genh update: dịch vụ đã khớp bản genh này thì bỏ qua — dịch vụ dừng/lỗi thì dùng genh start)")
	selfUpdated := fs.Bool("self-updated", false, "cờ NỘI BỘ: tiến trình này vừa được re-exec ngay sau khi tự thay binary — KHÔNG dùng tay, chỉ genh tự đặt cho chính nó")
	ifRequested := fs.Bool("if-requested", false, "chỉ cập nhật nếu Owner vừa bấm \"Cập nhật ngay\" trong Console (watcher trên máy chủ gọi) — không có yêu cầu thì thoát ngay")
	if err := fs.Parse(args); err != nil {
		return updateFlags{}, err
	}
	return updateFlags{
		port: *port, installDir: *installDir, channel: *channel,
		yes: *yes, quiet: *quiet, noSelfUpdate: *noSelfUpdate,
		selfUpdated: *selfUpdated, ifRequested: *ifRequested,
	}, nil
}

func runUpdate(args []string) int {
	f, err := parseUpdateFlags(args)
	if err != nil {
		return 2
	}
	// --yes không đổi phần nâng cấp dịch vụ (RunUpdate không hỏi gì, kể cả có
	// TTY — đã rà soát internal/ops/update.go: không có prompt nào), nhưng
	// --yes KHÔNG kèm --if-requested ⇒ bước tự cập nhật binary áp thời gian
	// chín 24 giờ (selfUpdateMinAge) — xem lý do giữ --yes làm cờ kích hoạt ở
	// đó. Bản chưa đủ chín: không thay binary, phần dịch vụ vẫn chạy như khi
	// đã mới nhất, dòng kết nói rõ bản mới đang đợi (updateDoneLine).

	env, ok := resolveOpsEnv(f.port, f.installDir)
	if !ok {
		return 1
	}

	// Tín hiệu dừng (Ctrl-C/SIGTERM) bắt từ ĐẦU — kể cả lúc tự cập nhật binary
	// và lúc chờ tiến trình con (trySelfUpdateAndReExec chuyển tiếp cho con).
	ctx, stop := signalContext()
	defer stop()

	// Khoá loại trừ (v0.1.37, F-35): tiến trình NGOÀI CÙNG lấy khoá TRƯỚC khi đụng
	// hộp thư Console — hai genh update/restore chạy chồng nhau (lịch đêm + nút
	// Console + gõ tay) sẽ sao lưu/migrate/khôi phục giẫm lên nhau. Tiến trình
	// con --self-updated BỎ QUA (cha đang giữ khoá; fd khoá không kế thừa).
	if !f.selfUpdated {
		if f.ifRequested && !hostlink.HasRequest(env.InstallDir) {
			return 0
		}
		mode := lockManual
		switch {
		case f.ifRequested:
			mode = lockRequested
		case f.yes:
			mode = lockScheduled
		}
		lock, code, ok := acquireOpLock(ctx, env.InstallDir, mode, func() bool { return hostlink.HasRequest(env.InstallDir) }, os.Stdout, os.Stderr)
		if !ok {
			return code
		}
		defer lock.Release()
		stopBeat := hostlink.StartHeartbeat(env.InstallDir, "update")
		defer stopBeat()
	}

	// Hộp thư Console (internal/hostlink): tiến trình NGOÀI CÙNG (không phải bản
	// re-exec sau tự cập nhật) xoá yêu cầu "Cập nhật ngay" TRƯỚC khi chạy — để
	// watcher không kích lặp — rồi báo "running" cho Console hiện tiến trình.
	// Chụp nguyên hộp thư TRƯỚC khi báo "running": lịch đêm gặp bản bị chặn thì
	// trả về đúng như cũ (skipBlockedUpdate).
	//
	// Lịch đêm chạy ĐÚNG lúc Owner vừa bấm "Cập nhật ngay"/"Thử lại" (watcher
	// chưa kịp gọi): lịch đêm đã nuốt yêu cầu thì phải làm như --if-requested
	// (không bị chặn, không đợi chín) — nếu không yêu cầu mất không dấu vết.
	var statusSnap []byte
	hadStatus, hadRequest := false, false
	if !f.selfUpdated {
		statusSnap, hadStatus = hostlink.SnapshotStatus(env.InstallDir)
		hadRequest = hostlink.ConsumeRequest(env.InstallDir)
		_ = hostlink.Start(env.InstallDir, version)
	}
	requested := f.ifRequested || hadRequest
	minAge := selfUpdateMinAge(f.yes, requested)

	// Tự cập nhật BINARY genh TRƯỚC KHI đụng gì tới dịch vụ — xem
	// internal/selfupdate. Bỏ qua nếu: --no-self-update, HOẶC tiến trình
	// này đã là kết quả của một lần tự cập nhật (--self-updated, tránh lặp
	// vô hạn tự-tải-tự-re-exec nếu có gì đó luôn báo "mới hơn" sai).
	deferred := false
	if !f.noSelfUpdate && !f.selfUpdated {
		code, ok, d := trySelfUpdateAndReExec(ctx, childUpdateArgs(args, f.ifRequested, requested), f.quiet, minAge)
		deferred = d
		if ok {
			// Bản mới (tiến trình con) tự ghi kết quả; con chết giữa chừng thì
			// trạng thái vẫn "running" — báo lỗi thay nó để Console không chờ mãi.
			// Không chạy được con vì tín hiệu dừng tới ngay sau khi tải genh mới
			// (code == exitStoppedBeforeReExec): chưa đụng gì — GH-E94B.
			if st, err := hostlink.ReadStatus(env.InstallDir); code != 0 && err == nil && st.State == "running" {
				_ = hostlink.Finish(env.InstallDir, "failed", "", childFailedMessage(code == exitStoppedBeforeReExec, context.Cause(ctx)))
			}
			if code == exitStoppedBeforeReExec {
				return 1
			}
			return code
		}
	}

	// Có cần chạy phần nâng cấp dịch vụ không (F-10 bước 3, F-33 bước 5): lịch
	// đêm không thử lại bản đã rollback; dịch vụ đã khớp bản genh này thì không
	// sao lưu/tải ảnh vô ích mỗi đêm.
	blocked, _, _ := hostlink.ReadUpdateBlocked(env.InstallDir)
	inSync, _ := ops.UpdateNeeded(env) // lỗi → false: để RunUpdate tự báo lỗi đúng khuôn
	switch skip, kind := decideServiceUpdate(serviceUpdateInput{
		Scheduled:      f.yes && !requested,
		SelfUpdated:    f.selfUpdated,
		Version:        version,
		InSync:         inSync,
		BlockedVersion: blocked.Version,
	}); {
	case skip && kind == "blocked":
		// In ra stdout CẢ khi --quiet để vào logs/auto-update.log.
		skipBlockedUpdate(os.Stdout, env.InstallDir, version, blocked, statusSnap, hadStatus, f.selfUpdated)
		return 0
	case skip && kind == "up-to-date":
		fmt.Println(upToDateLine(version))
		_ = hostlink.Finish(env.InstallDir, "done", version, "")
		publishHostInfo(env.InstallDir, env.Port)
		if deferred {
			fmt.Println(updateDoneLine(true))
		}
		return 0
	}

	out := io.Writer(os.Stdout)
	if f.quiet {
		out = io.Discard
	}
	opts := ops.UpdateOptions{Channel: f.channel, Version: version}
	if err := ops.RunUpdate(ctx, env, opts, ops.UpdateDeps{}, out); err != nil {
		reportOpErr(err)
		_ = hostlink.Finish(env.InstallDir, "failed", version, consoleUpdateMessage(err))
		return 1
	}
	_ = hostlink.Finish(env.InstallDir, "done", version, "")
	publishHostInfo(env.InstallDir, env.Port)
	if deferred {
		fmt.Println(deferredAfterRunLine)
	} else if f.quiet {
		fmt.Println(updateDoneLine(false))
	}
	return 0
}

// childUpdateArgs: args cho tiến trình re-exec sau khi tự thay binary. Tiến
// trình ngoài đã nuốt yêu cầu Console (lịch đêm trùng lúc Owner bấm) thì con
// không còn thấy yêu cầu — thêm --if-requested để con cũng không bị chặn.
func childUpdateArgs(args []string, ifRequested, requested bool) []string {
	if requested && !ifRequested {
		return append(append([]string{}, args...), "--if-requested")
	}
	return args
}

// serviceUpdateInput là dữ kiện để quyết định có chạy ops.RunUpdate không.
type serviceUpdateInput struct {
	Scheduled      bool   // lịch đêm: --yes không kèm --if-requested
	SelfUpdated    bool   // tiến trình vừa re-exec sau khi tự thay binary
	Version        string // main.version
	InSync         bool   // compose.yaml + Caddyfile đã khớp bản nhúng (ops.UpdateNeeded)
	BlockedVersion string // version trong run/update-blocked.json ("" nếu không có)
}

// decideServiceUpdate (hàm thuần) quyết định bỏ qua phần nâng cấp dịch vụ:
//  1. lịch đêm + bản đang chạy đúng là bản đã bị chặn (so khớp CHÍNH XÁC) →
//     "blocked" — "Cập nhật ngay" và gõ tay luôn được chạy;
//  2. không vừa tự cập nhật + dịch vụ đã khớp bản genh này → "up-to-date";
//  3. còn lại chạy RunUpdate (skip=false, kind="").
func decideServiceUpdate(in serviceUpdateInput) (skip bool, kind string) {
	if in.Scheduled && in.BlockedVersion != "" && in.BlockedVersion == in.Version {
		return true, "blocked"
	}
	if !in.SelfUpdated && in.InSync {
		return true, "up-to-date"
	}
	return false, ""
}

// blockedLine: dòng log khi lịch đêm bỏ qua bản đã bị chặn (E2E grep "lịch đêm
// không tự thử lại"). Quay về bản cũ đã THẤT BẠI (b.RollbackFailed) thì KHÔNG
// được nói "đã tự quay về bản cũ" — máy đang cần xử lý tay.
func blockedLine(v string, b hostlink.UpdateBlocked) string {
	if b.RollbackFailed {
		return "genh: bản " + v + " đã lỗi ở lần cập nhật trước và tự quay về bản cũ CŨNG THẤT BẠI — cần xử lý tay ngay" + backupHint(b) + ". Lịch đêm không tự thử lại bản này."
	}
	return "genh: bản " + v + " đã lỗi ở lần cập nhật trước và đã tự quay về bản cũ — lịch đêm không tự thử lại bản này. Có bản mới hơn sẽ tự cài; muốn thử lại ngay: bấm \"Cập nhật ngay\" trong Console hoặc chạy genh update."
}

// backupHint: cách xử lý tay khi quay về bản cũ thất bại. CSDL đã bị đụng (có
// BackupKey — genh chỉ ghi khoá khi đó) → khôi phục bản sao lưu rồi up -d. CSDL
// CHƯA bị đụng → TUYỆT ĐỐI không khôi phục (worker/bridge/api vẫn ghi sau lúc
// sao lưu — khôi phục sẽ xoá mất), chỉ up -d.
func backupHint(b hostlink.UpdateBlocked) string {
	if b.BackupKey != "" {
		return " (khôi phục bản sao lưu " + b.BackupKey + " rồi chạy docker compose up -d --remove-orphans — xem logs/auto-update.log)"
	}
	if !b.DBTouched {
		return " (CSDL chưa bị đụng — KHÔNG khôi phục bản sao lưu, chỉ chạy docker compose up -d --remove-orphans — xem logs/auto-update.log)"
	}
	return " (xem logs/auto-update.log)"
}

// blockedConsoleMessage: thông điệp hộp thư Console khi tiến trình re-exec (vừa
// tự thay binary) gặp bản bị chặn — tiến trình ngoài đã ghi "running" nên phải
// kết thúc nó. Tiến trình ngoài thì KHÔNG dùng hàm này (trả hộp thư về như cũ).
func blockedConsoleMessage(v string, b hostlink.UpdateBlocked) string {
	if b.RollbackFailed {
		return "Bản " + v + " đã lỗi ở lần cập nhật trước và tự quay về bản cũ CŨNG THẤT BẠI — cần xử lý tay ngay" + backupHint(b) + ". Lịch đêm không tự thử lại bản này. (" + ops.ErrCodeUpdateBlocked + ")"
	}
	return "Bản " + v + " đã lỗi ở lần cập nhật trước và đã tự quay về bản cũ — lịch đêm không tự thử lại bản này. Bấm \"Cập nhật ngay\" để thử lại. (" + ops.ErrCodeUpdateBlocked + ")"
}

// skipBlockedUpdate: lịch đêm gặp đúng bản đã bị chặn — chỉ in một dòng log và
// để NGUYÊN update-status.json như lần cập nhật lỗi để lại (statusSnap chụp
// trước Start): không làm mới finished_at mỗi đêm (thẻ đỏ của Console tự hết
// sau 24 giờ), không ghi đè thông điệp gốc (mã lỗi, lý do, bản sao lưu, hoặc
// cảnh báo quay về bản cũ thất bại). selfUpdated: tiến trình này không có ảnh
// chụp (tiến trình ngoài đã báo "running") → kết thúc bằng thông điệp chặn.
func skipBlockedUpdate(w io.Writer, installDir, v string, b hostlink.UpdateBlocked, statusSnap []byte, hadStatus, selfUpdated bool) {
	_, _ = fmt.Fprintln(w, blockedLine(v, b))
	if !selfUpdated {
		_ = hostlink.RestoreStatusSnapshot(installDir, statusSnap, hadStatus)
		return
	}
	_ = hostlink.Finish(installDir, "failed", v, blockedConsoleMessage(v, b))
}

// consoleUpdateMessage dựng thông điệp lỗi cho hộp thư Console từ lỗi của
// ops.RunUpdate: "<What> — <Next> (<mã>)" — Console chọn lời dẫn theo mã (vd
// GH-E948 ổ đĩa đầy: Owner PHẢI dọn đĩa) và hiện phần còn lại trong "Chi tiết
// kỹ thuật". Ổ đĩa đầy kèm Why (còn bao nhiêu GB / cần bao nhiêu). Bỏ dấu `
// (định dạng lệnh cho terminal, Console hiện chữ thường).
func consoleUpdateMessage(err error) string {
	opErr, ok := err.(*ops.OpError)
	if !ok {
		return err.Error()
	}
	msg := opErr.What
	if opErr.Code == ops.ErrCodeUpdateDiskLow && opErr.Why != "" {
		msg += " (" + opErr.Why + ")"
	}
	if opErr.Next != "" {
		msg += " — " + opErr.Next
	}
	if opErr.Code != "" {
		msg += " (" + opErr.Code + ")"
	}
	return strings.ReplaceAll(msg, "`", "")
}

// upToDateLine: dòng log khi dịch vụ đã đúng bản (E2E grep "không cần cập nhật").
func upToDateLine(v string) string {
	return "genh: dịch vụ đã ở đúng bản " + v + " — không cần cập nhật (không sao lưu, không tải ảnh). Dịch vụ đang dừng/lỗi thì chạy genh start."
}

// deferredAfterRunLine: RunUpdate ĐÃ chạy xong bằng bản genh hiện tại nhưng bản
// genh mới hơn đang bị thời gian chín hoãn — KHÔNG in "genh: cập nhật xong."
// (người đọc log sẽ tưởng bản mới đã cài).
const deferredAfterRunLine = "genh: dịch vụ đã nâng cấp theo bản genh hiện tại — bản genh mới đang đợi đủ 24 giờ (thời gian chín) mới tự cài."

// updateDoneLine là dòng kết vào logs/auto-update.log. Bản genh mới bị thời
// gian chín hoãn (deferred) và dịch vụ đã khớp bản hiện tại → không có gì để
// cập nhật; KHÔNG được in "genh: cập nhật xong." — chỉ in câu đó khi RunUpdate
// thật sự chạy xong.
func updateDoneLine(deferred bool) string {
	if deferred {
		return "genh: không có gì để cập nhật — bản genh mới đang đợi đủ 24 giờ (thời gian chín) mới tự cài."
	}
	return "genh: cập nhật xong."
}

// selfUpdateMinAge chọn thời gian chín (selfupdate.Options.MinAge) cho bước
// tự cập nhật binary theo cách `genh update` được gọi:
//   - timer đêm gọi `update --yes --quiet` (internal/autoupdate/content.go)
//     ⇒ --yes, không --if-requested ⇒ selfupdate.NightlyMinAge (24 giờ): bản
//     vừa lên bản chính thức chưa đủ 24 giờ thì đợi đêm sau;
//   - nút "Cập nhật ngay" trong Console đi qua `genh handle-requests` →
//     `update --yes --if-requested` (handleRequestUpdateArgs) ⇒ 0, không chặn;
//   - Owner gõ tay `genh update` (không --yes) ⇒ 0, không chặn.
//
// Cờ kích hoạt CỐ Ý là --yes chứ không phải một cờ nội bộ riêng (kiểu
// --scheduled): unit systemd/crontab/LaunchAgent/schtasks chỉ được ghi lúc
// `genh install`/`genh auto-update enable` — `genh update` không ghi lại —
// nên mọi máy đã cài đều đang chạy `update --yes --quiet`; đổi sang cờ mới
// sẽ làm các máy đó âm thầm mất cổng 24 giờ. Đổi lại: ai gõ tay
// `genh update --yes` cũng bị đợi; dòng lý do (selfupdate) nói rõ "chế độ
// --yes" và cách cài ngay (bỏ --yes / nút "Cập nhật ngay").
func selfUpdateMinAge(yes, ifRequested bool) time.Duration {
	if yes && !ifRequested {
		return selfupdate.NightlyMinAge
	}
	return 0
}

// trySelfUpdateAndReExec chạy internal/selfupdate.Run; nếu binary vừa được
// thay trên đĩa, RE-EXEC chính nó (cùng đường dẫn, giờ đã là bản MỚI) với
// đúng args gốc + "--self-updated", CHỜ tiến trình con chạy hết phần còn lại
// của `genh update` rồi trả (mã thoát của con, true). Trả (0, false) nếu
// không tự cập nhật gì (đã mới nhất/bản dev/lỗi mạng) — caller tiếp tục chạy
// phần nâng cấp dịch vụ bằng CHÍNH tiến trình hiện tại, không re-exec.
//
// Lý do BẮT BUỘC phải re-exec thay vì tự chạy tiếp trong cùng tiến trình:
// tiến trình đang chạy đã nạp SẴN code + compose.yaml nhúng của bản CŨ vào
// bộ nhớ — chỉ thay tệp trên đĩa không đổi gì tiến trình đang chạy đang
// dùng. Phần đồng bộ compose.yaml (ops.RunUpdate, bước 1.5) PHẢI chạy bằng
// code MỚI để lấy đúng compose.yaml nhúng của bản mới.
//
// minAge là thời gian chín truyền thẳng vào selfupdate.Options.MinAge (xem
// selfUpdateMinAge) — bản chưa đủ chín: Run trả Skipped/Deferred, hàm này
// trả (0, false, true): caller chạy phần dịch vụ như khi đã mới nhất nhưng
// biết là có bản mới đang đợi (dòng kết không được nói "cập nhật xong").
//
// ctx (signalContext của tiến trình ngoài): tự cập nhật dừng theo tín hiệu; khi
// đang chờ tiến trình con mà ctx bị huỷ (systemd KillMode=mixed chỉ gửi SIGTERM
// cho tiến trình CHÍNH) thì chuyển tiếp SIGTERM cho con và TIẾP TỤC chờ con
// quay về bản cũ xong — không Kill con.
func trySelfUpdateAndReExec(ctx context.Context, originalArgs []string, quiet bool, minAge time.Duration) (exitCode int, reExeced bool, deferred bool) {
	execPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "genh: không tự cập nhật binary được (không xác định được đường dẫn của chính nó): %v — tiếp tục với bản hiện tại.\n", err)
		return 0, false, false
	}
	execPath, _ = filepath.Abs(execPath)

	res, err := selfupdate.Run(ctx, selfupdate.Options{
		Owner: selfupdateOwner, Repo: selfupdateRepo,
		CurrentVersion: version,
		GOOS:           runtime.GOOS, GOARCH: runtime.GOARCH,
		ExecutablePath: execPath,
		Out:            os.Stdout,
		Quiet:          quiet,
		MinAge:         minAge,
	})
	if err != nil {
		// Tải/kiểm checksum/thay binary thất bại: KHÔNG chặn `genh update`
		// — báo rõ rồi tiếp tục nâng cấp dịch vụ bằng binary hiện tại.
		fmt.Fprintf(os.Stderr, "genh: tự cập nhật binary thất bại (%v) — tiếp tục nâng cấp dịch vụ với bản genh hiện tại.\n", err)
		return 0, false, false
	}
	if !res.Updated {
		return 0, false, res.Deferred
	}

	newArgs := append(append([]string{}, originalArgs...), "--self-updated")
	child := exec.Command(execPath, append([]string{"update"}, newArgs...)...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := runChildForwardingSignal(ctx, child); err != nil {
		if errors.Is(err, errStoppedBeforeReExec) {
			fmt.Fprintf(os.Stderr, "genh: nhận tín hiệu dừng ngay sau khi tải genh %s — chưa đụng gì tới dịch vụ; lần sau (lịch đêm hoặc genh update) sẽ làm tiếp.\n", res.To)
			return exitStoppedBeforeReExec, true, false
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), true, false
		}
		fmt.Fprintf(os.Stderr, "genh: chạy lại genh %s sau tự cập nhật thất bại: %v\n", res.To, err)
		return 1, true, false
	}
	return 0, true, false
}

// exitStoppedBeforeReExec: mã nội bộ trySelfUpdateAndReExec trả khi KHÔNG chạy
// được genh bản mới vì tín hiệu dừng (errStoppedBeforeReExec) — caller ghi
// Console GH-E94B "chưa đụng gì" rồi thoát mã 1 (không lộ mã này ra ngoài).
const exitStoppedBeforeReExec = -2

// childFailedMessage: thông điệp Console khi tiến trình con (genh bản mới) không
// ghi được kết quả. stoppedBeforeChild: tín hiệu dừng tới trước khi chạy con —
// chưa đụng gì (GH-E94B, Console hiện thẻ "dừng giữa chừng — chưa đụng gì",
// không phải thẻ lỗi đỏ "đã tự quay về").
func childFailedMessage(stoppedBeforeChild bool, cause error) string {
	if stoppedBeforeChild {
		if cause == nil {
			cause = errStoppedBeforeReExec
		}
		return consoleUpdateMessage(ops.InterruptedBeforeTouch(cause))
	}
	return "Cập nhật dừng giữa chừng — xem logs/auto-update.log"
}

// errStoppedBeforeReExec: tín hiệu dừng tới trước khi kịp chạy genh bản mới.
var errStoppedBeforeReExec = errors.New("nhận tín hiệu dừng trước khi chạy genh bản mới")

// runChildForwardingSignal chạy child và chờ nó xong; trong lúc chờ, ctx bị huỷ
// (tín hiệu dừng tới tiến trình này) ⇒ chuyển tiếp SIGTERM cho con một lần rồi
// VẪN chờ (con tự quay về bản cũ — xem ops.rollbackAndWrap). Windows không gửi
// được SIGTERM/Interrupt cho tiến trình khác ⇒ chỉ ghi log (con cùng console
// vẫn nhận Ctrl-C của chính nó). ctx ĐÃ bị huỷ trước khi chạy ⇒ KHÔNG chạy con
// (con chưa kịp cài bộ bắt tín hiệu sẽ bị giết ngay, không ghi được kết quả) —
// trả errStoppedBeforeReExec.
func runChildForwardingSignal(ctx context.Context, child *exec.Cmd) error {
	if ctx.Err() != nil {
		return errStoppedBeforeReExec
	}
	if err := child.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-done:
		case <-ctx.Done():
			if runtime.GOOS == "windows" {
				fmt.Fprintln(os.Stderr, "genh: nhận tín hiệu dừng — đang chờ genh bản mới chạy xong (Windows không chuyển tiếp được tín hiệu).")
				return
			}
			fmt.Fprintln(os.Stderr, "genh: nhận tín hiệu dừng — chuyển cho genh bản mới để quay về bản cũ rồi dừng…")
			_ = child.Process.Signal(forwardSignal(ctx))
		}
	}()
	return child.Wait()
}

func runAutoUpdate(args []string) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(os.Stderr, "genh: cách dùng: genh auto-update enable|disable|status")
		return 2
	}
	fs, port, installDir := opsFlagSet("auto-update " + args[0])
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}

	execPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "genh: không xác định được đường dẫn của chính genh: %v\n", err)
		return 1
	}
	execPath, _ = filepath.Abs(execPath)
	logFile := filepath.Join(config.New(env.InstallDir).LogsDir(), "auto-update.log")

	ctx, stop := signalContext()
	defer stop()
	deps := autoupdate.Deps{GenhPath: execPath, LogFile: logFile}

	switch args[0] {
	case "enable":
		if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "genh: không tạo được thư mục log: %v\n", err)
			return 1
		}
		msg, err := autoupdate.Enable(ctx, deps)
		if err != nil {
			fmt.Fprintf(os.Stderr, "genh: bật tự cập nhật hằng đêm thất bại: %v\n", err)
			return 1
		}
		// v0.1.33: báo Console (genh.json) lịch đêm đã bật — lỗi ghi chỉ làm Console không hứa "Tự cài".
		_ = hostlink.SetAutoUpdate(env.InstallDir, version, true)
		fmt.Println(msg)
		return 0
	case "disable":
		msg, err := autoupdate.Disable(ctx, deps)
		if err != nil {
			fmt.Fprintf(os.Stderr, "genh: tắt tự cập nhật hằng đêm thất bại: %v\n", err)
			return 1
		}
		_ = hostlink.SetAutoUpdate(env.InstallDir, version, false)
		fmt.Println(msg)
		return 0
	case "status":
		st, err := autoupdate.GetStatus(ctx, deps)
		if err != nil {
			fmt.Fprintf(os.Stderr, "genh: kiểm trạng thái tự cập nhật thất bại: %v\n", err)
			return 1
		}
		state := "TẮT"
		if st.Enabled {
			state = "BẬT"
		}
		fmt.Printf("Tự cập nhật hằng đêm: %s\n  %s\n", state, st.Detail)
		return 0
	default:
		_, _ = fmt.Fprintf(os.Stderr, "genh: lệnh con auto-update không rõ %q (dùng enable|disable|status)\n", args[0])
		return 2
	}
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
	ctx, stop := signalContext()
	defer stop()
	if err := ops.RunBackup(ctx, env, *to, nil, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runRestore(args []string) int {
	fs, port, installDir := opsFlagSet("restore")
	ifRequested := fs.Bool("if-requested", false, "khôi phục bản Owner vừa chọn trong Console (request/restore.json — watcher gọi); không có yêu cầu thì thoát ngay")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if !*ifRequested && fs.NArg() != 1 {
		_, _ = fmt.Fprintln(os.Stderr, "genh: cách dùng: genh restore <khoá-backup>   (hoặc --if-requested)")
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signalContext()
	defer stop()
	// Khoá loại trừ (v0.1.37): cùng khoá với update/import — --if-requested chờ
	// tối đa requestLockWait, gõ tay bận ⇒ thoát 1 (GH-E94A).
	mode := lockManual
	if *ifRequested {
		if !hostlink.HasRestoreRequest(env.InstallDir) {
			return 0
		}
		mode = lockRequested
	}
	lock, code, ok := acquireOpLock(ctx, env.InstallDir, mode, func() bool { return hostlink.HasRestoreRequest(env.InstallDir) }, os.Stdout, os.Stderr)
	if !ok {
		return code
	}
	defer lock.Release()
	stopBeat := hostlink.StartHeartbeat(env.InstallDir, "restore")
	defer stopBeat()
	if *ifRequested {
		handled, err := ops.RunRestoreRequest(ctx, env, ops.RestoreDeps{}, os.Stdout)
		if err != nil {
			reportOpErr(err)
			return 1
		}
		if handled {
			fmt.Println("genh: khôi phục xong.")
		}
		return 0
	}
	if _, err := ops.RunRestore(ctx, env, fs.Arg(0), ops.RestoreDeps{}, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

// runHandleRequests là lệnh watcher trên máy chủ gọi (internal/autoupdate):
// đọc hộp thư run/request và chuyển sang đúng lệnh — cập nhật trước (tự sao
// lưu), khôi phục sau. Hộp thư trống thì thoát ngay. KHÔNG tự lấy khoá loại
// trừ: runUpdate/runRestore bên trong lấy (chờ tối đa requestLockWait).
func runHandleRequests(args []string) int {
	fs, port, installDir := opsFlagSet("handle-requests")
	quiet := fs.Bool("quiet", false, "chỉ in các dòng quan trọng")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	dir, err := ops.ResolveInstallDir(*installDir)
	if err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "genh: không xác định được thư mục cài đặt: %v\n", err)
		return 1
	}
	pass := []string{"--port", strconv.Itoa(*port), "--install-dir", dir}
	switch hostlink.Pending(dir) {
	case "update":
		return runUpdate(append(handleRequestUpdateArgs(*quiet), pass...))
	case "restore":
		return runRestore(append([]string{"--if-requested"}, pass...))
	default:
		return 0
	}
}

// handleRequestUpdateArgs là cờ runHandleRequests chuyển cho runUpdate khi
// Owner bấm "Cập nhật ngay": --yes (không tương tác) + --if-requested (chỉ
// chạy khi còn yêu cầu trong hộp thư) — có --if-requested nên
// selfUpdateMinAge trả 0, nút "Cập nhật ngay" KHÔNG bị thời gian chín chặn.
func handleRequestUpdateArgs(quiet bool) []string {
	upd := []string{"--yes", "--if-requested"}
	if quiet {
		upd = append(upd, "--quiet")
	}
	return upd
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
	ctx, stop := signalContext()
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

func runResetPassword(args []string) int {
	fs, port, installDir := opsFlagSet("reset-password")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signalContext()
	defer stop()
	if err := ops.RunResetPassword(ctx, env, nil, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runTrustCA(args []string) int {
	fs, port, installDir := opsFlagSet("trust-ca")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signalContext()
	defer stop()
	// interactive: Owner đang ngồi trước máy — macOS/Windows được phép bật hộp thoại xác nhận.
	if err := ops.RunTrustCA(ctx, env, true, ops.TrustCADeps{}, os.Stdout); err != nil {
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
	// --yes: cần cho kịch bản không tương tác (CI e2e, script) — trước phiên
	// này ops.UninstallOptions.AutoApprove chỉ dùng được từ test Go gọi thẳng
	// RunUninstall, CLI không có cách bật (xem comment cũ ở
	// internal/ops/uninstall.go). Đọc kỹ tài liệu (docs/handoff/05-installer.md
	// mục "Lệnh vận hành") trước khi đổi mô tả cờ ở đó.
	yes := fs.Bool("yes", false, "bỏ qua hỏi xác nhận (dùng cho script/CI không có TTY) — vẫn xoá dữ liệu như bình thường nếu không kèm --keep-data")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	opts := ops.UninstallOptions{KeepData: *keepData, AutoApprove: *yes}
	if err := ops.RunUninstall(context.Background(), env, opts, nil, os.Stdin, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	// Gỡ luôn lịch tự cập nhật hằng đêm + watcher "Cập nhật ngay" — không để lại
	// dòng cron/unit systemd gọi một bản cài đã gỡ.
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	deps := autoupdate.Deps{}
	autoupdate.DisableRequestWatcher(ctx, deps)
	_, _ = autoupdate.Disable(ctx, deps)
	return 0
}

func runExport(args []string) int {
	fs, port, installDir := opsFlagSet("export")
	to := fs.String("to", "", "đường dẫn tệp .ghbundle sẽ ghi ra (bắt buộc)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *to == "" {
		_, _ = fmt.Fprintln(os.Stderr, "genh: cách dùng: genh export --to <file>")
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signalContext()
	defer stop()
	if err := ops.RunExport(ctx, env, *to, ops.ExportDeps{}, os.Stdout); err != nil {
		reportOpErr(err)
		return 1
	}
	return 0
}

func runImport(args []string) int {
	fs, port, installDir := opsFlagSet("import")
	yes := fs.Bool("yes", false, "bỏ qua hỏi xác nhận GHI ĐÈ dữ liệu hiện tại")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 1 {
		_, _ = fmt.Fprintln(os.Stderr, "genh: cách dùng: genh import <file> [--yes]")
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signalContext()
	defer stop()
	// Khoá loại trừ (v0.1.37): import ghi đè CSDL — không chạy chồng update/restore.
	lock, code, ok := acquireOpLock(ctx, env.InstallDir, lockManual, nil, os.Stdout, os.Stderr)
	if !ok {
		return code
	}
	defer lock.Release()
	stopBeat := hostlink.StartHeartbeat(env.InstallDir, "import")
	defer stopBeat()
	opts := ops.ImportOptions{AutoApprove: *yes}
	if err := ops.RunImport(ctx, env, fs.Arg(0), opts, ops.ImportDeps{}, os.Stdin, os.Stdout); err != nil {
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
	force := fs.Bool("force", false, "bỏ qua kiểm tra máy đã cài — CHẠY LẠI cả 8 bước dù đã có bản cài hoàn chỉnh (dùng khi lần cài trước hỏng hẳn, cần dựng lại từ đầu; bình thường hãy dùng `genh update`)")
	noAutoUpdate := fs.Bool("no-auto-update", false, "không tự bật lịch cập nhật hằng đêm (mặc định BẬT sau khi cài xong — xem `genh auto-update`)")
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

	// SỬA LỖI (docs/reports/HANDOFF-v0.1.1.md mục "Lỗi cần sửa" #2 của
	// v0.1.3): `genh install` trên một máy ĐÃ CÀI HOÀN CHỈNH sẽ chạy lại cả 8
	// Bước, dựng lại container VÀ BỎ QUA backup/di trú dữ liệu mà chỉ `genh
	// update` mới có — dừng SỚM ở đây, trước khi đụng gì, trừ khi Owner đã tự
	// xác nhận bằng --force.
	if !*force && install.DetectExistingInstall(context.Background(), dockercli.ExecRunner{}, dir) {
		se := &install.StepError{
			Code: install.ErrCodeAlreadyInstalled,
			What: "Gen-Harness ĐÃ CÀI XONG tại " + dir + " — DỪNG LẠI, chưa đụng gì",
			Why:  "phát hiện secrets.json và container \"api\" đã tồn tại — chạy lại `genh install` sẽ dựng lại container, BỎ QUA backup tự động + di trú dữ liệu mà chỉ `genh update` mới làm.",
			Next: "Chạy `genh update` để nâng cấp an toàn (có backup + rollback tự động). Nếu lần cài trước thật sự CHƯA XONG (Owner biết rõ), chạy lại kèm `genh install --force`.",
		}
		fmt.Println()
		fmt.Printf("Lỗi %s: %s\n", se.Code, se.What)
		fmt.Printf("  vì sao: %s\n", se.Why)
		fmt.Printf("  làm gì tiếp: %s\n", se.Next)
		return 1
	}

	env := &install.Env{InstallDir: dir, Port: *port, AutoApprove: *yes}
	runner := install.NewRunner(env, install.Registry())

	ctx, stop := signalContext()
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

	// Bước "Hoàn tất" của người cài đặt không rành code THẬT SỰ chỉ hoàn tất
	// khi máy KHÔNG cần họ làm gì thêm để có bản mới sau này — nên bật lịch
	// tự cập nhật hằng đêm ngay tại đây, mặc định, trừ khi có --no-auto-update.
	// Bật lỗi CHỈ cảnh báo (fmt.Fprintln ra stderr), KHÔNG BAO GIỜ làm hỏng
	// một lần cài đặt vừa xong thành công — Owner vẫn dùng được Gen-Harness
	// bình thường, chỉ là phải tự chạy `genh update` tay hoặc `genh
	// auto-update enable` lại sau.
	if !*noAutoUpdate {
		enableAutoUpdateAfterInstall(dir)
	}
	publishHostInfo(dir, *port)

	return 0
}

// enableAutoUpdateAfterInstall bật internal/autoupdate ngay sau khi cài xong
// — xem ghi chú ở nơi gọi. In đúng MỘT dòng rõ ràng khi thành công (yêu cầu
// của phiên v0.1.5), hoặc một dòng cảnh báo ngắn khi thất bại.
func enableAutoUpdateAfterInstall(installDir string) {
	execPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "genh: không bật được tự cập nhật hằng đêm (không xác định được đường dẫn genh): %v — chạy tay `genh auto-update enable` sau.\n", err)
		return
	}
	execPath, _ = filepath.Abs(execPath)
	logFile := filepath.Join(config.New(installDir).LogsDir(), "auto-update.log")
	if err := os.MkdirAll(filepath.Dir(logFile), 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "genh: không bật được tự cập nhật hằng đêm (không tạo được thư mục log): %v — chạy tay `genh auto-update enable` sau.\n", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	msg, err := autoupdate.Enable(ctx, autoupdate.Deps{GenhPath: execPath, LogFile: logFile})
	if err != nil {
		fmt.Fprintf(os.Stderr, "genh: không bật được tự cập nhật hằng đêm tự động (%v) — chạy tay `genh auto-update enable`, hoặc bỏ qua nếu không cần.\n", err)
		return
	}
	fmt.Println(msg)
}

// publishHostInfo cài (idempotent) watcher nhận yêu cầu "Cập nhật ngay" từ
// Console rồi ghi phiên bản + cơ chế vào hộp thư (run/genh.json) cho Console
// đọc. Lỗi chỉ làm nút trong Console hiện lệnh tay thay vì bấm được — không
// bao giờ làm hỏng install/update vừa xong.
func publishHostInfo(installDir string, port int) {
	updater := ""
	var autoUpdate *bool
	if execPath, err := os.Executable(); err == nil {
		execPath, _ = filepath.Abs(execPath)
		logFile := filepath.Join(config.New(installDir).LogsDir(), "auto-update.log")
		_ = os.MkdirAll(filepath.Dir(logFile), 0o755)
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		rp := autoupdate.RequestPaths{InstallDir: installDir, RequestDir: hostlink.RequestDirPath(installDir), RequestFile: hostlink.RequestPath(installDir),
			RestoreFile: hostlink.RestoreRequestPath(installDir)}
		if port != machine.DefaultPort {
			rp.Port = port
		}
		if v := os.Getenv(compose.EnvOverrideVar); v != "" {
			rp.Env = append(rp.Env, compose.EnvOverrideVar+"="+v)
		}
		deps := autoupdate.Deps{GenhPath: execPath, LogFile: logFile}
		// v0.1.37: unit lịch đêm chỉ được ghi lúc install/enable — máy cài từ bản
		// cũ cần ghi lại để có KillMode=mixed/TimeoutStopSec (không bật/tắt gì).
		if changed, err := autoupdate.RefreshUnits(ctx, deps); err != nil {
			fmt.Fprintf(os.Stderr, "genh: cảnh báo — không làm mới được unit lịch tự cập nhật: %v\n", err)
		} else if changed {
			fmt.Println("genh: đã thêm KillMode=mixed/TimeoutStopSec vào unit lịch tự cập nhật (~/.config/systemd/user/" + autoupdate.TaskName + ".service) — các dòng khác giữ nguyên.")
		}
		if u, err := autoupdate.EnsureRequestWatcher(ctx, deps, rp); err == nil {
			updater = u
		}
		// v0.1.33: Console chỉ hứa "Tự cài đêm …" khi lịch đêm thật sự đang bật.
		if st, err := autoupdate.GetStatus(ctx, deps); err == nil {
			enabled := st.Enabled
			autoUpdate = &enabled
		}
	}
	_ = hostlink.WriteInfo(installDir, version, updater, autoUpdate)

	// v0.1.37 (F-73): làm mới run/autostart-status.json để Console nhắc Owner
	// khi Docker/linger không tự chạy lại sau khởi động — lịch đêm cũng gọi tới
	// đây nên Owner không phải chạy `genh status`. Lỗi bỏ qua.
	actx, acancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer acancel()
	_ = hostlink.WriteAutostartStatus(installDir, ops.CheckAutostart(actx, ops.AutostartDeps{}))
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
