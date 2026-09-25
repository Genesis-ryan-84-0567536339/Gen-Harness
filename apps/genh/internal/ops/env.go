package ops

import (
	"path/filepath"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/config"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/machine"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/secretgen"
)

// Env là ngữ cảnh dùng chung cho mọi lệnh vận hành — cố ý nhỏ hơn
// install.Env (không có Secrets/AutoApprove/BrowserOpened, những trường chỉ
// có ý nghĩa trong lúc `genh install` đang chạy): các lệnh vận hành đọc lại
// bí mật đã có qua LoadSecrets khi cần, không tự sinh mới (xem
// secretgen.Load).
type Env struct {
	// InstallDir là gốc cài đặt, mặc định ~/.gen-harness (config.DefaultRoot).
	InstallDir string
	// Port là cổng HTTPS cho proxy, mặc định machine.DefaultPort — dùng để
	// gọi /api/v1/ready và dựng URL Console.
	Port int

	// locate cho phép tiêm compose.Locate giả khi test — nil dùng
	// compose.Locate.
	locate func(installDir string) (string, error)
}

// ResolveInstallDir trả về InstallDir đã cấu hình, hoặc config.DefaultRoot()
// nếu rỗng — dùng bởi cmd/genh khi dựng Env từ cờ `--install-dir`.
func ResolveInstallDir(installDir string) (string, error) {
	if installDir != "" {
		return installDir, nil
	}
	return config.DefaultRoot()
}

// ResolvePort trả về port đã cấu hình, hoặc machine.DefaultPort nếu <= 0.
func ResolvePort(port int) int {
	if port <= 0 {
		return machine.DefaultPort
	}
	return port
}

// ConfigDir trả về thư mục cấu hình/bí mật của bản cài (Bước 4 ghi vào đây).
func (e *Env) ConfigDir() string {
	return filepath.Join(e.InstallDir, "config")
}

// LocatePath tìm deploy/compose.yaml thật, hoặc trả OpError có cấu trúc nếu
// không thấy.
func (e *Env) LocatePath() (string, error) {
	locate := e.locate
	if locate == nil {
		locate = compose.Locate
	}
	path, err := locate(e.InstallDir)
	if err != nil {
		return "", &OpError{
			Code: ErrCodeComposeNotFound,
			What: "Không tìm thấy deploy/compose.yaml",
			Why:  err.Error(),
			Next: "Đặt biến GENH_COMPOSE_FILE trỏ tới compose.yaml, hoặc chạy `genh install` trước.",
			Err:  err,
		}
	}
	return path, nil
}

// LoadSecrets đọc lại bí mật đã sinh ở Bước 4 (KHÔNG sinh mới — xem
// secretgen.Load) hoặc trả OpError rõ ràng "chưa cài" nếu thư mục cấu hình
// chưa có bí mật nào.
func (e *Env) LoadSecrets() (secretgen.Bundle, error) {
	b, err := secretgen.Load(e.ConfigDir())
	if err != nil {
		return secretgen.Bundle{}, &OpError{
			Code: ErrCodeNotInstalled,
			What: "Chưa cài Gen-Harness (hoặc thư mục cài đặt không đúng)",
			Why:  err.Error(),
			Next: "Chạy `genh install` trước, hoặc kiểm cờ --install-dir nếu bạn cài vào thư mục khác mặc định.",
			Err:  err,
		}
	}
	return b, nil
}

// EnvOverlay dựng các biến môi trường compose.yaml cần cho MỌI lệnh `docker
// compose` (kể cả `ps`/`logs`/`stop` — Compose parse toàn bộ tệp, kể cả các
// khoá ${VAR:?...} bắt buộc, trước khi chạy bất kỳ subcommand nào) — cùng
// logic secretsEnvOverlay trong internal/install/steps_data.go, viết lại ở
// đây vì đó là hàm không xuất của package khác.
func EnvOverlay(b secretgen.Bundle) []string {
	return []string{
		"POSTGRES_PASSWORD=" + b.DBPassword,
		"MINIO_ROOT_PASSWORD=" + b.MinIOSecretKey,
		"MINIO_ROOT_USER=" + b.MinIOAccessKey,
		"GH_SETUP_TOKEN=" + b.SetupToken,
	}
}

// composeDir trả về thư mục chứa composePath, dùng làm Dir cho dockercli.Cmd.
func composeDir(composePath string) string { return filepath.Dir(composePath) }
