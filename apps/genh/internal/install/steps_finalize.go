package install

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/browseropen"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
)

// caddyRootCertPath là đường dẫn CA nội bộ mà Caddy tự sinh bên trong
// container proxy khi Caddyfile dùng chỉ thị `tls internal` (xem
// deploy/caddy/Caddyfile — không có "storage" tuỳ biến nào khác, nên Caddy
// dùng thư mục dữ liệu mặc định).
//
// LƯU Ý — GIẢ ĐỊNH dựa trên hành vi mặc định của Caddy (CHƯA xác nhận bằng
// cách chạy container thật trong phiên viết code này — môi trường agent
// không có Docker daemon khả dụng, xem ghi chú "Xác minh bắt buộc" trong
// yêu cầu phiên này):
//   - deploy/compose.yaml gắn volume "caddy_data:/data" cho service "proxy"
//     — /data là thư mục dữ liệu (XDG_DATA_HOME) của image Caddy chính thức.
//   - Với `tls internal`, Caddy (qua thư viện certmagic) giữ CA nội bộ tự
//     sinh tại "<thư mục dữ liệu>/caddy/pki/authorities/local/root.crt".
//
// Nếu đường dẫn này sai trên một phiên bản Caddy cụ thể, extractCaddyRootCert
// sẽ thất bại RÕ RÀNG (lệnh `cat` trả lỗi "No such file") và Bước 8 báo
// ErrCodeTrustCAFailed — không bao giờ âm thầm dùng nhầm CA khác. Phiên sau
// nên xác nhận lại bằng cách chạy `docker compose exec proxy find /data -name
// root.crt` trên một máy có Docker thật.
const caddyRootCertPath = "/data/caddy/pki/authorities/local/root.crt"

// finalizeStep cài Bước 8 — Hoàn tất (4%): trích CA nội bộ thật của Caddy,
// (nếu Env.AutoApprove) tin cậy nó vào kho hệ điều hành, tạo lối tắt desktop,
// và mở trình duyệt vào trình thiết lập Owner
// (https://localhost:<port>/setup?token=…).
//
// Đây là bước "tiện ích cuối, best-effort": chỉ việc KHÔNG trích xuất được CA
// từ container proxy (dấu hiệu Bước 7 chưa thật sự xong) mới là lỗi chặn cài
// đặt (StatusError/ErrCodeTrustCAFailed). Mọi thất bại khác (không sudo,
// không DISPLAY, không NSS db, không quyền admin, không tạo được lối tắt) chỉ
// hạ trạng thái cuối xuống StatusWarn kèm hướng dẫn Owner tự làm tay — không
// bao giờ làm `genh install` báo lỗi toàn bộ.
type finalizeStep struct {
	// runner cho phép tiêm dockercli.Runner giả khi test — nil dùng ExecRunner thật.
	runner dockercli.Runner
	// locate cho phép tiêm compose.Locate giả khi test — nil dùng compose.Locate.
	locate func(installDir string) (string, error)

	// trustCA cho phép tiêm hàm giả khi test (tránh gọi sudo/security/certutil
	// thật) — nil dùng trustCAOS (thật, theo runtime.GOOS).
	trustCA func(ctx context.Context, certPath string) error
	// openBrowser cho phép tiêm hàm giả khi test (tránh gọi xdg-open/open/
	// rundll32 thật) — nil dùng openBrowserOS.
	openBrowser func(setupURL string) error
	// createShortcut cho phép tiêm hàm giả khi test — nil dùng
	// createShortcutOS. Trả về đường dẫn tệp lối tắt đã tạo.
	createShortcut func(setupURL string) (string, error)
}

func (finalizeStep) ID() StepID   { return StepFinalize }
func (finalizeStep) Name() string { return "Hoàn tất" }

