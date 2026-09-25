package ops

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// updateServiceOrder là các service compose có thể "cập nhật" qua
// `docker compose pull` — cùng danh sách 7 service của Bước 3 (internal/
// install/steps_pull.go pullServiceOrder), viết lại ở đây vì đó là biến
// không xuất của package khác.
var updateServiceOrder = []string{"db", "redis", "objects", "proxy", "api", "web", "bridge"}

// UpdateOptions là các cờ đã phân tích của `genh update`.
type UpdateOptions struct {
	// Channel là "stable" hoặc "beta" — THUẦN THÔNG TIN ở bản này: chưa có
	// pipeline phát hành thật gắn tag theo kênh (xem docs/handoff/
	// 05-installer.md mục "Phát hành", việc của một phiên khác đang làm
	// song song). genh update hiện chỉ `docker compose pull` bất kể Channel
	// là gì — Channel được validate và ghi vào log/Detail để không im lặng
	// bỏ qua lựa chọn của Owner, nhưng không đổi hành vi tải.
	Channel string
}

// UpdateDeps cho phép tiêm dockercli.Runner/http.Client giả + thời gian chờ
// ngắn hơn khi test.
type UpdateDeps struct {
	Runner    dockercli.Runner
	Client    *http.Client
	Timeout   time.Duration
	PollEvery time.Duration
}

const defaultUpdateReadyTimeout = 3 * time.Minute
const defaultUpdatePollEvery = 2 * time.Second

