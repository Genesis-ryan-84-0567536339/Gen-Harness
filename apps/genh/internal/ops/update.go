package ops

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/hostlink"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
)

// updateServiceOrder là các service compose có thể "cập nhật" qua
// `docker compose pull` — cùng danh sách 6 service của Bước 3 (internal/
// install/steps_pull.go pullServiceOrder, đã bỏ "objects" — MinIO không còn
// trong compose.yaml), viết lại ở đây vì đó là biến không xuất của package
// khác.
var updateServiceOrder = []string{"db", "redis", "proxy", "api", "web", "bridge", "browser"}

// updateWriterServices là các nguồn GHI vào CSDL ngoài api — tạm dừng trước
// khi sao lưu nếu bản mới có thay đổi CSDL (F-10), để bản sao lưu không lỡ
// mất các ghi chép đến SAU lúc chụp mà migrate sắp đụng.
//
// api CỐ Ý không dừng (Console phải còn chạy để Owner thấy tiến trình, proxy
// chưa có trang bảo trì): khoảng hở CHẤP NHẬN là các ghi của api (thao tác
// Owner, webhook) trong vài giây giữa lúc sao lưu xong và lúc migrate — chỉ mất
// nếu migrate/khởi động lại lỗi và phải khôi phục bản sao lưu đó.
var updateWriterServices = []string{"worker", "bridge"}

// rollbackStopServices là các service dừng lại trước khi khôi phục CSDL khi
// rollback (F-33) — không để api/worker/bridge/web ảnh MỚI ghi tiếp vào CSDL
// đang được khôi phục.
var rollbackStopServices = []string{"api", "worker", "bridge", "web"}

// updateNextComposeName là compose tạm (bản đích) dùng để TẢI ảnh mới trước
// khi đụng compose.yaml thật — nằm CÙNG thư mục với compose.yaml để các đường
// tương đối ("..", "./proxy") giữ đúng nghĩa.
const updateNextComposeName = "compose.update-next.yaml"

// UpdateOptions là các cờ đã phân tích của `genh update`.
type UpdateOptions struct {
	// Channel là "stable" hoặc "beta" — THUẦN THÔNG TIN ở bản này: chưa có
	// pipeline phát hành thật gắn tag theo kênh (xem docs/handoff/
	// 05-installer.md mục "Phát hành", việc của một phiên khác đang làm
	// song song). genh update hiện chỉ `docker compose pull` bất kể Channel
	// là gì — Channel được validate và ghi vào log/Detail để không im lặng
	// bỏ qua lựa chọn của Owner, nhưng không đổi hành vi tải.
	Channel string
	// Version là phiên bản genh đang chạy (main.version) — ghi vào
	// run/update-blocked.json khi rollback đã đụng CSDL, để lịch đêm không thử
	// lại đúng bản này (xem cmd/genh decideServiceUpdate).
	Version string
}

// UpdateDeps cho phép tiêm dockercli.Runner/http.Client giả + thời gian chờ
// ngắn hơn khi test.
type UpdateDeps struct {
	Runner    dockercli.Runner
	Client    *http.Client
	Timeout   time.Duration
	PollEvery time.Duration
	// ReTrustCA chạy sau khi cập nhật THÀNH CÔNG để tin cậy lại CA nội bộ của
	// Caddy (Owner hết thấy "Not secure") — nil dùng retrustCASilently. Test
	// tiêm hàm giả để không đụng kho chứng chỉ thật của máy chạy test.
	ReTrustCA func(ctx context.Context, env *Env)
	// DiskFree đo chỗ trống (byte) tại một đường dẫn — nil dùng
	// machine.ProbeDiskFree. Test tiêm hàm giả, không đo đĩa thật.
	DiskFree func(path string) (uint64, error)
	// PullAttempts là số lần thử `docker compose pull` (mặc định 3).
	PullAttempts int
	// PullTimeout là thời gian tối đa MỖI lần pull (mặc định 20 phút).
	PullTimeout time.Duration
	// PullBackoff là thời gian chờ giữa các lần thử (phần tử i dùng trước lần
	// thử i+2, kẹp phần tử cuối) — nil dùng 20 giây, 60 giây.
	PullBackoff []time.Duration
}

// retrustCASilently: best-effort, im lặng — lỗi gì cũng bỏ qua, không bao giờ
// hỏi Owner (update có thể đang chạy nền qua watcher).
func retrustCASilently(ctx context.Context, env *Env) {
	_ = RunTrustCA(ctx, env, false, TrustCADeps{}, io.Discard)
}

const defaultUpdateReadyTimeout = 3 * time.Minute
const defaultUpdatePollEvery = 2 * time.Second
const defaultPullAttempts = 3
const defaultPullTimeout = 20 * time.Minute

var defaultPullBackoff = []time.Duration{20 * time.Second, 60 * time.Second}

