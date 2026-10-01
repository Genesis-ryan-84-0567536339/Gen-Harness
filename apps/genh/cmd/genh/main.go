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
                                          binary genh
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
	noSelfUpdate := fs.Bool("no-self-update", false, "bỏ qua tự cập nhật BINARY genh — chỉ chạy phần nâng cấp dịch vụ (backup/pull/migrate/restart) bằng bản genh hiện tại")
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
	minAge := selfUpdateMinAge(f.yes, f.ifRequested)

	env, ok := resolveOpsEnv(f.port, f.installDir)
	if !ok {
		return 1
	}

	// Hộp thư Console (internal/hostlink): tiến trình NGOÀI CÙNG (không phải bản
	// re-exec sau tự cập nhật) xoá yêu cầu "Cập nhật ngay" TRƯỚC khi chạy — để
	// watcher không kích lặp — rồi báo "running" cho Console hiện tiến trình.
	if !f.selfUpdated {
		if f.ifRequested && !hostlink.HasRequest(env.InstallDir) {
			return 0
		}
		hostlink.ConsumeRequest(env.InstallDir)
		_ = hostlink.Start(env.InstallDir, version)
	}

	// Tự cập nhật BINARY genh TRƯỚC KHI đụng gì tới dịch vụ — xem
	// internal/selfupdate. Bỏ qua nếu: --no-self-update, HOẶC tiến trình
	// này đã là kết quả của một lần tự cập nhật (--self-updated, tránh lặp
	// vô hạn tự-tải-tự-re-exec nếu có gì đó luôn báo "mới hơn" sai).
	deferred := false
	if !f.noSelfUpdate && !f.selfUpdated {
		code, ok, d := trySelfUpdateAndReExec(args, f.quiet, minAge)
		deferred = d
		if ok {
			// Bản mới (tiến trình con) tự ghi kết quả; con chết giữa chừng thì
			// trạng thái vẫn "running" — báo lỗi thay nó để Console không chờ mãi.
			if st, err := hostlink.ReadStatus(env.InstallDir); code != 0 && err == nil && st.State == "running" {
				_ = hostlink.Finish(env.InstallDir, "failed", "", "Cập nhật dừng giữa chừng — xem logs/auto-update.log")
			}
			return code
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	out := io.Writer(os.Stdout)
	if f.quiet {
		out = io.Discard
	}
	opts := ops.UpdateOptions{Channel: f.channel}
	if err := ops.RunUpdate(ctx, env, opts, ops.UpdateDeps{}, out); err != nil {
		reportOpErr(err)
		msg := err.Error()
		if opErr, ok := err.(*ops.OpError); ok {
			msg = opErr.What
		}
		_ = hostlink.Finish(env.InstallDir, "failed", version, msg)
		return 1
	}
	_ = hostlink.Finish(env.InstallDir, "done", version, "")
	publishHostInfo(env.InstallDir, env.Port)
	if f.quiet {
		fmt.Println(updateDoneLine(deferred))
	}
	return 0
}

// updateDoneLine là dòng kết của `genh update --quiet` (vào
// logs/auto-update.log). Bản genh mới bị thời gian chín hoãn (deferred) thì
// KHÔNG được in "cập nhật xong." — người đọc log sẽ tưởng bản mới đã cài.
func updateDoneLine(deferred bool) string {
	if deferred {
		return "genh: dịch vụ đã kiểm/khởi động lại xong — bản genh mới đang đợi đủ 24 giờ (thời gian chín) mới tự cài."
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
func trySelfUpdateAndReExec(originalArgs []string, quiet bool, minAge time.Duration) (exitCode int, reExeced bool, deferred bool) {
	execPath, err := os.Executable()
	if err != nil {
		fmt.Fprintf(os.Stderr, "genh: không tự cập nhật binary được (không xác định được đường dẫn của chính nó): %v — tiếp tục với bản hiện tại.\n", err)
		return 0, false, false
	}
	execPath, _ = filepath.Abs(execPath)

	res, err := selfupdate.Run(context.Background(), selfupdate.Options{
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
	if err := child.Run(); err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return exitErr.ExitCode(), true, false
		}
		fmt.Fprintf(os.Stderr, "genh: chạy lại genh %s sau tự cập nhật thất bại: %v\n", res.To, err)
		return 1, true, false
	}
	return 0, true, false
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

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
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
// lưu), khôi phục sau. Hộp thư trống thì thoát ngay.
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

func runResetPassword(args []string) int {
	fs, port, installDir := opsFlagSet("reset-password")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	env, ok := resolveOpsEnv(*port, *installDir)
	if !ok {
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
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
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
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