// RunUpdate thực hiện khung "backup tự động → tải bản mới (pull) → migrate →
// khởi động lại theo thứ tự → healthcheck", TỰ ĐỘNG ROLLBACK (khôi phục
// backup vừa tạo + khởi động lại) nếu BẤT KỲ bước nào sau backup thất bại —
// đây là phần logic quan trọng nhất của lệnh này, xem TestRunUpdate_*Rollback*
// trong update_test.go.
//
// GIỚI HẠN: chưa có pipeline phát hành thật gắn image theo Channel (xem
// UpdateOptions.Channel) — "tải bản mới" hiện chỉ là `docker compose pull`
// cho các service ĐÃ có "image:" cố định trong compose.yaml (proxy/redis/
// objects ở trạng thái repo hiện tại — xem resolveUpdateServices). Các
// service dùng "build:" cục bộ (api/web/bridge/db) được báo RÕ RÀNG là
// "chưa có bản phát hành để cập nhật qua genh update — cần build lại từ
// nguồn", không âm thầm bỏ qua.
func RunUpdate(ctx context.Context, env *Env, opts UpdateOptions, deps UpdateDeps, out io.Writer) error {
	runner := deps.Runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	client := deps.Client
	if client == nil {
		client = insecureLocalClient(5 * time.Second)
	}
	timeout := deps.Timeout
	if timeout <= 0 {
		timeout = defaultUpdateReadyTimeout
	}
	pollEvery := deps.PollEvery
	if pollEvery <= 0 {
		pollEvery = defaultUpdatePollEvery
	}

	channel := opts.Channel
	if channel == "" {
		channel = "stable"
	}
	if channel != "stable" && channel != "beta" {
		return &OpError{
			Code: ErrCodeUpdatePullFailed,
			What: "Giá trị --channel không hợp lệ",
			Why:  fmt.Sprintf("%q không phải \"stable\" hoặc \"beta\"", channel),
			Next: "Dùng --channel stable hoặc --channel beta.",
		}
	}

	composePath, err := env.LocatePath()
	if err != nil {
		return err
	}
	bundle, err := env.LoadSecrets()
	if err != nil {
		return err
	}
	envOverlay := EnvOverlay(bundle)
	dir := composeDir(composePath)

	_, _ = fmt.Fprintf(out, "Cập nhật Gen-Harness (kênh %s)\n", channel)

	// 1. Backup tự động TRƯỚC khi đụng gì — không có backup, không có gì để
	// rollback về.
	_, _ = fmt.Fprintln(out, "1/4 Backup tự động…")
	key, err := runBackupInContainer(ctx, runner, composePath, envOverlay, dir)
	if err != nil {
		return &OpError{
			Code: ErrCodeUpdateBackupFailed,
			What: "Backup tự động trước khi cập nhật thất bại — DỪNG LẠI, chưa đụng gì",
			Why:  err.Error(),
			Next: "Kiểm `genh status` (db phải healthy) rồi thử lại `genh update`.",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "     backup: "+key)

	// 2. Tải bản mới.
	_, _ = fmt.Fprintln(out, "2/4 Tải bản mới…")
	cf, err := compose.Load(composePath)
	if err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, out, &OpError{
			Code: ErrCodeUpdatePullFailed,
			What: "Không đọc được compose.yaml để biết service nào có bản phát hành",
			Why:  err.Error(),
			Next: "Kiểm compose.yaml có đúng cú pháp YAML.",
			Err:  err,
		})
	}
	pullable, skipped := resolveUpdateServices(cf)
	if len(skipped) > 0 {
		_, _ = fmt.Fprintf(out, "     %s: chưa có bản phát hành để cập nhật qua genh update — cần build lại từ nguồn.\n", strings.Join(skipped, ", "))
	}
	if len(pullable) > 0 {
		pullArgs := compose.BaseArgs(composePath, append([]string{"pull"}, pullable...)...)
		if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: pullArgs, Env: envOverlay, Dir: dir}); err != nil {
			return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, out, &OpError{
				Code: ErrCodeUpdatePullFailed,
				What: "`docker compose pull` thất bại",
				Why:  err.Error(),
				Next: "Kiểm kết nối mạng rồi thử lại `genh update`.",
				Err:  err,
			})
		}
		_, _ = fmt.Fprintln(out, "     đã pull: "+strings.Join(pullable, ", "))
	} else {
		_, _ = fmt.Fprintln(out, "     không có service nào có bản phát hành để pull.")
	}

	// 3. Migrate.
	_, _ = fmt.Fprintln(out, "3/4 Tạo cấu trúc dữ liệu (migrate)…")
	migrateArgs := compose.BaseArgs(composePath, "run", "--rm", "-T", "--no-deps", "migrate")
	if err := runner.Stream(ctx, dockercli.Cmd{Name: "docker", Args: migrateArgs, Env: envOverlay, Dir: dir}, func(string) {}); err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, out, &OpError{
			Code: ErrCodeUpdateMigrateFailed,
			What: "`alembic upgrade heads` thất bại trong container migrate",
			Why:  err.Error(),
			Next: "Xem `docker compose logs migrate` sau khi rollback xong.",
			Err:  err,
		})
	}

	// 4. Khởi động lại theo thứ tự (Compose tự áp depends_on).
	_, _ = fmt.Fprintln(out, "4/4 Khởi động lại dịch vụ…")
	upArgs := compose.BaseArgs(composePath, "up", "-d")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: upArgs, Env: envOverlay, Dir: dir}); err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, out, &OpError{
			Code: ErrCodeUpdateRestartFailed,
			What: "`docker compose up -d` sau khi cập nhật thất bại",
			Why:  err.Error(),
			Next: "Xem `docker compose logs` sau khi rollback xong.",
			Err:  err,
		})
	}

	readyURL := localURL(env.Port, readyPath)
	if err := waitReady(ctx, client, readyURL, timeout, pollEvery); err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, out, &OpError{
			Code: ErrCodeUpdateNotReady,
			What: readyPath + " không trả 200 sau khi cập nhật",
			Why:  err.Error(),
			Next: "Xem `docker compose logs` sau khi rollback xong.",
			Err:  err,
		})
	}

	_, _ = fmt.Fprintln(out, "Cập nhật xong, dịch vụ đã sẵn sàng.")
	return nil
}