// UpdateNeeded báo dịch vụ đã khớp bản genh đang chạy chưa: compose.yaml GENH
// QUẢN LÝ + Caddyfile trùng bản nhúng (compose.InSyncWithEmbedded) VÀ không còn
// dấu cập nhật dở (run/update-inprogress.json — lần trước đã ghi compose.yaml
// mới nhưng chưa tới `up -d` thành công). compose.yaml ngoài (GENH_COMPOSE_FILE,
// checkout) → false: luôn chạy đủ. Lỗi (không tìm thấy compose…) → (false,
// err): bên gọi coi như CẦN cập nhật để RunUpdate tự báo lỗi đúng khuôn.
func UpdateNeeded(env *Env) (inSync bool, err error) {
	path, err := env.LocatePath()
	if err != nil {
		return false, err
	}
	if env.InstallDir != "" && hostlink.UpdateInProgressExists(env.InstallDir) {
		return false, nil
	}
	return compose.InSyncWithEmbedded(env.InstallDir, path)
}

// RunUpdate cập nhật dịch vụ theo thứ tự AN TOÀN (F-10, F-11, F-33):
//
//  1. Kiểm chỗ trống trên đĩa (gốc cài đặt + thư mục gốc Docker); thiếu thì
//     dọn ảnh Gen-Harness cũ rồi đo lại; vẫn thiếu → DỪNG (GH-E948), chưa đụng gì.
//  2. Tải bản mới TRƯỚC khi sao lưu — bằng compose.update-next.yaml (bản nhúng)
//     nếu compose.yaml sẽ đổi, KHÔNG đồng bộ compose.yaml lúc này. Thử tối đa
//     PullAttempts lần, mỗi lần có giới hạn thời gian; hết lần → GH-E941, CHƯA
//     đụng gì (không sao lưu, không khôi phục, không up).
//  3. Dò `alembic current` bằng ảnh mới: có thay đổi CSDL (migrationPending) →
//     tạm dừng worker và bridge (nguồn ghi) trước khi sao lưu.
//  4. Sao lưu (pre-update). Lỗi → bật lại worker/bridge nếu đã dừng, DỪNG (GH-E940).
//  5. Ghi run/update-inprogress.json rồi đồng bộ compose.yaml với bản nhúng
//     (SAU sao lưu, mục #3 v0.1.2). Dấu này chỉ xoá khi đã sẵn sàng (bước 9) hoặc
//     đã trả compose.yaml về bản cũ — genh chết giữa chừng thì lần sau không
//     coi "đã khớp" (UpdateNeeded).
//  6. Di trú /tmp/gh-objects của bản cài cũ (nếu có).
//  7. Migrate — từ đây bản này coi như HỎNG nếu có lỗi (versionBroken); CSDL
//     chỉ coi là ĐÃ bị đụng (dbTouched) khi bước 3 thấy có migration chờ.
//  8. up -d --remove-orphans.  9. Chờ /api/v1/ready.  10. Chép dữ liệu di trú.
//  11. Thành công: xoá run/update-blocked.json, dọn ảnh cũ (giữ bản hiện tại +
//     bản liền trước), tin cậy lại CA.
//
// Lỗi ở bước 5–6 (CSDL chưa bị đụng): trả compose.yaml về bản cũ + up -d, KHÔNG
// khôi phục CSDL. Lỗi ở bước 7–9: không có migration chờ → cũng chỉ trả
// compose.yaml + up -d (KHÔNG khôi phục — worker/bridge/api vẫn ghi suốt lúc đó,
// khôi phục sẽ làm mất các ghi đó); có migration chờ → khôi phục bản sao lưu
// bằng ảnh CŨ. Cả hai đều ghi run/update-blocked.json — xem rollbackAndWrap.
//
// GIỚI HẠN: chưa có pipeline phát hành thật gắn image theo Channel (xem
// UpdateOptions.Channel). Các service dùng "build:" cục bộ được báo RÕ RÀNG là
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

	// LocatePath (KHÔNG LocatePathSync): mọi bước trước sao lưu dùng ĐÚNG
	// compose.yaml đang có trên đĩa (bản container hiện tại được dựng lên) —
	// đồng bộ chỉ chạy ở bước 5, SAU sao lưu (mục #3 v0.1.2).
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

	oldCompose, err := os.ReadFile(composePath)
	if err != nil {
		return &OpError{
			Code: ErrCodeComposeNotFound,
			What: "Không đọc được compose.yaml hiện tại — DỪNG LẠI, chưa đụng gì",
			Why:  err.Error(),
			Next: "Kiểm quyền đọc " + composePath + " rồi thử lại `genh update`.",
			Err:  err,
		}
	}
	managed := env.InstallDir != "" && filepath.Clean(composePath) == compose.ManagedComposePath(env.InstallDir)
	target := oldCompose
	if managed {
		target = compose.EmbeddedCompose()
	}
	composeChanges := !bytes.Equal(oldCompose, target)
	var bak []byte
	if b, err := os.ReadFile(composePath + ".bak"); err == nil {
		bak = b
	}

	_, _ = fmt.Fprintf(out, "Cập nhật Gen-Harness (kênh %s)\n", channel)

	// 1. Kiểm chỗ trống trên đĩa (F-11).
	_, _ = fmt.Fprintln(out, "1/7 Kiểm chỗ trống trên đĩa…")
	if opErr := ensureDiskSpace(ctx, runner, env, deps, [][]byte{oldCompose, bak, target}, out); opErr != nil {
		return opErr
	}

	// 2. Tải bản mới TRƯỚC khi sao lưu (F-10).
	_, _ = fmt.Fprintln(out, "2/7 Tải bản mới…")
	targetCf, err := compose.Parse(target)
	if err != nil {
		return &OpError{
			Code: ErrCodeUpdatePullFailed,
			What: "Không đọc được compose.yaml của bản mới — CHƯA đụng gì (CSDL, compose.yaml, dịch vụ giữ nguyên)",
			Why:  err.Error(),
			Next: "Kiểm compose.yaml có đúng cú pháp YAML rồi thử lại `genh update`.",
			Err:  err,
		}
	}
	pullPath := composePath
	if composeChanges && managed {
		pullPath = filepath.Join(filepath.Dir(composePath), updateNextComposeName)
		if err := os.WriteFile(pullPath, target, 0o644); err != nil {
			return &OpError{
				Code: ErrCodeUpdatePullFailed,
				What: "Không ghi được compose tạm để tải bản mới — CHƯA đụng gì (CSDL, compose.yaml, dịch vụ giữ nguyên)",
				Why:  err.Error(),
				Next: "Kiểm quyền ghi vào " + dir + " rồi thử lại `genh update`.",
				Err:  err,
			}
		}
		defer func() { _ = os.Remove(pullPath) }()
	}
	pullable, skipped := resolveUpdateServices(targetCf)
	if len(skipped) > 0 {
		_, _ = fmt.Fprintf(out, "     %s: chưa có bản phát hành để cập nhật qua genh update — cần build lại từ nguồn.\n", strings.Join(skipped, ", "))
	}
	if len(pullable) > 0 {
		pullArgs := compose.BaseArgs(pullPath, append([]string{"pull"}, pullable...)...)
		attempts, err := pullWithRetry(ctx, runner, dockercli.Cmd{Name: "docker", Args: pullArgs, Env: envOverlay, Dir: dir}, deps, out)
		if err != nil {
			return &OpError{
				Code: ErrCodeUpdatePullFailed,
				What: fmt.Sprintf("Tải bản mới thất bại sau %d lần thử — CHƯA đụng gì (CSDL, compose.yaml, dịch vụ giữ nguyên)", attempts),
				Why:  err.Error(),
				Next: "Kiểm kết nối mạng; lịch đêm sẽ tự thử lại đêm sau, hoặc chạy `genh update`.",
				Err:  err,
			}
		}
		_, _ = fmt.Fprintln(out, "     đã tải: "+strings.Join(pullable, ", "))
	} else {
		_, _ = fmt.Fprintln(out, "     không có service nào có bản phát hành để tải.")
	}

	// 3. Bản mới có thay đổi CSDL? (F-10 bước 4) — có thì tạm dừng nguồn ghi.
	writersStopped := false
	oldWriters := servicesPresent(oldCompose, updateWriterServices)
	migrationPending := needsMigration(ctx, runner, pullPath, envOverlay, dir)
	if migrationPending {
		if len(oldWriters) > 0 {
			_, _ = fmt.Fprintln(out, "Bản mới có thay đổi CSDL — tạm dừng worker và bridge (nguồn ghi) trước khi sao lưu…")
			stopArgs := compose.BaseArgs(composePath, append([]string{"stop"}, oldWriters...)...)
			if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: stopArgs, Env: envOverlay, Dir: dir}); err != nil {
				_, _ = fmt.Fprintf(out, "     (không dừng được %s — %v; vẫn sao lưu tiếp)\n", strings.Join(oldWriters, ", "), err)
			}
			writersStopped = true
		}
	}
	// Compose tạm chỉ cần tới đây (pull + dò migrate) — xoá sớm, defer ở trên
	// là lưới an toàn cho các đường trả lỗi sớm.
	if pullPath != composePath {
		_ = os.Remove(pullPath)
	}

	// 4. Sao lưu tự động.
	_, _ = fmt.Fprintln(out, "3/7 Sao lưu tự động…")
	key, err := runBackupInContainer(ctx, runner, composePath, envOverlay, dir, BackupTriggerPreUpdate)
	if err != nil {
		if writersStopped {
			startArgs := compose.BaseArgs(composePath, append([]string{"start"}, oldWriters...)...)
			if _, serr := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: startArgs, Env: envOverlay, Dir: dir}); serr != nil {
				_, _ = fmt.Fprintf(out, "     (không bật lại được %s — %v; chạy tay `docker compose start %s`)\n", strings.Join(oldWriters, ", "), serr, strings.Join(oldWriters, " "))
			}
		}
		return &OpError{
			Code: ErrCodeUpdateBackupFailed,
			What: "Backup tự động trước khi cập nhật thất bại — DỪNG LẠI, chưa đụng gì",
			Why:  err.Error(),
			Next: "Kiểm `genh status` (db phải healthy) rồi thử lại `genh update`.",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "     backup: "+key)

	plan := rollbackPlan{
		runner:      runner,
		composePath: composePath,
		envOverlay:  envOverlay,
		dir:         dir,
		key:         key,
		installDir:  env.InstallDir,
		version:     opts.Version,
		target:      target,
	}
	if composeChanges {
		plan.oldCompose = oldCompose
	}

	// 5. Dấu "đang cập nhật dở" TRƯỚC khi đổi compose.yaml, rồi đồng bộ
	// compose.yaml SAU sao lưu (giữ bản cũ ở compose.yaml.bak).
	_, _ = fmt.Fprintln(out, "4/7 Đồng bộ compose.yaml + kiểm dữ liệu /tmp/gh-objects (bản cài cũ)…")
	if env.InstallDir != "" {
		if err := hostlink.MarkUpdateInProgress(env.InstallDir, hostlink.UpdateInProgress{Version: opts.Version, BackupKey: key}); err != nil {
			_, _ = fmt.Fprintf(out, "     (không ghi được %s — %v)\n", hostlink.UpdateInProgressFile, err)
		}
	}
	syncedPath, err := env.LocatePathSync()
	if err != nil {
		return rollbackAndWrap(ctx, plan, out, &OpError{
			Code: ErrCodeUpdateComposeSyncFailed,
			What: "Đồng bộ compose.yaml với bản genh mới thất bại",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi vào " + dir + " rồi thử lại `genh update` — bản sao lưu " + key + " vẫn còn.",
			Err:  err,
		})
	}
	if syncedPath != composePath {
		return rollbackAndWrap(ctx, plan, out, &OpError{
			Code: ErrCodeUpdateComposeSyncFailed,
			What: "Đồng bộ compose.yaml tìm ra một đường dẫn khác với lúc sao lưu — DỪNG LẠI để không dùng nhầm compose.yaml",
			Why:  fmt.Sprintf("sao lưu dùng %s, đồng bộ trả về %s", composePath, syncedPath),
			Next: "Đặt biến GENH_COMPOSE_FILE trỏ đúng một tệp compose.yaml rồi thử lại `genh update`.",
		})
	}

	// 6. Di trú /tmp/gh-objects (v0.1.0) sang volume gh_objects NẾU còn
	// container cũ kiểu đó — PHẢI chạy TRƯỚC up (bước 8 tạo lại container).
	objectsHostDir, err := captureLegacyObjectsIfAny(ctx, runner, composePath, envOverlay, dir, env.InstallDir, out)
	if err != nil {
		return rollbackAndWrap(ctx, plan, out, &OpError{
			Code: ErrCodeUpdateObjectsMigrateFailed,
			What: "Di trú dữ liệu /tmp/gh-objects (bản cài cũ) thất bại — chưa migrate/tạo lại container",
			Why:  err.Error(),
			Next: "Xem lỗi ở trên rồi thử lại `genh update` — bản sao lưu " + key + " vẫn còn.",
			Err:  err,
		})
	}
	if objectsHostDir == "" {
		_, _ = fmt.Fprintln(out, "     không có gì để di trú.")
	}
	plan.objectsHostDir = objectsHostDir

	// 7. Migrate — từ lệnh này lỗi nghĩa là bản này hỏng (chặn lịch đêm); CSDL
	// chỉ coi là đã bị đụng khi thật sự có migration chờ (bước 3) — không có
	// thì worker/bridge chưa từng dừng, khôi phục bản sao lưu sẽ xoá mất mọi
	// ghi chép từ lúc sao lưu tới giờ.
	_, _ = fmt.Fprintln(out, "5/7 Tạo cấu trúc dữ liệu (migrate)…")
	plan.versionBroken = true
	plan.dbTouched = migrationPending
	migrateArgs := compose.BaseArgs(composePath, "run", "--rm", "-T", "--no-deps", "migrate")
	if err := runner.Stream(ctx, dockercli.Cmd{Name: "docker", Args: migrateArgs, Env: envOverlay, Dir: dir}, func(string) {}); err != nil {
		return rollbackAndWrap(ctx, plan, out, &OpError{
			Code: ErrCodeUpdateMigrateFailed,
			What: "`alembic upgrade heads` thất bại trong container migrate",
			Why:  err.Error(),
			Next: "Xem `docker compose logs migrate` sau khi rollback xong.",
			Err:  err,
		})
	}

	// 8. Khởi động lại theo thứ tự (Compose tự áp depends_on). --remove-orphans
	// dọn container của service KHÔNG CÒN trong compose.yaml (mục #5 v0.1.2).
	_, _ = fmt.Fprintln(out, "6/7 Khởi động lại dịch vụ…")
	upArgs := compose.BaseArgs(composePath, "up", "-d", "--remove-orphans")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: upArgs, Env: envOverlay, Dir: dir}); err != nil {
		return rollbackAndWrap(ctx, plan, out, &OpError{
			Code: ErrCodeUpdateRestartFailed,
			What: "`docker compose up -d` sau khi cập nhật thất bại",
			Why:  err.Error(),
			Next: "Xem `docker compose logs` sau khi rollback xong.",
			Err:  err,
		})
	}

	// 9. Chờ sẵn sàng.
	_, _ = fmt.Fprintln(out, "7/7 Chờ dịch vụ sẵn sàng…")
	readyURL := localURL(env.Port, readyPath)
	if err := waitReady(ctx, client, readyURL, timeout, pollEvery); err != nil {
		return rollbackAndWrap(ctx, plan, out, &OpError{
			Code: ErrCodeUpdateNotReady,
			What: readyPath + " không trả 200 sau khi cập nhật",
			Why:  err.Error(),
			Next: "Xem `docker compose logs` sau khi rollback xong.",
			Err:  err,
		})
	}

	// Dịch vụ bản mới đã lên và sẵn sàng — lần cập nhật này không còn "dở".
	if env.InstallDir != "" {
		if err := hostlink.ClearUpdateInProgress(env.InstallDir); err != nil {
			_, _ = fmt.Fprintf(out, "     (không xoá được %s — %v)\n", hostlink.UpdateInProgressFile, err)
		}
	}

	// 10. Container api MỚI (đã mount volume gh_objects) đã lên VÀ healthy —
	// giờ mới chép dữ liệu đã di trú vào volume. Giữ nguyên objectsHostDir
	// trên đĩa dù bước này thành công hay không.
	if objectsHostDir != "" {
		_, _ = fmt.Fprintln(out, "Chép dữ liệu đã di trú vào volume gh_objects…")
		if err := seedObjectsVolume(ctx, runner, composePath, envOverlay, dir, objectsHostDir); err != nil {
			return &OpError{
				Code: ErrCodeUpdateObjectsMigrateFailed,
				What: "Cập nhật xong, dịch vụ đã sẵn sàng, NHƯNG chép dữ liệu đã di trú vào volume gh_objects thất bại",
				Why:  err.Error(),
				Next: "Dữ liệu THÔ vẫn còn nguyên tại " + objectsHostDir + " — tự chạy `docker compose cp " + objectsHostDir + "/. api:" + volumeObjectsDir + "` rồi `docker compose exec -u root -T api chown -R gh:gh " + volumeObjectsDir + "`.",
				Err:  err,
			}
		}
		_, _ = fmt.Fprintln(out, "     xong: "+objectsHostDir+" -> api:"+volumeObjectsDir)
	}

	// 11. Thành công: bỏ chặn lịch đêm, dọn ảnh cũ (giữ bản hiện tại + bản
	// liền trước), tin cậy lại CA. Lỗi ở đây không làm hỏng kết quả.
	if env.InstallDir != "" {
		if err := hostlink.ClearUpdateBlocked(env.InstallDir); err != nil {
			_, _ = fmt.Fprintf(out, "     (không xoá được %s — %v)\n", hostlink.UpdateBlockedFile, err)
		}
	}
	previous := bak
	if composeChanges {
		previous = oldCompose
	}
	if n, err := pruneOldImages(ctx, runner, [][]byte{target, previous}, out); err != nil {
		_, _ = fmt.Fprintf(out, "     (không dọn được ảnh cũ — %v)\n", err)
	} else if n > 0 {
		_, _ = fmt.Fprintf(out, "Đã dọn %d ảnh cũ (giữ bản hiện tại và bản liền trước).\n", n)
	}

	reTrust := deps.ReTrustCA
	if reTrust == nil {
		reTrust = retrustCASilently
	}
	reTrust(ctx, env)

	_, _ = fmt.Fprintln(out, "Cập nhật xong, dịch vụ đã sẵn sàng.")
	return nil
}

