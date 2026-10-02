//go:build !windows

package hostlink

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// assertNoSecretInRun: không tệp nào trong run/ chứa chuỗi bí mật.
func assertNoSecretInRun(t *testing.T, root, name string) {
	t.Helper()
	entries, _ := os.ReadDir(Dir(root))
	for _, e := range entries {
		if b, err := os.ReadFile(filepath.Join(Dir(root), e.Name())); err == nil && strings.Contains(string(b), "BI-MAT") {
			t.Fatalf("%s: bí mật lọt vào run/%s", name, e.Name())
		}
	}
}

// Review v0.1.34: update-status.json bị cài symlink/hard link tới tệp bí mật
// (container api ghi được run/): SnapshotStatus không được đọc theo, và
// RestoreStatusSnapshot không được chép bí mật vào run/.
func TestSnapshotStatus_RefusesSymlinkHardlinkAndHuge(t *testing.T) {
	root := t.TempDir()
	if err := EnsureDir(root); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(secret, []byte(`{"state":"failed","message":"BI-MAT-auths-token"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	status := filepath.Join(Dir(root), StatusFile)

	// symlink
	if err := os.Symlink(secret, status); err != nil {
		t.Fatal(err)
	}
	raw, ok := SnapshotStatus(root)
	if ok {
		t.Fatalf("symlink: không được chụp, được %q", raw)
	}
	if _, err := ReadStatus(root); err == nil {
		t.Fatal("symlink: ReadStatus phải từ chối")
	}
	_ = Start(root, "v0.1.34") // rename thay symlink bằng tệp thường
	if err := RestoreStatusSnapshot(root, raw, ok); err != nil {
		t.Fatal(err)
	}
	assertNoSecretInRun(t, root, "symlink")

	// hard link (cùng hệ tệp — có thể bị fs.protected_hardlinks chặn với tệp người khác)
	_ = os.Remove(status)
	if err := os.Link(secret, status); err == nil {
		if raw, ok := SnapshotStatus(root); ok {
			t.Fatalf("hard link: không được chụp, được %q", raw)
		}
		_ = Start(root, "v0.1.34")
		_ = RestoreStatusSnapshot(root, nil, false)
		assertNoSecretInRun(t, root, "hard link")
	}

	// /dev/zero (đọc không bao giờ hết) — phải từ chối ngay.
	_ = os.Remove(status)
	if err := os.Symlink("/dev/zero", status); err != nil {
		t.Fatal(err)
	}
	if _, ok := SnapshotStatus(root); ok {
		t.Fatal("/dev/zero: không được chụp")
	}

	// Tệp thường quá lớn.
	_ = os.Remove(status)
	big := `{"state":"failed","message":"` + strings.Repeat("x", maxStateFileBytes) + `"}`
	if err := os.WriteFile(status, []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := SnapshotStatus(root); ok {
		t.Fatal("tệp quá lớn: không được chụp")
	}

	// Tệp thường nhưng không phải JSON.
	if err := os.WriteFile(status, []byte("không phải json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, ok := SnapshotStatus(root); ok {
		t.Fatal("không phải JSON: không được chụp")
	}
}

// update-blocked.json là symlink (ai ghi được run/ cài để chặn lịch đêm, kể cả
// bản vá bảo mật) → không tin.
func TestReadUpdateBlocked_RefusesSymlink(t *testing.T) {
	root := t.TempDir()
	if err := EnsureDir(root); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "b.json")
	if err := os.WriteFile(target, []byte(`{"version":"v0.1.35"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(Dir(root), UpdateBlockedFile)); err != nil {
		t.Fatal(err)
	}
	if b, ok, err := ReadUpdateBlocked(root); ok || err == nil {
		t.Fatalf("symlink: phải từ chối, được %+v ok=%v err=%v", b, ok, err)
	}
}
