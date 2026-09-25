package install

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/secretgen"
)

// migrateServiceName là service compose thật chạy migration.
//
// LƯU Ý — khác biệt so với docs/handoff/05-installer.md: tài liệu mô tả Bước
// 6 là "chạy migration trong container api" (ngụ ý `docker compose exec api
// alembic upgrade head`). deploy/compose.yaml THẬT lại định nghĩa một
// service riêng "migrate" (build cùng Dockerfile với api, command cố định
// ["alembic", "upgrade", "heads"], restart: "no"), và chính "api"/"worker"
// khai depends_on migrate: {condition: service_completed_successfully} — nói
// cách khác api còn chưa thể khởi động trước khi migrate chạy xong, nên
// "exec vào container api" không phải là cơ chế thật. Step này chạy đúng
// theo compose.yaml thật (`docker compose run` service "migrate"), không
// theo mô tả rút gọn trong tài liệu — xem thêm Makefile (`make migrate` gọi
// `alembic upgrade heads`, số nhiều, không phải "head" số ít).
const migrateServiceName = "migrate"

// defaultMigrateTimeout: migration chạy trong container Python khởi động
// nhanh (không cần build lại nếu image đã build ở Bước 2/3), bản thân
// alembic áp một loạt migration cho một CSDL mới thường chỉ vài giây tới vài
// chục giây — 3 phút dư dả cho máy chậm/lần cài đầu tiên.
const defaultMigrateTimeout = 3 * time.Minute

// migrationLineRe khớp dòng log alembic khi áp dụng một migration, ví dụ:
//
//	INFO  [alembic.runtime.migration] Running upgrade  -> 0001, tạo bảng gốc
//	INFO  [alembic.runtime.migration] Running upgrade 0001 -> 0002, thêm cột x
//
// Alembic ghi các dòng này qua logging (thường ra stderr) — dockercli.Runner
// .Stream gộp cả stdout lẫn stderr theo thứ tự xuất hiện nên vẫn bắt được.
var migrationLineRe = regexp.MustCompile(`(?i)running (upgrade|downgrade)\b`)

// migrateStep cài Bước 6 — Tạo cấu trúc dữ liệu (9%): chạy
// `docker compose run --rm migrate` (alembic upgrade heads, xem
// migrateServiceName ở trên), báo tiến độ theo số dòng "Running upgrade"
// thấy được trong log thật — không suy đoán tổng số migration còn lại khi
// không có cách nào biết chắc trước khi chạy, nên percent tăng dần theo số
// migration ĐÃ áp dụng thật (không phải tỉ lệ trên một tổng bịa ra).
type migrateStep struct {
	// runner cho phép tiêm dockercli.Runner giả khi test — nil dùng ExecRunner thật.
	runner dockercli.Runner
	// locate cho phép tiêm compose.Locate giả khi test — nil dùng compose.Locate.
	locate  func(installDir string) (string, error)
	timeout time.Duration
}

func (migrateStep) ID() StepID   { return StepMigrate }
func (migrateStep) Name() string { return "Tạo cấu trúc dữ liệu" }

