package ops

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// auxSecretFiles là các Docker secret NGẪU NHIÊN (không nằm trong
// secretgen.Bundle) mà deploy/compose.yaml khai — genh tự sinh nếu thiếu:
//   - gh_bridge_key: khoá bridge (có từ v0.1.0, install sinh ở Bước 6);
//   - gh_browser_key (v0.1.29): khoá RIÊNG giữa api/worker và browser-worker
//     (ký việc, mã hoá phiên mạng xã hội khi truyền qua Redis);
//   - gh_offsite_key (v0.1.40, F-12): "Khoá khôi phục" — mật khẩu gói .ghbundle
//     của bản sao ngoài máy (định dạng dễ gõ/in, xem GenerateOffsiteKey).
//
// Máy cài từ bản CŨ chưa có gh_browser_key: compose.yaml mới (đồng bộ ở
// `genh update`) mount tệp này vào api/worker/browser — thiếu tệp thì
// `docker compose up` báo "bind source path does not exist" và update rollback.
// Vì vậy MỌI lệnh vận hành tìm compose.yaml (LocatePath/LocatePathSync) đều gọi
// ensureAuxSecrets trước — idempotent, không bao giờ ghi đè khoá đã có.
var auxSecretFiles = []string{"gh_bridge_key", "gh_browser_key", offsiteKeyName}

// offsiteKeyName là tên Docker secret của khoá khôi phục (chỉ mount vào api).
const offsiteKeyName = "gh_offsite_key"

// auxSecretPerm: như install.secretFilePerm — thư mục secrets/ 0700 chặn user
// khác trên host, tệp 0644 để tiến trình trong container (uid khác) đọc được.
const auxSecretPerm = 0o644

// auxSecretGen trả bộ sinh nội dung cho từng khoá: gh_offsite_key dùng định
// dạng dễ gõ/in, các khoá cũ giữ 32 byte base64.
func auxSecretGen(name string) func() (string, error) {
	if name == offsiteKeyName {
		return GenerateOffsiteKey
	}
	return func() (string, error) {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return "", err
		}
		return base64.StdEncoding.EncodeToString(buf), nil
	}
}

// GenerateOffsiteKey sinh "Khoá khôi phục": 6 nhóm × 5 ký tự base32 HOA (A–Z,
// 2–7) nối bằng '-' (vd K7QX2-…), 30 ký tự ngẫu nhiên = 150 bit, KHÔNG xuống
// dòng. Mật khẩu gói .ghbundle chính là chuỗi này (35 ký tự ≥ 12 của gh.bundle).
// install/steps_migrate.go có bản sao y hệt (install không import được ops).
func GenerateOffsiteKey() (string, error) {
	buf := make([]byte, 19) // 152 bit → 31 ký tự base32, lấy 30
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	s := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)[:30]
	groups := make([]string, 0, 6)
	for i := 0; i < 30; i += 5 {
		groups = append(groups, s[i:i+5])
	}
	return strings.Join(groups, "-"), nil
}

// offsiteKeyID: 8 ký tự hex đầu sha256(khoá) — để Owner đối chiếu bản in "Bộ
// khôi phục" với máy mà không lộ khoá (hợp đồng với apps/api).
func offsiteKeyID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])[:8]
}

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
		content, err := auxSecretGen(name)()
		if err != nil {
			return fmt.Errorf("sinh khoá ngẫu nhiên cho %s: %w", name, err)
		}
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(content), auxSecretPerm); err != nil {
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
