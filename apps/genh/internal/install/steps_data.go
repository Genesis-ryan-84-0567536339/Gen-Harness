package install

import (
	"context"
	"fmt"
	"path/filepath"
	"sort"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/secretgen"
)

// dataServices là 3 service Bước 5 khởi động và chờ healthy, đúng thứ tự
// liệt kê trong docs/handoff/05-installer.md.
var dataServices = []string{"db", "redis", "objects"}

// defaultDataTimeout là thời gian tối đa chờ db/redis/objects healthy —
// compose.yaml khai healthcheck db tối đa 10×10s=100s, objects 5×15s=75s,
// nên 3 phút dư dả cho cả trường hợp máy chậm/lần đầu khởi tạo dữ liệu.
const defaultDataTimeout = 3 * time.Minute

// dataStep cài Bước 5 — Khởi động dữ liệu (8%): `docker compose up -d db
// redis objects` rồi chờ cả ba healthy qua compose.WaitHealthy.
type dataStep struct {
	runner  dockercli.Runner
	locate  func(installDir string) (string, error)
	timeout time.Duration
}

func (dataStep) ID() StepID   { return StepStartData }
func (dataStep) Name() string { return "Khởi động dữ liệu" }

func (s dataStep) Run(ctx context.Context, env *Env, rep Reporter) error {
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
		timeout = defaultDataTimeout
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

	envOverlay, err := secretsEnvOverlay(env)
	if err != nil {
		se := &StepError{
			Code: ErrCodeComposeUpFailed,
			What: "Chưa có bí mật để khởi động dữ liệu",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 5).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 5, Detail: "khởi động db, redis, objects"})

	upArgs := compose.BaseArgs(composePath, append([]string{"up", "-d"}, dataServices...)...)
	if _, err := runner.Output(ctx, dockercli.Cmd{
		Name: "docker", Args: upArgs, Env: envOverlay, Dir: filepath.Dir(composePath),
	}); err != nil {
		se := &StepError{
			Code: ErrCodeComposeUpFailed,
			What: "`docker compose up -d` cho db/redis/objects thất bại",
			Why:  err.Error(),
			Next: "Xem log ở trên rồi bấm r để thử lại — dữ liệu đã có không bị mất.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 20, Detail: "đang chờ healthy"})

	waitErr := compose.WaitHealthy(ctx, runner, composePath, envOverlay, dataServices, timeout, func(detail map[string]string) {
		rep.Report(Progress{
			Status:   StatusRunning,
			Percent:  dataHealthPercent(detail),
			Detail:   "đang chờ healthy",
			SubLines: healthSubLines(detail),
		})
	})
	if waitErr != nil {
		se := &StepError{
			Code: ErrCodeDataNotHealthy,
			What: "db/redis/objects chưa healthy trước khi hết thời gian chờ",
			Why:  waitErr.Error(),
			Next: "Xem `docker compose logs db redis objects` rồi bấm r để thử lại.",
			Err:  waitErr,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusOK, Percent: 100, Detail: "db, redis, objects healthy"})
	return nil
}

// secretsEnvOverlay đọc Env.Secrets (đặt ở Bước 4) và dựng các biến môi
// trường compose.yaml cần để dựng dữ liệu — POSTGRES_PASSWORD/
// MINIO_ROOT_PASSWORD là bắt buộc (compose.yaml dùng
// ${VAR:?đặt VAR trong .env}), không có sẽ khiến `docker compose up` tự
// thất bại ngay với thông điệp rõ ràng từ chính Compose.
func secretsEnvOverlay(env *Env) ([]string, error) {
	if env == nil || env.Secrets == nil {
		return nil, fmt.Errorf("Env.Secrets rỗng — Bước 4 (Sinh bí mật) chưa chạy")
	}
	res, ok := env.Secrets.(secretgen.Result)
	if !ok {
		return nil, fmt.Errorf("Env.Secrets có kiểu %T không mong đợi (muốn secretgen.Result)", env.Secrets)
	}
	return []string{
		"POSTGRES_PASSWORD=" + res.Bundle.DBPassword,
		"MINIO_ROOT_PASSWORD=" + res.Bundle.MinIOSecretKey,
		"MINIO_ROOT_USER=" + res.Bundle.MinIOAccessKey,
		"GH_SETUP_TOKEN=" + res.Bundle.SetupToken,
	}, nil
}

// dataHealthPercent ánh xạ số service đã healthy trong detail thành %
// nội bộ 20..95 của Bước 5 — 100% chỉ đặt khi WaitHealthy trả nil (Run
// tự báo StatusOK sau đó), tránh nhảy lên 100% giữa chừng rồi lùi lại nếu
// một service chuyển từ "healthy" về "starting" (không nên xảy ra nhưng
// không loại trừ).
func dataHealthPercent(detail map[string]string) float64 {
	if len(detail) == 0 {
		return 20
	}
	healthy := 0
	for _, v := range detail {
		if v == "healthy" || v == "đang chạy (không khai báo healthcheck)" {
			healthy++
		}
	}
	pct := 20 + 75*float64(healthy)/float64(len(detail))
	if pct > 95 {
		pct = 95
	}
	return pct
}

// healthSubLines dựng tối đa 4 dòng con "service: trạng thái", sắp theo tên
// để hiển thị ổn định (map không có thứ tự cố định).
func healthSubLines(detail map[string]string) []string {
	names := make([]string, 0, len(detail))
	for k := range detail {
		names = append(names, k)
	}
	sort.Strings(names)

	var lines []string
	for _, name := range names {
		lines = append(lines, fmt.Sprintf("%-10s %s", name, detail[name]))
		if len(lines) == 4 {
			break
		}
	}
	return lines
}