// ensureDiskSpace là bước 1 của RunUpdate (F-11): đo chỗ trống; thiếu (<
// machine.MinDiskBytes) thì dọn ảnh Gen-Harness cũ (giữ mọi ảnh của keep) rồi
// đo lại; vẫn thiếu → OpError GH-E948 (chưa đụng gì). Ghi run/disk-status.json
// mỗi lần đo được. Không đo được → chỉ cảnh báo, trả nil (không chặn).
func ensureDiskSpace(ctx context.Context, runner dockercli.Runner, env *Env, deps UpdateDeps, keep [][]byte, out io.Writer) *OpError {
	free, diskPath, err := checkDiskFree(ctx, runner, env, deps)
	if err != nil {
		_, _ = fmt.Fprintf(out, "     (không đo được chỗ trống trên đĩa — %v; vẫn tiếp tục)\n", err)
		return nil
	}
	pruned := 0
	if free < machine.MinDiskBytes {
		_, _ = fmt.Fprintf(out, "     còn %s trống tại %s (< %s) — dọn ảnh cũ…\n", formatGB(free), diskPath, formatGB(machine.MinDiskBytes))
		n, perr := pruneOldImages(ctx, runner, keep, out)
		pruned = n
		if perr != nil {
			_, _ = fmt.Fprintf(out, "     (không dọn được ảnh cũ — %v)\n", perr)
		} else if n > 0 {
			_, _ = fmt.Fprintf(out, "     đã dọn %d ảnh cũ.\n", n)
		}
		if f2, p2, err2 := checkDiskFree(ctx, runner, env, deps); err2 == nil {
			free, diskPath = f2, p2
		}
	}
	state := "ok"
	if free < machine.MinDiskBytes {
		state = "low"
	}
	if env.InstallDir != "" {
		_ = hostlink.WriteDiskStatus(env.InstallDir, hostlink.DiskStatus{
			State: state, FreeBytes: free, MinBytes: machine.MinDiskBytes, Path: diskPath, PrunedImages: pruned,
		})
	}
	if state == "low" {
		return &OpError{
			Code: ErrCodeUpdateDiskLow,
			What: "Ổ đĩa không đủ chỗ để tải bản mới — DỪNG LẠI, chưa đụng gì",
			Why:  fmt.Sprintf("còn %s trống tại %s, cần tối thiểu %d GB", formatGB(free), diskPath, machine.MinDiskBytes>>30),
			Next: "Giải phóng ổ đĩa (xem `docker system df`), rồi chạy lại `genh update` — lịch đêm cũng sẽ tự thử lại.",
		}
	}
	_, _ = fmt.Fprintf(out, "     còn %s trống — đủ.\n", formatGB(free))
	return nil
}

