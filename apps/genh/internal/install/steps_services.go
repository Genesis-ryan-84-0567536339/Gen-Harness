package install

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"path/filepath"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
)

// startupServices là 5 service Bước 7 khởi động, đúng tên VÀ đúng thứ tự
// liệt kê trong docs/handoff/05-installer.md — tên trùng khớp 1-1 với
// deploy/compose.yaml (api, worker, bridge, web, proxy đều là tên service
// thật, không cần đổi).
var startupServices = []string{"api", "worker", "bridge", "web", "proxy"}

// readyPath là endpoint readiness thật của apps/api — xem
// apps/api/gh/shell/routes.py (@router.get("/ready"), mount ở
// apps/api/gh/app.py với prefix "/api/v1") — TRẢ 200 khi cả db lẫn redis
// đều "ok", 503 nếu không, đúng khớp với "/api/v1/ready" mà
// docs/handoff/05-installer.md nói tắt là "/api/ready" và step.go (Env.Port)
// đã ghi chú đúng đường dẫn đầy đủ.
const readyPath = "/api/v1/ready"

// defaultServicesTimeout: api cần chờ migrate xong (đã chạy ở Bước 6) rồi
// mới healthy, worker/bridge/web có healthcheck riêng, proxy chờ cả
// api lẫn web healthy trước khi tự nó "running" — cộng dồn thời gian khởi
// động container + healthcheck đầu tiên của từng service, 3 phút dư dả cho
// máy chậm/lần đầu.
const defaultServicesTimeout = 3 * time.Minute

// defaultReadyPollInterval là khoảng nghỉ giữa hai lần gọi readyPath.
const defaultReadyPollInterval = 2 * time.Second

// servicesStep cài Bước 7 — Khởi động dịch vụ (6%): `docker compose up -d`
// cho startupServices rồi chờ readyPath trả 200 qua HTTPS ở cổng Env.Port.
type servicesStep struct {
	// runner cho phép tiêm dockercli.Runner giả khi test — nil dùng ExecRunner thật.
	runner dockercli.Runner
	// locate cho phép tiêm compose.Locate giả khi test — nil dùng compose.Locate.
	locate func(installDir string) (string, error)
	// client cho phép tiêm *http.Client giả (ví dụ trỏ vào httptest.Server)
	// khi test — nil dùng client TLS mặc định (xem lý do InsecureSkipVerify
	// ở newInsecureReadyClient).
	client    *http.Client
	timeout   time.Duration
	pollEvery time.Duration
}

func (servicesStep) ID() StepID   { return StepStartServices }
func (servicesStep) Name() string { return "Khởi động dịch vụ" }

