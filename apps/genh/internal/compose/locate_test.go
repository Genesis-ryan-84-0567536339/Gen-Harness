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
	if _, err := Locate(filepath.Join(dir, "khong-ton-tai")); err == nil {
		t.Fatal("muốn lỗi khi không tìm thấy compose.yaml ở đâu cả")
	}
}