// pullWithRetry chạy `docker compose pull` tối đa deps.PullAttempts lần, mỗi
// lần giới hạn deps.PullTimeout, chờ deps.PullBackoff giữa các lần (tôn trọng
// ctx). Trả số lần đã thử và lỗi của lần cuối (nil nếu có lần thành công).
func pullWithRetry(ctx context.Context, runner dockercli.Runner, cmd dockercli.Cmd, deps UpdateDeps, out io.Writer) (int, error) {
	attempts := deps.PullAttempts
	if attempts <= 0 {
		attempts = defaultPullAttempts
	}
	perTry := deps.PullTimeout
	if perTry <= 0 {
		perTry = defaultPullTimeout
	}
	backoff := deps.PullBackoff
	if backoff == nil {
		backoff = defaultPullBackoff
	}

	var lastErr error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			var wait time.Duration
			if len(backoff) > 0 {
				idx := i - 1
				if idx >= len(backoff) {
					idx = len(backoff) - 1
				}
				wait = backoff[idx]
			}
			_, _ = fmt.Fprintf(out, "     tải lỗi (lần %d/%d: %v) — thử lại sau %s…\n", i, attempts, lastErr, wait)
			if wait > 0 {
				select {
				case <-ctx.Done():
					return i, ctx.Err()
				case <-time.After(wait):
				}
			}
		}
		tryCtx, cancel := context.WithTimeout(ctx, perTry)
		_, err := runner.Output(tryCtx, cmd)
		timedOut := errors.Is(tryCtx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
		cancel()
		if err == nil {
			return i + 1, nil
		}
		if timedOut {
			err = fmt.Errorf("quá %s mà chưa tải xong: %w", perTry, err)
		}
		lastErr = err
		if ctx.Err() != nil {
			return i + 1, lastErr
		}
	}
	return attempts, lastErr
}