func (s finalizeStep) Run(ctx context.Context, env *Env, rep Reporter) error {
	runner := s.runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	locate := s.locate
	if locate == nil {
		locate = compose.Locate
	}
	trustCA := s.trustCA
	if trustCA == nil {
		trustCA = trustCAOS
	}
	openBrowser := s.openBrowser
	if openBrowser == nil {
		openBrowser = openBrowserOS
	}
	createShortcut := s.createShortcut
	if createShortcut == nil {
		createShortcut = createShortcutOS
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
			Code: ErrCodeTrustCAFailed,
			What: "Chưa có bí mật để hoàn tất cài đặt",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 8).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}
	envOverlay, err := secretsEnvOverlay(env)
	if err != nil {
		se := &StepError{
			Code: ErrCodeTrustCAFailed,
			What: "Chưa có bí mật để hoàn tất cài đặt",
			Why:  err.Error(),
			Next: "Chạy lại `genh install` từ đầu (Bước 4 phải chạy trước Bước 8).",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 5, Detail: "trích xuất CA nội bộ của Caddy"})

	caPEM, err := extractCaddyRootCert(ctx, runner, composePath, envOverlay)
	if err != nil {
		se := &StepError{
			Code: ErrCodeTrustCAFailed,
			What: "Không trích xuất được CA nội bộ từ container proxy",
			Why:  err.Error(),
			Next: "Kiểm `docker compose ps proxy` đang chạy đúng (Bước 7 phải xong trước), rồi bấm r để thử lại.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	if installDir == "" {
		installDir = filepath.Dir(filepath.Dir(composePath))
	}
	certPath := filepath.Join(installDir, "config", "caddy-root.crt")
	if err := os.MkdirAll(filepath.Dir(certPath), 0o700); err != nil {
		se := &StepError{
			Code: ErrCodeTrustCAFailed,
			What: "Không tạo được thư mục cấu hình để ghi CA nội bộ",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục cài đặt rồi bấm r.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}
	if err := writeFileAtomicPerm(certPath, caPEM, 0o600); err != nil {
		se := &StepError{
			Code: ErrCodeTrustCAFailed,
			What: "Không ghi được CA nội bộ ra đĩa",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục cài đặt rồi bấm r.",
			Err:  err,
		}
		rep.Report(Progress{Status: StatusError, Percent: 100, Err: se})
		return se
	}

	rep.Report(Progress{Status: StatusRunning, Percent: 30, Detail: "tin cậy CA nội bộ vào hệ điều hành"})

	autoApprove := env != nil && env.AutoApprove
	caTrusted := false
	var caDetail string
	switch {
	case !autoApprove:
		caDetail = fmt.Sprintf("chưa tin cậy CA — chạy lại kèm --yes, hoặc tự cài %s vào kho tin cậy hệ điều hành", certPath)
	default:
		if trustErr := trustCA(ctx, certPath); trustErr != nil {
			caDetail = fmt.Sprintf("tin cậy CA tự động thất bại (%v) — tự cài %s vào kho tin cậy hệ điều hành", trustErr, certPath)
		} else {
			caTrusted = true
			caDetail = "đã tin cậy CA nội bộ vào kho hệ điều hành"
		}
	}
	rep.Report(Progress{Status: StatusRunning, Percent: 55, Detail: caDetail})

	setupURL := SetupURL(env, res.Bundle.SetupToken)

	rep.Report(Progress{Status: StatusRunning, Percent: 65, Detail: "tạo lối tắt"})
	shortcutPath, shortcutErr := createShortcut(setupURL)
	var shortcutDetail string
	if shortcutErr != nil {
		shortcutDetail = fmt.Sprintf("không tạo được lối tắt (%s): %v", ErrCodeShortcutFailed, shortcutErr)
	} else {
		shortcutDetail = "đã tạo lối tắt " + shortcutPath
	}
	rep.Report(Progress{Status: StatusRunning, Percent: 80, Detail: shortcutDetail})

	rep.Report(Progress{Status: StatusRunning, Percent: 90, Detail: "mở trình duyệt " + setupURL})
	browserErr := openBrowser(setupURL)
	if env != nil {
		env.BrowserOpened = browserErr == nil
	}

	finalStatus := StatusOK
	if !caTrusted || shortcutErr != nil || browserErr != nil {
		finalStatus = StatusWarn
	}

	summary := fmt.Sprintf(
		"CA: %s · lối tắt: %s · trình duyệt: %s",
		caSummary(caTrusted, autoApprove),
		shortcutSummary(shortcutErr),
		browserSummary(browserErr, setupURL),
	)

	rep.Report(Progress{Status: finalStatus, Percent: 100, Detail: summary})
	return nil
}

func caSummary(trusted, autoApprove bool) string {
	switch {
	case trusted:
		return "đã tin cậy"
	case autoApprove:
		return "tự tin cậy thất bại, cần cài tay"
	default:
		return "chưa tin cậy (--yes để tự động)"
	}
}

func shortcutSummary(err error) string {
	if err != nil {
		return "lỗi"
	}
	return "đã tạo"
}

func browserSummary(err error, setupURL string) string {
	if err != nil {
		return "mở tay: " + setupURL
	}
	return "đã mở"
}

// extractCaddyRootCert đọc CA nội bộ thật của Caddy qua
// `docker compose exec -T proxy cat <caddyRootCertPath>` — cần envOverlay
// giống mọi lệnh `docker compose` khác vì compose.yaml đòi hỏi các biến
// ${POSTGRES_PASSWORD:?...} được giải quyết trước khi chạy BẤT KỲ lệnh con
// nào, kể cả exec.
func extractCaddyRootCert(ctx context.Context, runner dockercli.Runner, composePath string, envOverlay []string) ([]byte, error) {
	args := compose.BaseArgs(composePath, "exec", "-T", "proxy", "cat", caddyRootCertPath)
	out, err := runner.Output(ctx, dockercli.Cmd{
		Name: "docker", Args: args, Env: envOverlay, Dir: filepath.Dir(composePath),
	})
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(string(out)) == "" {
		return nil, fmt.Errorf("nội dung CA đọc được rỗng")
	}
	return out, nil
}

// SetupURL dựng URL trình thiết lập Owner đúng mockup "Màn kết thúc" của
// docs/handoff/05-installer.md (https://localhost:8443/setup?token=…) — dùng
// chung bởi finalizeStep (mở trình duyệt/tạo lối tắt) và cmd/genh (điền
// tui.FinishInfo.SetupURL sau khi Runner chạy xong).
func SetupURL(env *Env, token string) string {
	port := 0
	if env != nil {
		port = env.Port
	}
	if port <= 0 {
		port = machine.DefaultPort
	}
	u := url.URL{Scheme: "https", Host: fmt.Sprintf("localhost:%d", port), Path: "/setup"}
	q := u.Query()
	q.Set("token", token)
	u.RawQuery = q.Encode()
	return u.String()
}

// trustCAOS tin cậy certPath vào kho tin cậy hệ điều hành theo runtime.GOOS —
// chỉ gọi khi Env.AutoApprove == true. Bọc trong context timeout ngắn để một
// lệnh treo (ví dụ security chờ keychain mở khoá) không làm genh install
// đứng hình.
func trustCAOS(ctx context.Context, certPath string) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	switch runtime.GOOS {
	case "linux":
		return trustCALinux(ctx, certPath)
	case "darwin":
		return trustCADarwin(ctx, certPath)
	case "windows":
		return trustCAWindows(ctx, certPath)
	default:
		return fmt.Errorf("chưa hỗ trợ tự động tin cậy CA trên %s", runtime.GOOS)
	}
}

