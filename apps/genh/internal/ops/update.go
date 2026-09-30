package ops

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// updateServiceOrder là các service compose có thể "cập nhật" qua
// `docker compose pull` — cùng danh sách 6 service của Bước 3 (internal/
// install/steps_pull.go pullServiceOrder, đã bỏ "objects" — MinIO không còn
// trong compose.yaml), viết lại ở đây vì đó là biến không xuất của package
// khác.
var updateServiceOrder = []string{"db", "redis", "proxy", "api", "web", "bridge", "browser"}

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
	// ReTrustCA chạy sau khi cập nhật THÀNH CÔNG để tin cậy lại CA nội bộ của
	// Caddy (Owner hết thấy "Not secure") — nil dùng retrustCASilently. Test
	// tiêm hàm giả để không đụng kho chứng chỉ thật của máy chạy test.
	ReTrustCA func(ctx context.Context, env *Env)
}

// retrustCASilently: best-effort, im lặng — lỗi gì cũng bỏ qua, không bao giờ
// hỏi Owner (update có thể đang chạy nền qua watcher).
func retrustCASilently(ctx context.Context, env *Env) {
	_ = RunTrustCA(ctx, env, false, TrustCADeps{}, io.Discard)
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
// cho các service ĐÃ có "image:" cố định trong compose.yaml (proxy/redis ở
// trạng thái repo hiện tại — xem resolveUpdateServices). Các
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

	// LocatePath (KHÔNG LocatePathSync) ở ĐÂY: bước 1 (backup) PHẢI chạy với
	// compose.yaml ĐANG THẬT SỰ có trên đĩa (bản mà container hiện tại — có
	// thể là một phiên bản genh cũ hơn — được dựng lên), không phải bản vừa
	// đồng bộ với binary genh mới. SỬA LỖI (docs/reports/HANDOFF-v0.1.1.md
	// mục "Lỗi cần sửa" #3 của v0.1.2): bản trước gọi LocatePathSync ngay ở
	// đây, TRƯỚC bước backup — nếu compose.yaml GENH QUẢN LÝ đã lệch bản
	// nhúng (binary genh vừa được cài lại mới hơn bản đang chạy dịch vụ),
	// compose.yaml bị ghi đè bằng bản MỚI trước khi backup, rồi nếu bước sau
	// (pull/migrate/restart) lỗi, rollbackAndWrap khôi phục DỮ LIỆU cũ nhưng
	// lại khởi động bằng compose.yaml MỚI — lệch nhau. Đồng bộ compose.yaml
	// (xem bước 1.5 dưới) chỉ chạy SAU KHI backup đã thành công.
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

	// 1. Backup tự động TRƯỚC khi đụng gì (kể cả compose.yaml) — không có
	// backup, không có gì để rollback về.
	_, _ = fmt.Fprintln(out, "1/5 Backup tự động…")
	key, err := runBackupInContainer(ctx, runner, composePath, envOverlay, dir, BackupTriggerPreUpdate)
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

	// 1.5. Đồng bộ compose.yaml GENH QUẢN LÝ với bản nhúng của binary genh
	// đang chạy CHỈ SAU KHI backup đã thành công — giữ bản cũ ở
	// compose.yaml.bak (xem compose.LocateAndSync) để rollback (bên dưới)
	// khôi phục lại đúng bản đó nếu cần. syncedPath PHẢI trùng composePath —
	// khác đi nghĩa là compose.Locate/LocateAndSync tìm ra hai candidate khác
	// nhau giữa hai lần gọi (không nên xảy ra, nhưng không âm thầm bỏ qua).
	syncedPath, err := env.LocatePathSync()
	if err != nil {
		return &OpError{
			Code: ErrCodeUpdateComposeSyncFailed,
			What: "Đồng bộ compose.yaml với bản genh mới thất bại — backup " + key + " đã có, CHƯA đụng gì tới dịch vụ",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi vào " + dir + " rồi thử lại `genh update` — dịch vụ vẫn đang chạy bình thường, không cần rollback.",
			Err:  err,
		}
	}
	if syncedPath != composePath {
		return &OpError{
			Code: ErrCodeUpdateComposeSyncFailed,
			What: "Đồng bộ compose.yaml tìm ra một đường dẫn khác với lúc backup — DỪNG LẠI để không dùng nhầm compose.yaml",
			Why:  fmt.Sprintf("backup dùng %s, đồng bộ trả về %s", composePath, syncedPath),
			Next: "Đặt biến GENH_COMPOSE_FILE trỏ đúng một tệp compose.yaml rồi thử lại `genh update`.",
		}
	}

	// 2. Di trú dữ liệu /tmp/gh-objects (v0.1.0, container KHÔNG có volume)
	// sang volume gh_objects (v0.1.1+) NẾU máy này còn container cũ kiểu đó
	// — xem migrateobjects.go và docs/reports/HANDOFF-v0.1.1.md mục "Lỗi cần
	// sửa" #2 của v0.1.2. PHẢI chạy TRƯỚC pull/up (bước 4 tạo lại container,
	// xoá luôn /tmp/gh-objects của container cũ) — objectsHostDir rỗng nếu
	// không có gì để di trú (bản cài mới từ v0.1.1 trở lên).
	_, _ = fmt.Fprintln(out, "2/5 Kiểm dữ liệu /tmp/gh-objects (bản cài cũ)…")
	objectsHostDir, err := captureLegacyObjectsIfAny(ctx, runner, composePath, envOverlay, dir, env.InstallDir, out)
	if err != nil {
		return &OpError{
			Code: ErrCodeUpdateObjectsMigrateFailed,
			What: "Di trú dữ liệu /tmp/gh-objects (bản cài cũ) thất bại — DỪNG LẠI, chưa pull/tạo lại container",
			Why:  err.Error(),
			Next: "Xem lỗi ở trên rồi thử lại `genh update` — bản backup " + key + " vẫn còn.",
			Err:  err,
		}
	}
	if objectsHostDir == "" {
		_, _ = fmt.Fprintln(out, "     không có gì để di trú.")
	}

	// 3. Tải bản mới.
	_, _ = fmt.Fprintln(out, "3/5 Tải bản mới…")
	cf, err := compose.Load(composePath)
	if err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, objectsHostDir, out, &OpError{
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
			return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, objectsHostDir, out, &OpError{
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

	// 4. Migrate.
	_, _ = fmt.Fprintln(out, "4/5 Tạo cấu trúc dữ liệu (migrate)…")
	migrateArgs := compose.BaseArgs(composePath, "run", "--rm", "-T", "--no-deps", "migrate")
	if err := runner.Stream(ctx, dockercli.Cmd{Name: "docker", Args: migrateArgs, Env: envOverlay, Dir: dir}, func(string) {}); err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, objectsHostDir, out, &OpError{
			Code: ErrCodeUpdateMigrateFailed,
			What: "`alembic upgrade heads` thất bại trong container migrate",
			Why:  err.Error(),
			Next: "Xem `docker compose logs migrate` sau khi rollback xong.",
			Err:  err,
		})
	}

	// 5. Khởi động lại theo thứ tự (Compose tự áp depends_on). --remove-orphans
	// dọn container của service KHÔNG CÒN trong compose.yaml hiện tại — cần
	// cho máy cài từ v0.1.0 (còn container MinIO "objects" cũ) nâng cấp lên
	// bản đã bỏ MinIO, xem docs/reports/HANDOFF-v0.1.1.md mục "Lỗi cần sửa"
	// #5 của v0.1.2. Vô hại với máy đã ở bản mới (không có orphan để dọn).
	_, _ = fmt.Fprintln(out, "5/5 Khởi động lại dịch vụ…")
	upArgs := compose.BaseArgs(composePath, "up", "-d", "--remove-orphans")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: upArgs, Env: envOverlay, Dir: dir}); err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, objectsHostDir, out, &OpError{
			Code: ErrCodeUpdateRestartFailed,
			What: "`docker compose up -d` sau khi cập nhật thất bại",
			Why:  err.Error(),
			Next: "Xem `docker compose logs` sau khi rollback xong.",
			Err:  err,
		})
	}

	readyURL := localURL(env.Port, readyPath)
	if err := waitReady(ctx, client, readyURL, timeout, pollEvery); err != nil {
		return rollbackAndWrap(ctx, runner, composePath, envOverlay, dir, key, objectsHostDir, out, &OpError{
			Code: ErrCodeUpdateNotReady,
			What: readyPath + " không trả 200 sau khi cập nhật",
			Why:  err.Error(),
			Next: "Xem `docker compose logs` sau khi rollback xong.",
			Err:  err,
		})
	}

	// Container api MỚI (đã mount volume gh_objects) đã lên VÀ healthy — giờ
	// mới chép dữ liệu đã di trú vào volume (chép sớm hơn là chép vào một
	// container sắp bị "up -d" ở bước 5 thay thế, vô nghĩa). Giữ nguyên
	// objectsHostDir trên đĩa dù bước này thành công hay không — Owner luôn
	// còn bản THÔ để tự chép tay nếu cần.
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

	reTrust := deps.ReTrustCA
	if reTrust == nil {
		reTrust = retrustCASilently
	}
	reTrust(ctx, env)

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
//
// objectsHostDir (rỗng nếu không có gì di trú, xem captureLegacyObjectsIfAny
// ở migrateobjects.go): nếu khác rỗng, TRƯỚC KHI gọi restoreInContainer,
// chép lại đúng dữ liệu đó vào volume gh_objects — bản backup vừa tạo ở bước
// 1/5 (mà restoreInContainer sắp khôi phục) nằm TRONG chính objectsHostDir
// (đã gộp cùng dữ liệu cũ), và nếu rollback xảy ra SAU KHI `docker compose
// up -d` (bước 5/5) đã thay container cũ bằng container mới (volume gh_objects
// TRỐNG TRƠN, chưa kịp seedObjectsVolume — bước đó chỉ chạy sau khi
// healthy), restore sẽ không tìm thấy khoá backup nếu không seed lại trước.
// Seed lại LUÔN vô hại nếu container cũ vẫn còn nguyên (chưa qua "up -d") —
// chỉ ghi đè bằng đúng dữ liệu đã có.
//
// KHÔI PHỤC compose.yaml (SỬA LỖI mục #3 v0.1.2): composePath đến đây có thể
// đã được đồng bộ lên bản MỚI (bước 1.5 trong RunUpdate, chạy ngay sau backup
// — mọi lỗi rollbackAndWrap xử lý đều xảy ra SAU bước đó). Dữ liệu vừa
// restoreInContainer khôi phục lại là snapshot chụp DƯỚI compose.yaml CŨ
// (bước 1/5, trước khi đồng bộ), nên trước khi restore + up lại, PHẢI khôi
// phục compose.yaml về đúng bản CŨ đó (compose.yaml.bak, do
// compose.LocateAndSync tự giữ lại — xem restoreComposeFromBackupIfAny) để
// container khởi động lại khớp với đúng dữ liệu vừa restore, và
// --remove-orphans (bên dưới) so khớp đúng compose.yaml CŨ (không xoá nhầm
// service chỉ compose.yaml CŨ mới có, ví dụ MinIO "objects" của v0.1.0).
func rollbackAndWrap(ctx context.Context, runner dockercli.Runner, composePath string, envOverlay []string, dir, key, objectsHostDir string, out io.Writer, original *OpError) error {
	_, _ = fmt.Fprintf(out, "LỖI (%s) — đang tự động rollback về backup %s…\n", original.Code, key)

	if err := restoreComposeFromBackupIfAny(composePath); err != nil {
		_, _ = fmt.Fprintf(out, "     (không khôi phục được compose.yaml về bản trước khi đồng bộ — %v; rollback tiếp tục với compose.yaml hiện tại)\n", err)
	}

	if objectsHostDir != "" {
		if err := seedObjectsVolume(ctx, runner, composePath, envOverlay, dir, objectsHostDir); err != nil {
			_, _ = fmt.Fprintf(out, "     (không chép lại được dữ liệu di trú vào volume trước khi khôi phục — %v; dữ liệu THÔ vẫn còn tại %s)\n", err, objectsHostDir)
		}
	}

	restoreErr := restoreInContainer(ctx, runner, composePath, envOverlay, dir, key)
	var restartErr error
	upArgs := compose.BaseArgs(composePath, "up", "-d", "--remove-orphans")
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

// restoreComposeFromBackupIfAny khôi phục compose.yaml tại composePath về
// đúng nội dung của composePath+".bak" (tệp compose.LocateAndSync/
// syncEmbeddedCompose tự ghi TRƯỚC khi đồng bộ, giữ nguyên bản cũ — xem
// internal/compose/locate.go) — dùng bởi rollbackAndWrap để đưa compose.yaml
// về đúng bản đã dùng lúc backup TRƯỚC KHI restore dữ liệu + up lại (mục #3
// v0.1.2). KHÔNG lỗi nếu không có .bak (đồng bộ ở bước 1.5 không đổi gì —
// genh hiện tại cùng bản với lần cài/cập nhật trước, compose.yaml đã đúng
// sẵn, không có gì để khôi phục).
func restoreComposeFromBackupIfAny(composePath string) error {
	bak := composePath + ".bak"
	data, err := os.ReadFile(bak)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("đọc %s: %w", bak, err)
	}
	tmp := composePath + ".rollback-tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return fmt.Errorf("ghi %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, composePath); err != nil {
		return fmt.Errorf("đổi tên %s -> %s: %w", tmp, composePath, err)
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