// resolveUpdateServices đối chiếu updateServiceOrder với compose.yaml đã
// đọc — cùng logic resolveImages trong internal/install/steps_pull.go
// (service có "image:" cố định mới pull được, "build:" cục bộ thì không),
// viết lại ở đây (khác package, không tiện dùng chung) NHƯNG PHẢI nhất quán
// hành vi: báo rõ service nào chưa có bản phát hành, không âm thầm bỏ qua.
func resolveUpdateServices(cf compose.File) (pullable, skipped []string) {
	for _, name := range updateServiceOrder {
		svc, ok := cf.Services[name]
		if !ok || svc.Image == "" {
			skipped = append(skipped, name)
			continue
		}
		pullable = append(pullable, name)
	}
	return pullable, skipped
}

// runBackupInContainer và restoreInContainer (dùng ngay dưới đây trong
// rollbackAndWrap) nằm ở backupcore.go — dùng chung với `genh backup`/`genh
// restore` (backup.go), viết một lần duy nhất vì cả hai lệnh và rollback tự
// động của update đều cần đúng logic gọi container giống hệt nhau.

// rollbackAndWrap là TRÁI TIM của `genh update`: khi bất kỳ bước nào sau
// backup thất bại, khôi phục NGAY backup vừa tạo rồi khởi động lại dịch vụ,
// và bọc lỗi gốc thành một OpError nói rõ rollback đã chạy (thành công hay
// không) — không bao giờ để Owner ở trạng thái "không rõ máy đang thế nào".
func rollbackAndWrap(ctx context.Context, runner dockercli.Runner, composePath string, envOverlay []string, dir, key string, out io.Writer, original *OpError) error {
	_, _ = fmt.Fprintf(out, "LỖI (%s) — đang tự động rollback về backup %s…\n", original.Code, key)

	restoreErr := restoreInContainer(ctx, runner, composePath, envOverlay, dir, key)
	var restartErr error
	upArgs := compose.BaseArgs(composePath, "up", "-d")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: upArgs, Env: envOverlay, Dir: dir}); err != nil {
		restartErr = err
	}

	rolledBackOK := restoreErr == nil && restartErr == nil

	var next strings.Builder
	if rolledBackOK {
		_, _ = fmt.Fprintln(out, "Rollback xong: đã khôi phục "+key+" và khởi động lại dịch vụ.")
		next.WriteString("Rollback đã hoàn tất tự động (khôi phục " + key + " + khởi động lại). ")
		next.WriteString(original.Next)
	} else {
		_, _ = fmt.Fprintln(out, "ROLLBACK THẤT BẠI — cần can thiệp tay ngay.")
		next.WriteString("ROLLBACK TỰ ĐỘNG THẤT BẠI, cần can thiệp tay ngay: ")
		if restoreErr != nil {
			next.WriteString(fmt.Sprintf("khôi phục %s lỗi (%v); ", key, restoreErr))
		}
		if restartErr != nil {
			next.WriteString(fmt.Sprintf("`docker compose up -d` lỗi (%v); ", restartErr))
		}
		next.WriteString("chạy tay `docker compose exec -T api python -m gh.backup restore --key " + key + "` rồi `docker compose up -d`.")
	}

	what := original.What
	if rolledBackOK {
		what += " — đã tự động rollback"
	} else {
		what += " — ROLLBACK TỰ ĐỘNG CŨNG THẤT BẠI"
	}

	return &OpError{
		Code: ErrCodeUpdateRolledBack,
		What: what,
		Why:  original.Why,
		Next: next.String(),
		Err:  original.Err,
	}
}

// waitReady gọi GET url lặp lại cho tới khi nhận 200, hoặc hết timeout —
// cùng logic waitServiceReady trong internal/install/steps_services.go,
// viết lại ở đây (không cần báo Percent/SubLines như Bước 7, `genh update`
// chỉ cần biết có lên lại hay không).
func waitReady(ctx context.Context, client *http.Client, url string, timeout, pollEvery time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err == nil {
			if resp, err := client.Do(req); err == nil {
				_ = resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					return nil
				}
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("hết thời gian chờ %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollEvery):
		}
	}
}
