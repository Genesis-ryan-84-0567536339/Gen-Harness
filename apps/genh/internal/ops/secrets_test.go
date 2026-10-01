package ops

import (
	"encoding/base64"
	"os"
	"path/filepath"
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
