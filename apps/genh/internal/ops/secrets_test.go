package ops

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

// Máy cài từ bản cũ (chỉ có gh_master_key + gh_bridge_key): mọi lệnh vận hành
// tìm compose.yaml phải tự sinh gh_browser_key (v0.1.29) — không ghi đè khoá cũ,
// không tạo secrets/ cạnh một compose.yaml lạ.
func TestEnsureAuxSecrets_FillsMissingBrowserKeyOnly(t *testing.T) {
	root := t.TempDir()
	deploy := filepath.Join(root, "deploy")
	secrets := filepath.Join(root, "secrets")
	if err := os.MkdirAll(deploy, 0o755); err != nil {
		t.Fatal(err)
	}
	composePath := filepath.Join(deploy, "compose.yaml")
	// Chưa có secrets/ → không làm gì.
	if err := ensureAuxSecrets(composePath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(secrets); !os.IsNotExist(err) {
		t.Fatalf("không được tự tạo secrets/: %v", err)
	}
	if err := os.MkdirAll(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(secrets, "gh_bridge_key"), []byte("khoa-bridge-cu"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureAuxSecrets(composePath); err != nil {
		t.Fatal(err)
	}
	bridge, _ := os.ReadFile(filepath.Join(secrets, "gh_bridge_key"))
	if string(bridge) != "khoa-bridge-cu" {
		t.Fatalf("gh_bridge_key bị ghi đè: %q", bridge)
	}
	raw, err := os.ReadFile(filepath.Join(secrets, "gh_browser_key"))
	if err != nil {
		t.Fatalf("thiếu gh_browser_key: %v", err)
	}
	key, err := base64.StdEncoding.DecodeString(string(raw))
	if err != nil || len(key) != 32 {
		t.Fatalf("gh_browser_key phải là 32 byte base64, được %q (%v)", raw, err)
	}
	// Quyền 0644 của gh_browser_key: kiểm ở secrets_unix_test.go (bit quyền POSIX).
	// Lần hai: giữ nguyên.
	if err := ensureAuxSecrets(composePath); err != nil {
		t.Fatal(err)
	}
	again, _ := os.ReadFile(filepath.Join(secrets, "gh_browser_key"))
	if string(again) != string(raw) {
		t.Fatal("gh_browser_key phải giữ nguyên giữa hai lần gọi")
	}
}

// v0.1.40 (F-12): gh_offsite_key = "Khoá khôi phục" — 6 nhóm × 5 ký tự base32 HOA
// nối '-', không xuống dòng, quyền 0644; không bao giờ ghi đè khoá đã có.
func TestEnsureAuxSecrets_OffsiteKeyFormat(t *testing.T) {
	root := t.TempDir()
	secrets := filepath.Join(root, "secrets")
	if err := os.MkdirAll(filepath.Join(root, "deploy"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(secrets, 0o700); err != nil {
		t.Fatal(err)
	}
	composePath := filepath.Join(root, "deploy", "compose.yaml")
	if err := ensureAuxSecrets(composePath); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(secrets, "gh_offsite_key"))
	if err != nil {
		t.Fatalf("thiếu gh_offsite_key: %v", err)
	}
	if !offsiteKeyRe.Match(raw) {
		t.Fatalf("gh_offsite_key sai định dạng 6×5 base32 có '-' (không xuống dòng): %q", raw)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(filepath.Join(secrets, "gh_offsite_key"))
		if st.Mode().Perm() != 0o644 {
			t.Fatalf("quyền gh_offsite_key = %v, muốn 0644", st.Mode().Perm())
		}
	}
	// Không ghi đè.
	if err := os.WriteFile(filepath.Join(secrets, "gh_offsite_key"), []byte("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureAuxSecrets(composePath); err != nil {
		t.Fatal(err)
	}
	if again, _ := os.ReadFile(filepath.Join(secrets, "gh_offsite_key")); string(again) != "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF" {
		t.Fatalf("gh_offsite_key bị ghi đè: %q", again)
	}
	// Các khoá cũ vẫn là 32 byte base64.
	b, _ := os.ReadFile(filepath.Join(secrets, "gh_bridge_key"))
	if k, err := base64.StdEncoding.DecodeString(string(b)); err != nil || len(k) != 32 {
		t.Fatalf("gh_bridge_key phải giữ định dạng base64 32 byte: %q", b)
	}
}

var offsiteKeyRe = regexp.MustCompile(`^[A-Z2-7]{5}(-[A-Z2-7]{5}){5}$`)

func TestGenerateOffsiteKey_NgauNhienDungDinhDang(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 50; i++ {
		k, err := GenerateOffsiteKey()
		if err != nil || !offsiteKeyRe.MatchString(k) || len(k) < minBundlePasswordLen {
			t.Fatalf("GenerateOffsiteKey = %q, %v", k, err)
		}
		if seen[k] {
			t.Fatal("khoá trùng — bộ sinh không ngẫu nhiên")
		}
		seen[k] = true
	}
	if id := offsiteKeyID("AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF"); len(id) != 8 || strings.ToLower(id) != id {
		t.Fatalf("key_id phải 8 ký tự hex thường: %q", id)
	}
}

// LocatePath (mọi lệnh vận hành, kể cả `genh update` trước khi `up`) tự bổ sung khoá thiếu.
func TestLocatePath_EnsuresBrowserKey(t *testing.T) {
	root := t.TempDir()
	composePath := filepath.Join(root, "deploy", "compose.yaml")
	if err := os.MkdirAll(filepath.Join(root, "secrets"), 0o700); err != nil {
		t.Fatal(err)
	}
	env := &Env{InstallDir: root, locate: func(string) (string, error) { return composePath, nil }}
	if _, err := env.LocatePath(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "secrets", "gh_browser_key")); err != nil {
		t.Fatalf("LocatePath phải sinh gh_browser_key: %v", err)
	}
}
