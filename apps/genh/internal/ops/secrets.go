package ops

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
)

// auxSecretFiles là các Docker secret NGẪU NHIÊN (không nằm trong
// secretgen.Bundle) mà deploy/compose.yaml khai — genh tự sinh nếu thiếu:
//   - gh_bridge_key: khoá bridge (có từ v0.1.0, install sinh ở Bước 6);
//   - gh_browser_key (v0.1.29): khoá RIÊNG giữa api/worker và browser-worker
//     (ký việc, mã hoá phiên mạng xã hội khi truyền qua Redis).
//
// Máy cài từ bản CŨ chưa có gh_browser_key: compose.yaml mới (đồng bộ ở
// `genh update`) mount tệp này vào api/worker/browser — thiếu tệp thì
// `docker compose up` báo "bind source path does not exist" và update rollback.
// Vì vậy MỌI lệnh vận hành tìm compose.yaml (LocatePath/LocatePathSync) đều gọi
// ensureAuxSecrets trước — idempotent, không bao giờ ghi đè khoá đã có.
var auxSecretFiles = []string{"gh_bridge_key", "gh_browser_key"}

// auxSecretPerm: như install.secretFilePerm — thư mục secrets/ 0700 chặn user
// khác trên host, tệp 0644 để tiến trình trong container (uid khác) đọc được.
const auxSecretPerm = 0o644

// ensureAuxSecrets sinh các tệp trong auxSecretFiles còn thiếu trong
// <thư mục chứa compose.yaml>/../secrets. Chỉ làm khi thư mục secrets/ ĐÃ tồn
// tại (bản cài thật luôn có — gh_master_key nằm ở đó): không tự tạo thư mục
// cạnh một compose.yaml lạ (vd test, checkout repo chưa `make secrets`).
func ensureAuxSecrets(composePath string) error {
	dir := filepath.Join(filepath.Dir(composePath), "..", "secrets")
	st, err := os.Stat(dir)
	if err != nil || !st.IsDir() {
		return nil
	}
	for _, name := range auxSecretFiles {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			continue
		} else if !os.IsNotExist(err) {
			return fmt.Errorf("kiểm tra %s: %w", path, err)
		}
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return fmt.Errorf("sinh khoá ngẫu nhiên cho %s: %w", name, err)
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(base64.StdEncoding.EncodeToString(buf)), auxSecretPerm); err != nil {
			return fmt.Errorf("ghi %s: %w", tmp, err)
		}
		if err := os.Chmod(tmp, auxSecretPerm); err != nil {
			return fmt.Errorf("đặt quyền %s: %w", tmp, err)
		}
		if err := os.Rename(tmp, path); err != nil {
			return fmt.Errorf("đổi tên %s: %w", tmp, err)
		}
	}
	return nil
}