// trustCALinux thử `update-ca-certificates` qua sudo không tương tác (-n):
// nếu máy không có sudo cache sẵn (thường đúng trên CI/container), lệnh thất
// bại NGAY thay vì treo chờ mật khẩu — đúng tinh thần "best-effort, không
// chặn cài đặt" của Bước 8.
func trustCALinux(ctx context.Context, certPath string) error {
	const dest = "/usr/local/share/ca-certificates/gen-harness-ca.crt"
	script := fmt.Sprintf("cp %q %q && update-ca-certificates", certPath, dest)
	cmd := exec.CommandContext(ctx, "sudo", "-n", "sh", "-c", script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("sudo update-ca-certificates: %w — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// trustCADarwin dùng login keychain của user hiện tại — KHÔNG cần sudo (chỉ
// System keychain mới cần).
func trustCADarwin(ctx context.Context, certPath string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return fmt.Errorf("không xác định được thư mục home: %w", err)
	}
	keychain := filepath.Join(home, "Library", "Keychains", "login.keychain-db")
	cmd := exec.CommandContext(ctx, "security", "add-trusted-cert", "-d", "-r", "trustRoot", "-k", keychain, certPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("security add-trusted-cert: %w — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// trustCAWindows dùng kho "-user Root" — KHÔNG cần quyền admin (khác kho
// "-enterprise"/"-machine" cần chạy nâng quyền).
func trustCAWindows(ctx context.Context, certPath string) error {
	cmd := exec.CommandContext(ctx, "certutil", "-addstore", "-user", "Root", certPath)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("certutil -addstore: %w — %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// openBrowserOS khởi chạy trình duyệt hệ thống vào setupURL — cài đặt thật
// nằm ở internal/browseropen (dùng chung với các lệnh vận hành `genh open`/
// `genh uninstall`, xem internal/ops), giữ tên/signature này để các test
// tiêm giả (trustCA/openBrowser/createShortcut) trong steps_finalize_test.go
// không phải đổi.
func openBrowserOS(setupURL string) error { return browseropen.Open(setupURL) }

// createShortcutOS tạo một lối tắt desktop trỏ vào setupURL, trả về đường
// dẫn tệp đã ghi. KHÔNG cần Env.AutoApprove — tạo một tệp trong thư mục
// riêng của user không cần quyền rộng. Cài đặt thật nằm ở
// internal/browseropen — xem ghi chú openBrowserOS.
func createShortcutOS(setupURL string) (string, error) { return browseropen.CreateShortcut(setupURL) }