func (s servicesStep) Run(ctx context.Context, env *Env, rep Reporter) error {
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
		timeout = defaultServicesTimeout
	}
	pollEvery := s.pollEvery
	if pollEvery <= 0 {
		pollEvery = defaultReadyPollInterval
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
			Code: ErrCodeServicesUpFailed,
			What: "Chưa có bí mật để khởi động dịch vụ",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 7).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}
	envOverlay, err := secretsEnvOverlay(env)
	if err != nil {
		se := &StepError{
			Code: ErrCodeServicesUpFailed,
			What: "Chưa có bí mật để khởi động dịch vụ",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 7).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	// ensureComposeSecretFiles (steps_migrate.go) đã chạy ở Bước 6 trong một
	// lượt `genh install` bình thường — gọi lại ở đây rẻ và idempotent
	// (không ghi đè gì đã có), phòng trường hợp Owner chỉ thử lại riêng Bước
	// 7 sau khi Bước 6 đã xong ở một lần chạy trước.
	if err := ensureComposeSecretFiles(composePath, res); err != nil {
		se := &StepError{
			Code: ErrCodeServicesUpFailed,
			What: "Không chuẩn bị được khoá bí mật cho docker compose (gh_master_key/gh_bridge_key)",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục cài đặt rồi bấm r.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 5, Detail: "khởi động api, worker, bridge, web, proxy"})

	upArgs := compose.BaseArgs(composePath, append([]string{"up", "-d"}, startupServices...)...)
	if _, err := runner.Output(ctx, dockercli.Cmd{
		Name: "docker", Args: upArgs, Env: envOverlay, Dir: filepath.Dir(composePath),
	}); err != nil {
		se := &StepError{
			Code: ErrCodeServicesUpFailed,
			What: "`docker compose up -d` cho api/worker/bridge/web/proxy thất bại",
			Why:  err.Error(),
			Next: "Xem log ở trên rồi bấm r để thử lại — dữ liệu đã có không bị mất.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 20, Detail: "đang chờ " + readyPath})

	client := s.client
	if client == nil {
		client = newInsecureReadyClient()
	}

	port := 0
	if env != nil {
		port = env.Port
	}
	if port <= 0 {
		port = machine.DefaultPort
	}
	url := fmt.Sprintf("https://127.0.0.1:%d%s", port, readyPath)

	waitErr := waitServiceReady(ctx, client, url, timeout, pollEvery, func(pct float64, attempt int) {
		rep.Report(Progress{
			Status:  StatusRunning,
			Percent: pct,
			Detail:  fmt.Sprintf("đang chờ %s (lần %d)", readyPath, attempt),
		})
	})
	if waitErr != nil {
		se := &StepError{
			Code: ErrCodeServiceNotReady,
			What: readyPath + " không trả 200 trước khi hết thời gian chờ",
			Why:  waitErr.Error(),
			Next: "Xem `docker compose logs api worker bridge web proxy` rồi bấm r để thử lại.",
			Err:  waitErr,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusOK, Percent: 100, Detail: "api, worker, bridge, web, proxy đã sẵn sàng"})
	return nil
}

// newInsecureReadyClient dựng http.Client cho việc thăm dò readyPath.
//
// LƯU Ý vì sao InsecureSkipVerify: deploy/caddy/Caddyfile dùng chỉ thị `tls
// internal` — Caddy TỰ quản lý một CA nội bộ RIÊNG (sinh và giữ trong volume
// caddy_data lúc container proxy khởi động lần đầu), KHÁC với CA mà
// secretgen.EnsureCA sinh ở Bước 4 (secretgen.Result.CACertPEM). Hai CA này
// không liên quan tới nhau, nên không thể dùng CACertPEM để verify chứng chỉ
// mà proxy thật sự trình ra ở :8443 — muốn verify đúng phải trích xuất CA
// nội bộ của Caddy từ trong volume (ví dụ qua `docker compose exec proxy cat
// /data/caddy/pki/authorities/local/root.crt`), việc này để lại cho khi cần
// (không cần thiết cho một lượt gọi readiness qua loopback trong lúc cài,
// không mang theo bí mật gì). InsecureSkipVerify vì vậy là lựa chọn có chủ
// đích, không phải bỏ sót — Bước 8 (Hoàn tất, chưa làm ở phiên này) mới là
// nơi hỏi Owner tin cậy CA để trình duyệt không cảnh báo.
func newInsecureReadyClient() *http.Client {
	return &http.Client{
		Timeout: 5 * time.Second,
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // xem ghi chú hàm
		},
	}
}

// waitServiceReady gọi GET url lặp lại cho tới khi nhận 200, hoặc hết
// timeout. onTick, nếu khác nil, được gọi sau mỗi lần thử (kể cả lần thất
// bại) để Step báo tiến độ qua Reporter — percent tăng dần theo tỉ lệ thời
// gian đã trôi qua trên timeout (tiến độ thật của việc CHỜ, không phải suy
// đoán readyPath còn bao lâu nữa mới sẵn sàng — không có cách nào biết
// trước điều đó).
func waitServiceReady(ctx context.Context, client *http.Client, url string, timeout, pollEvery time.Duration, onTick func(pct float64, attempt int)) error {
	deadline := time.Now().Add(timeout)
	attempt := 0

	for {
		attempt++
		if probeReady(ctx, client, url) {
			return nil
		}

		if time.Now().After(deadline) {
			return fmt.Errorf("hết thời gian chờ %s", timeout)
		}

		if onTick != nil {
			onTick(waitReadyPercent(deadline, timeout), attempt)
		}

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(pollEvery):
		}
	}
}

// waitReadyPercent ánh xạ thời gian còn lại tới deadline thành % nội bộ
// 20..95 của Bước 7 (20 là mốc Run đặt ngay sau khi `up -d` xong, trước khi
// vào vòng chờ — xem Run).
func waitReadyPercent(deadline time.Time, timeout time.Duration) float64 {
	remaining := time.Until(deadline)
	if remaining < 0 {
		remaining = 0
	}
	elapsedFrac := 1 - remaining.Seconds()/timeout.Seconds()
	pct := 20 + 75*elapsedFrac
	if pct < 20 {
		pct = 20
	}
	if pct > 95 {
		pct = 95
	}
	return pct
}

func probeReady(ctx context.Context, client *http.Client, url string) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	return resp.StatusCode == http.StatusOK
}