// needsMigration dò `alembic current` bằng ảnh MỚI (compose pullPath): còn
// revision nào không phải "(head)" (hoặc không có revision nào) → bản mới có
// thay đổi CSDL. Lệnh lỗi → true (an toàn: coi như có).
func needsMigration(ctx context.Context, runner dockercli.Runner, pullPath string, envOverlay []string, dir string) bool {
	args := compose.BaseArgs(pullPath, "run", "--rm", "--no-deps", "-T", "migrate", "alembic", "current")
	output, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: envOverlay, Dir: dir})
	if err != nil {
		return true
	}
	return pendingMigrationFromCurrent(string(output))
}

// pendingMigrationFromCurrent phân tích stdout của `alembic current`: bỏ dòng
// rỗng và dòng log (INFO/WARN, "[alembic"); không còn dòng nào HOẶC có dòng
// không chứa "(head)" → còn migration chưa chạy.
func pendingMigrationFromCurrent(output string) bool {
	kept := 0
	for _, line := range strings.Split(output, "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "INFO") || strings.HasPrefix(t, "WARN") || strings.Contains(t, "[alembic") {
			continue
		}
		kept++
		if !strings.Contains(t, "(head)") {
			return true
		}
	}
	return kept == 0
}

// servicesPresent lọc want theo các service CÓ trong compose (lỗi cú pháp →
// rỗng), giữ thứ tự want.
func servicesPresent(composeData []byte, want []string) []string {
	cf, err := compose.Parse(composeData)
	if err != nil {
		return nil
	}
	var got []string
	for _, name := range want {
		if _, ok := cf.Services[name]; ok {
			got = append(got, name)
		}
	}
	return got
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
// restore` (backup.go).

// rollbackPlan là mọi thứ rollbackAndWrap cần để đưa máy về đúng trạng thái
// trước khi cập nhật.
type rollbackPlan struct {
	runner         dockercli.Runner
	composePath    string
	envOverlay     []string
	dir            string
	key            string // bản sao lưu pre-update vừa tạo
	objectsHostDir string // dữ liệu /tmp/gh-objects đã di trú ("" nếu không có)
	// oldCompose: nội dung compose.yaml lúc bắt đầu (đã đọc vào bộ nhớ) — nil
	// nghĩa là lần này compose.yaml KHÔNG đổi, không có gì để trả về.
	oldCompose []byte
	// dbTouched: migrate đã bắt đầu chạy VÀ có migration chờ → CSDL có thể đã
	// đổi, PHẢI khôi phục.
	dbTouched bool
	// versionBroken: lỗi từ bước migrate trở đi (migrate/up/ready) → bản này
	// hỏng, ghi update-blocked.json kể cả khi không cần khôi phục CSDL.
	versionBroken bool
	installDir    string
	version       string // genh main.version — ghi vào update-blocked.json
	target        []byte // compose bản đích (giữ ảnh của nó khi dọn)
}

// rollbackAndWrap là TRÁI TIM của `genh update`: khi một bước SAU sao lưu thất
// bại, đưa máy về bản cũ và bọc lỗi gốc nói rõ đã làm gì — không bao giờ để
// Owner ở trạng thái "không rõ máy đang thế nào".
//
//	a) oldCompose != nil → ghi lại compose.yaml CŨ từ bộ nhớ (tmp + rename).
//	   KHÔNG đọc compose.yaml.bak: .bak có thể cũ từ một lần cập nhật trước,
//	   khôi phục nó khi lần này compose không đổi là SAI.
//	b) dbTouched=false: CSDL chưa bị đụng → chỉ `up -d --remove-orphans` (bật
//	   lại worker/bridge nếu đã dừng), KHÔNG khôi phục. Lỗi đồng bộ compose / di
//	   trú /tmp/gh-objects: KHÔNG ghi update-blocked, giữ Code gốc. Lỗi từ
//	   migrate trở đi (versionBroken, không có migration chờ): bản này hỏng →
//	   ghi update-blocked.json, trả GH-E945. Đã trả compose.yaml về bản cũ +
//	   khởi động lại được → xoá update-inprogress.json.
//	c) dbTouched=true (F-33): chép lại dữ liệu di trú vào volume (nếu có, trước
//	   khi dừng api — xem seedObjectsVolume), dừng api/worker/bridge/web, dựng
//	   lại db bằng ảnh CŨ (nếu compose đổi — để bản sao lưu được khôi phục bởi
//	   đúng ảnh db sẽ chạy tiếp), khôi phục bản sao lưu bằng container TẠM dựng
//	   từ ảnh CŨ (`run --rm`, không exec vào api ảnh mới), `up -d
//	   --remove-orphans`, dọn ảnh (best-effort), ghi run/update-blocked.json
//	   (CẢ khi rollback thất bại, kèm rollback_failed) để lịch đêm không thử lại
//	   đúng bản này; trả GH-E945.
func rollbackAndWrap(ctx context.Context, p rollbackPlan, out io.Writer, original *OpError) error {
	runner := p.runner
	up := func() error {
		upArgs := compose.BaseArgs(p.composePath, "up", "-d", "--remove-orphans")
		_, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: upArgs, Env: p.envOverlay, Dir: p.dir})
		return err
	}

	if !p.dbTouched {
		_, _ = fmt.Fprintf(out, "LỖI (%s) — CSDL chưa bị đụng: tự rollback — trả compose.yaml về bản cũ và khởi động lại (không cần khôi phục dữ liệu)…\n", original.Code)
	} else {
		_, _ = fmt.Fprintf(out, "LỖI (%s) — đang tự động rollback về bản sao lưu %s…\n", original.Code, p.key)
	}

	var composeErr error
	if p.oldCompose != nil {
		if composeErr = writeFileAtomic(p.composePath, p.oldCompose); composeErr != nil {
			_, _ = fmt.Fprintf(out, "     (không trả được compose.yaml về bản cũ — %v; tiếp tục với compose.yaml hiện tại)\n", composeErr)
		}
	}

	if !p.dbTouched {
		upErr := up()
		ok := upErr == nil && composeErr == nil
		if ok && p.oldCompose != nil && p.installDir != "" {
			// compose.yaml đã về đúng bản cũ và dịch vụ chạy lại bằng nó — không
			// còn "dở". compose không đổi lần này (oldCompose nil) thì GIỮ dấu:
			// compose.yaml vẫn trùng bản nhúng, thiếu dấu thì lần gõ tay sau sẽ
			// tưởng "đã khớp" mà không thử lại.
			if err := hostlink.ClearUpdateInProgress(p.installDir); err != nil {
				_, _ = fmt.Fprintf(out, "     (không xoá được %s — %v)\n", hostlink.UpdateInProgressFile, err)
			}
		}
		what := original.What + " — CSDL chưa bị đụng, đã tự quay về bản cũ và khởi động lại"
		next := original.Next
		if !ok {
			what = original.What + " — CSDL chưa bị đụng, NHƯNG khởi động lại bằng bản cũ chưa trọn"
			var b strings.Builder
			if composeErr != nil {
				b.WriteString(fmt.Sprintf("trả compose.yaml về bản cũ lỗi (%v); ", composeErr))
			}
			if upErr != nil {
				b.WriteString(fmt.Sprintf("`docker compose up -d` lỗi (%v); ", upErr))
			}
			b.WriteString("chạy tay `docker compose up -d --remove-orphans`. ")
			b.WriteString(original.Next)
			next = b.String()
			_, _ = fmt.Fprintln(out, "Khởi động lại bằng bản cũ THẤT BẠI — cần can thiệp tay.")
		} else {
			_, _ = fmt.Fprintln(out, "Rollback xong: đã trả về bản cũ và khởi động lại dịch vụ (dữ liệu không đổi).")
		}
		if !p.versionBroken {
			return &OpError{Code: original.Code, What: what, Why: original.Why, Next: next, Err: original.Err}
		}
		// Lỗi từ migrate trở đi mà không có migration chờ: bản này hỏng —
		// chặn lịch đêm như nhánh c), nhưng KHÔNG khôi phục CSDL.
		p.writeBlocked(out, original, !ok)
		if ok {
			next = "Đã tự quay về bản cũ (CSDL không đổi, không cần khôi phục); lịch đêm sẽ không tự thử lại bản này. " + original.Next
		}
		return &OpError{Code: ErrCodeUpdateRolledBack, What: what, Why: original.Why, Next: next, Err: original.Err}
	}

	// c) Đã đụng CSDL.
	if p.objectsHostDir != "" {
		if err := seedObjectsVolume(ctx, runner, p.composePath, p.envOverlay, p.dir, p.objectsHostDir); err != nil {
			_, _ = fmt.Fprintf(out, "     (không chép lại được dữ liệu di trú vào volume trước khi khôi phục — %v; dữ liệu THÔ vẫn còn tại %s)\n", err, p.objectsHostDir)
		}
	}

	current := p.oldCompose
	if current == nil {
		if b, err := os.ReadFile(p.composePath); err == nil {
			current = b
		}
	}
	if stop := servicesPresent(current, rollbackStopServices); len(stop) > 0 {
		stopArgs := compose.BaseArgs(p.composePath, append([]string{"stop"}, stop...)...)
		if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: stopArgs, Env: p.envOverlay, Dir: p.dir}); err != nil {
			_, _ = fmt.Fprintf(out, "     (không dừng được %s trước khi khôi phục — %v; vẫn khôi phục tiếp)\n", strings.Join(stop, ", "), err)
		}
	}

	if p.oldCompose != nil {
		// Lỗi ở bước 8–9 thì db đã được dựng lại bằng ảnh MỚI: dựng lại bằng
		// ảnh CŨ và chờ healthy TRƯỚC khi khôi phục, để pg_restore tạo extension
		// đúng phiên bản của ảnh db sẽ chạy tiếp. Có giới hạn thời gian; lỗi →
		// vẫn khôi phục tiếp (best-effort).
		dbCtx, cancel := context.WithTimeout(ctx, rollbackDBWait)
		dbArgs := compose.BaseArgs(p.composePath, "up", "-d", "--wait", "--no-deps", "db")
		if _, err := runner.Output(dbCtx, dockercli.Cmd{Name: "docker", Args: dbArgs, Env: p.envOverlay, Dir: p.dir}); err != nil {
			_, _ = fmt.Fprintf(out, "     (không dựng lại được db bằng bản cũ trước khi khôi phục — %v; vẫn khôi phục tiếp)\n", err)
		}
		cancel()
	}

	restoreErr := restoreInContainer(ctx, runner, p.composePath, p.envOverlay, p.dir, p.key, true)
	restartErr := up()
	rolledBackOK := restoreErr == nil && restartErr == nil

	if n, err := pruneOldImages(ctx, runner, [][]byte{current, p.target}, out); err == nil && n > 0 {
		_, _ = fmt.Fprintf(out, "     đã dọn %d ảnh cũ.\n", n)
	}

	p.writeBlocked(out, original, !rolledBackOK)

	var next strings.Builder
	if rolledBackOK {
		_, _ = fmt.Fprintln(out, "Rollback xong: đã khôi phục "+p.key+" và khởi động lại dịch vụ bằng bản cũ.")
		next.WriteString("Rollback đã hoàn tất tự động (khôi phục " + p.key + " + khởi động lại bằng bản cũ); lịch đêm sẽ không tự thử lại bản này. ")
		next.WriteString(original.Next)
	} else {
		_, _ = fmt.Fprintln(out, "ROLLBACK THẤT BẠI — cần can thiệp tay ngay.")
		next.WriteString("ROLLBACK TỰ ĐỘNG THẤT BẠI, cần can thiệp tay ngay: ")
		if restoreErr != nil {
			next.WriteString(fmt.Sprintf("khôi phục %s lỗi (%v); ", p.key, restoreErr))
		}
		if restartErr != nil {
			next.WriteString(fmt.Sprintf("`docker compose up -d` lỗi (%v); ", restartErr))
		}
		next.WriteString("chạy tay `docker compose run --rm --no-deps -T api python -m gh.backup restore --key " + p.key + "` rồi `docker compose up -d --remove-orphans`.")
	}

	what := original.What
	if rolledBackOK {
		what += " — đã tự quay về bản cũ (khôi phục bản sao lưu)"
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

// rollbackDBWait giới hạn lần dựng lại db bằng ảnh cũ trước khi khôi phục.
const rollbackDBWait = 3 * time.Minute

// writeBlocked ghi run/update-blocked.json cho bản đang cập nhật (CẢ khi quay
// về bản cũ thất bại — rollbackFailed=true để genh/Console không nói "đã quay
// về bản cũ" khi chưa).
func (p rollbackPlan) writeBlocked(out io.Writer, original *OpError, rollbackFailed bool) {
	if p.installDir == "" {
		return
	}
	if err := hostlink.WriteUpdateBlocked(p.installDir, hostlink.UpdateBlocked{
		Version: p.version, Code: original.Code, BackupKey: p.key, Message: original.What,
		RollbackFailed: rollbackFailed,
	}); err != nil {
		_, _ = fmt.Fprintf(out, "     (không ghi được %s — %v)\n", hostlink.UpdateBlockedFile, err)
	}
}

// writeFileAtomic ghi data ra path qua tệp tạm + rename (không để lại tệp nửa vời).
func writeFileAtomic(path string, data []byte) error {
	tmp := path + ".rollback-tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("ghi %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("đổi tên %s -> %s: %w", tmp, path, err)
	}
	return nil
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