func (s migrateStep) Run(ctx context.Context, env *Env, rep Reporter) error {
	runner := s.runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	locate := s.locate
	if locate == nil {
		locate = compose.Locate
	}
	timeout := s.timeout
	if timeout <= 0 {
		timeout = defaultMigrateTimeout
	}

	installDir := ""
	if env != nil {
		installDir = env.InstallDir
	}
	composePath, err := locate(installDir)
	if err != nil {
		se := &StepError{
			Code: ErrCodeComposeNotFound,
			What: "Không tìm thấy deploy/compose.yaml",
			Why:  err.Error(),
			Next: "Đặt biến GENH_COMPOSE_FILE trỏ tới compose.yaml rồi bấm r.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	res, err := secretsResult(env)
	if err != nil {
		se := &StepError{
			Code: ErrCodeMigrateFailed,
			What: "Chưa có bí mật để chạy migration",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 6).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}
	envOverlay, err := secretsEnvOverlay(env)
	if err != nil {
		se := &StepError{
			Code: ErrCodeMigrateFailed,
			What: "Chưa có bí mật để chạy migration",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 6).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	if err := ensureComposeSecretFiles(composePath, res); err != nil {
		se := &StepError{
			Code: ErrCodeMigrateFailed,
			What: "Không chuẩn bị được khoá bí mật cho docker compose (gh_master_key/gh_bridge_key)",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục cài đặt rồi bấm r.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 5, Detail: "đang chạy migration trong container " + migrateServiceName})

	// -T (--no-TTY) bắt buộc: genh chạy lệnh này như một subprocess không
	// gắn TTY thật, để `docker compose run` không tự ý cố cấp phát pseudo-TTY
	// (mặc định "auto-detected") rồi treo/lỗi khi không có gì để gắn vào.
	// --no-deps: db đã được Bước 5 khởi động và chờ healthy — không cần
	// compose tự đối chiếu lại phụ thuộc "db: condition: service_healthy"
	// của service migrate lần nữa. --rm: mỗi lần chạy lại (idempotent, ví dụ
	// sau khi Bước 7 thêm migration mới ở một bản cập nhật) tạo container
	// mới, không cố dùng lại container "migrate" cũ đã exited.
	runArgs := compose.BaseArgs(composePath, "run", "--rm", "-T", "--no-deps", migrateServiceName)
	dir := filepath.Dir(composePath)

	// runCtx giới hạn thời gian container migrate được phép chạy — không có
	// giới hạn này, một lệnh alembic treo (ví dụ chờ khoá bảng không bao giờ
	// nhả) sẽ làm genh install đứng hình vô thời hạn.
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var mu sync.Mutex
	applied := 0

	streamErr := runner.Stream(runCtx, dockercli.Cmd{Name: "docker", Args: runArgs, Env: envOverlay, Dir: dir}, func(line string) {
		if !migrationLineRe.MatchString(line) {
			return
		}
		mu.Lock()
		applied++
		n := applied
		mu.Unlock()
		rep.Report(Progress{
			Status:  StatusRunning,
			Percent: migrateProgressPercent(n),
			Detail:  fmt.Sprintf("đã áp dụng %d migration", n),
		})
	})

	if streamErr != nil {
		se := &StepError{
			Code: ErrCodeMigrateFailed,
			What: "`alembic upgrade heads` thất bại trong container " + migrateServiceName,
			Why:  streamErr.Error(),
			Next: "Xem log ở trên (hoặc `docker compose logs " + migrateServiceName + "`) rồi bấm r để thử lại — dữ liệu đã có không bị mất.",
			Err:  streamErr,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	mu.Lock()
	final := applied
	mu.Unlock()

	detail := "đã ở phiên bản mới nhất (không có migration mới)"
	if final > 0 {
		detail = fmt.Sprintf("đã áp dụng %d migration", final)
	}
	rep.Report(Progress{Status: StatusOK, Percent: 100, Detail: detail})
	return nil
}

// migrateProgressPercent ánh xạ số migration đã áp dụng thành % nội bộ
// 10..90 của Bước 6 — không biết trước tổng số migration còn lại (alembic
// không cho cách rẻ để đếm trước mà không tốn thêm một lượt chạy container
// riêng), nên dùng một đường cong tăng chậm dần thay vì chia theo một tổng
// bịa ra: mỗi migration mới cộng thêm ít hơn migration trước, không bao giờ
// chạm 100 (Run tự đặt 100 sau khi biết chắc đã xong).
func migrateProgressPercent(applied int) float64 {
	pct := 10 + 80*(1-1/float64(applied+1))
	if pct > 90 {
		pct = 90
	}
	return pct
}

// ensureComposeSecretFiles đảm bảo hai tệp Docker secret mà deploy/
// compose.yaml khai (secrets: gh_master_key, gh_bridge_key — đường dẫn
// "../secrets/<tên>" TƯƠNG ĐỐI VỚI THƯ MỤC CHỨA compose.yaml, tức nằm cạnh
// deploy/, không ở trong nó) tồn tại trước khi "docker compose run/up" cho
// migrate/api/worker/bridge — thiếu tệp này Compose báo lỗi "secret ... not
// found" ngay khi tạo container.
//
// LƯU Ý — khoảng trống giữa tài liệu và Bước 4 đã triển khai: docs/handoff/
// 05-installer.md liệt kê bí mật Bước 4 gồm "khoá master, mật khẩu DB, khoá
// MinIO, khoá backup, CA TLS nội bộ, setup token" — KHÔNG có khoá bridge —
// và secretgen.Bundle (Bước 4, đã triển khai ở phiên trước, ngoài phạm vi
// phiên này) đúng như vậy, không có trường BridgeKey. Nhưng compose.yaml
// thật lại đòi hỏi cả gh_bridge_key (service "bridge" ở Bước 7). Để Bước 6/7
// chạy được thật với compose.yaml hiện tại mà không phải sửa lại Bước 4,
// hàm này:
//   - ghi gh_master_key từ res.Bundle.MasterKey đã có sẵn;
//   - tự sinh gh_bridge_key (32 byte ngẫu nhiên, base64 — đúng cách
//     Makefile `make secrets` sinh) NẾU CHƯA CÓ, rồi ghi lại — idempotent,
//     không đụng tệp đã có ở lần chạy sau (giống hệt cách secretgen.EnsureCA
//     tự sinh phần còn thiếu, giữ nguyên phần đã có).
func ensureComposeSecretFiles(composePath string, res secretgen.Result) error {
	secretsDir := filepath.Join(filepath.Dir(composePath), "..", "secrets")
	if err := os.MkdirAll(secretsDir, 0o700); err != nil {
		return fmt.Errorf("tạo thư mục %s: %w", secretsDir, err)
	}
	if err := writeSecretFileIfMissing(filepath.Join(secretsDir, "gh_master_key"), res.Bundle.MasterKey); err != nil {
		return err
	}
	if _, err := ensureRandomSecretFile(filepath.Join(secretsDir, "gh_bridge_key")); err != nil {
		return err
	}
	return nil
}

// writeSecretFileIfMissing ghi content vào path chỉ khi path CHƯA tồn tại —
// không bao giờ ghi đè một bí mật đang được container khác dùng.
func writeSecretFileIfMissing(path, content string) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("kiểm tra %s: %w", path, err)
	}
	if strings.TrimSpace(content) == "" {
		return fmt.Errorf("%s: nội dung bí mật rỗng (Bước 4 chưa sinh xong?)", filepath.Base(path))
	}
	return writeFileAtomicPerm(path, []byte(content), 0o600)
}

// ensureRandomSecretFile đọc lại path nếu đã có (idempotent), hoặc sinh 32
// byte ngẫu nhiên mã hoá base64 rồi ghi mới — cùng cách `make secrets` sinh
// secrets/gh_bridge_key cho luồng dev (xem Makefile).
func ensureRandomSecretFile(path string) (string, error) {
	if data, err := os.ReadFile(path); err == nil {
		return strings.TrimSpace(string(data)), nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("đọc %s: %w", path, err)
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("sinh khoá ngẫu nhiên cho %s: %w", filepath.Base(path), err)
	}
	key := base64.StdEncoding.EncodeToString(buf)
	if err := writeFileAtomicPerm(path, []byte(key), 0o600); err != nil {
		return "", err
	}
	return key, nil
}

// writeFileAtomicPerm ghi qua tệp tạm rồi rename — tránh để lại tệp bí mật
// nửa vời nếu tiến trình bị ngắt giữa chừng (cùng cách
// secretgen.writeFileAtomic làm, viết riêng ở đây vì hàm đó không xuất ra
// khỏi package secretgen).
func writeFileAtomicPerm(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return fmt.Errorf("ghi %s: %w", tmp, err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("đổi tên %s -> %s: %w", tmp, path, err)
	}
	return nil
}
