package compose

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSearchCandidates_IncludesEnvOverrideFirst(t *testing.T) {
	t.Setenv(EnvOverrideVar, "/duong/dan/tuy-chon/compose.yaml")
	got := SearchCandidates("/install", "/cwd", "/exe")
	if len(got) == 0 || got[0] != "/duong/dan/tuy-chon/compose.yaml" {
		t.Errorf("candidate đầu tiên phải là GENH_COMPOSE_FILE, được %v", got)
	}
}

func TestSearchCandidates_IncludesInstallDirAndAscendingParents(t *testing.T) {
	t.Setenv(EnvOverrideVar, "")
	got := SearchCandidates("/install", "/a/b/c", "")

	wantInstall := filepath.Join("/install", "deploy", "compose.yaml")
	found := false
	for _, c := range got {
		if c == wantInstall {
			found = true
		}
	}
	if !found {
		t.Errorf("thiếu candidate dưới installDir: %v", got)
	}

	wantAscend := filepath.Join("/a", "deploy", "compose.yaml")
	found = false
	for _, c := range got {
		if c == wantAscend {
			found = true
		}
	}
	if !found {
		t.Errorf("thiếu candidate dò lên thư mục cha /a: %v", got)
	}
}

func TestLocate_FindsFileAmongAscendingParents(t *testing.T) {
	t.Setenv(EnvOverrideVar, "")

	root := t.TempDir()
	deployDir := filepath.Join(root, "deploy")
	if err := os.MkdirAll(deployDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	composePath := filepath.Join(deployDir, "compose.yaml")
	if err := os.WriteFile(composePath, []byte(sampleCompose), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	deepCwd := filepath.Join(root, "apps", "genh", "cmd", "genh")
	if err := os.MkdirAll(deepCwd, 0o755); err != nil {
		t.Fatalf("MkdirAll deepCwd: %v", err)
	}

	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	if err := os.Chdir(deepCwd); err != nil {
		t.Fatalf("Chdir: %v", err)
	}

	got, err := Locate("")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	if got != composePath {
		t.Errorf("Locate = %q, muốn %q", got, composePath)
	}
}

func TestLocate_EnvOverrideWins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "custom-compose.yaml")
	if err := os.WriteFile(path, []byte(sampleCompose), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	t.Setenv(EnvOverrideVar, path)

	got, err := Locate("")
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	if got != path {
		t.Errorf("Locate = %q, muốn %q (từ %s)", got, path, EnvOverrideVar)
	}
}

func TestLocate_NotFound(t *testing.T) {
	t.Setenv(EnvOverrideVar, "")
	dir := t.TempDir()
	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}
	// installDir RỖNG: không có nơi nào để rơi về ghi bản nhúng sẵn — vẫn
	// phải lỗi rõ ràng như trước.
	if _, err := Locate(""); err == nil {
		t.Fatal("muốn lỗi khi không tìm thấy compose.yaml ở đâu cả và installDir rỗng")
	}
}

func TestLocate_FallsBackToEmbeddedComposeUnderInstallDir(t *testing.T) {
	t.Setenv(EnvOverrideVar, "")
	cwdDir := t.TempDir() // KHÔNG chứa deploy/compose.yaml nào, tách biệt installDir
	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	if err := os.Chdir(cwdDir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}

	installDir := t.TempDir()
	want := filepath.Join(installDir, "deploy", "compose.yaml")

	got, err := Locate(installDir)
	if err != nil {
		t.Fatalf("Locate: %v (muốn rơi về ghi bản nhúng sẵn dưới installDir)", err)
	}
	if got != want {
		t.Errorf("Locate = %q, muốn %q", got, want)
	}

	data, err := os.ReadFile(want)
	if err != nil {
		t.Fatalf("đọc lại tệp vừa ghi: %v", err)
	}
	if len(data) == 0 {
		t.Error("compose.yaml nhúng sẵn ghi ra rỗng")
	}

	// Gọi lại lần hai: idempotent, không lỗi, không đổi nội dung, và không
	// đè lên một compose.yaml Owner đã tự sửa.
	custom := []byte("# tuỳ chỉnh của Owner\nservices: {}\n")
	if err := os.WriteFile(want, custom, 0o644); err != nil {
		t.Fatalf("ghi đè tuỳ chỉnh: %v", err)
	}
	got2, err := Locate(installDir)
	if err != nil {
		t.Fatalf("Locate lần 2: %v", err)
	}
	if got2 != want {
		t.Errorf("Locate lần 2 = %q, muốn %q", got2, want)
	}
	data2, _ := os.ReadFile(want)
	if string(data2) != string(custom) {
		t.Error("Locate lần 2 đã đè lên compose.yaml Owner tự tuỳ chỉnh — phải giữ nguyên")
	}
}
