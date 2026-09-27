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

	// Gọi lại lần hai NGAY, không đổi gì: idempotent, không lỗi, không đổi
	// nội dung, không sinh .bak (nội dung đã khớp bản nhúng).
	got2, err := Locate(installDir)
	if err != nil {
		t.Fatalf("Locate lần 2: %v", err)
	}
	if got2 != want {
		t.Errorf("Locate lần 2 = %q, muốn %q", got2, want)
	}
	data2, _ := os.ReadFile(want)
	if string(data2) != string(data) {
		t.Error("Locate lần 2 (không đổi bản nhúng) không được đổi nội dung tệp")
	}
	if _, err := os.Stat(want + ".bak"); err == nil {
		t.Error("Locate lần 2 (nội dung đã khớp) không được sinh .bak")
	}
}

// TestLocate_SyncsManagedComposeWhenEmbeddedContentDiffers là test cho SỬA
// LỖI chính của package này (xem docs/reports/HANDOFF-v0.1.1.md mục "Lỗi
// cần sửa" #5): một bản genh MỚI HƠN (mang bản nhúng khác — mô phỏng bằng
// cách tự ghi một nội dung "cũ" khác bản nhúng thật vào đúng vị trí genh
// quản lý) phải TỰ ĐỒNG BỘ lại compose.yaml ở installDir về đúng bản nhúng
// hiện tại của chính nó, giữ bản cũ lại ở compose.yaml.bak — KHÔNG được im
// lặng giữ mãi bản cũ như hành vi trước khi sửa.
func TestLocate_SyncsManagedComposeWhenEmbeddedContentDiffers(t *testing.T) {
	t.Setenv(EnvOverrideVar, "")
	cwdDir := t.TempDir()
	oldWd, _ := os.Getwd()
	defer os.Chdir(oldWd)
	if err := os.Chdir(cwdDir); err != nil {
		t.Fatalf("Chdir: %v", err)
	}

	installDir := t.TempDir()
	deployDir := filepath.Join(installDir, "deploy")
	if err := os.MkdirAll(deployDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	managedPath := filepath.Join(deployDir, "compose.yaml")

	oldContent := []byte("# compose.yaml cũ (hoặc Owner tự sửa)\nservices: {}\n")
	if err := os.WriteFile(managedPath, oldContent, 0o644); err != nil {
		t.Fatalf("WriteFile bản cũ: %v", err)
	}

	got, err := Locate(installDir)
	if err != nil {
		t.Fatalf("Locate: %v", err)
	}
	if got != managedPath {
		t.Errorf("Locate = %q, muốn %q", got, managedPath)
	}

	newContent, err := os.ReadFile(managedPath)
	if err != nil {
		t.Fatalf("đọc lại sau đồng bộ: %v", err)
	}
	if string(newContent) != string(embeddedComposeYAML) {
		t.Error("compose.yaml phải được đồng bộ về đúng bản nhúng của binary hiện tại")
	}

	bak, err := os.ReadFile(managedPath + ".bak")
	if err != nil {
		t.Fatalf("phải giữ bản cũ ở compose.yaml.bak: %v", err)
	}
	if string(bak) != string(oldContent) {
		t.Error("compose.yaml.bak phải đúng nội dung CŨ trước khi đồng bộ")
	}

	// Gọi lại lần ba: đã khớp bản nhúng, không đổi gì thêm, không ghi lại
	// .bak (giữ nguyên .bak của lần đồng bộ trước, không mất thông tin).
	if _, err := Locate(installDir); err != nil {
		t.Fatalf("Locate lần 3: %v", err)
	}
	bak2, _ := os.ReadFile(managedPath + ".bak")
	if string(bak2) != string(oldContent) {
		t.Error("Locate lần 3 (đã khớp bản nhúng) không được đổi .bak")
	}
}
