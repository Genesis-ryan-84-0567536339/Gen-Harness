package compose

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

const sampleCompose = `
name: gen-harness

x-app-env: &app-env
  GH_ENV: production

services:
  proxy:
    image: caddy:2-alpine
    environment: *app-env

  redis:
    image: redis:7-alpine

  api:
    build: { context: .., dockerfile: deploy/images/api.Dockerfile }
    environment: *app-env

  db:
    build: { context: .., dockerfile: deploy/images/db.Dockerfile }
`

func TestParse_ReadsImageAndBuildServices(t *testing.T) {
	f, err := Parse([]byte(sampleCompose))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if len(f.Services) != 4 {
		t.Fatalf("số service = %d, muốn 4", len(f.Services))
	}

	proxy := f.Services["proxy"]
	if proxy.Image != "caddy:2-alpine" {
		t.Errorf("proxy.Image = %q, muốn caddy:2-alpine", proxy.Image)
	}
	if proxy.Build {
		t.Error("proxy.Build phải false (dùng image: có sẵn)")
	}

	api := f.Services["api"]
	if api.Image != "" {
		t.Errorf("api.Image = %q, muốn rỗng (chỉ có build:)", api.Image)
	}
	if !api.Build {
		t.Error("api.Build phải true")
	}
}

func TestParse_ResolvesYAMLAnchors(t *testing.T) {
	// Nếu anchor/alias (*app-env) không được parser giải quyết, Unmarshal sẽ
	// lỗi hoặc bỏ qua service đó — Parse phải không lỗi và service vẫn xuất
	// hiện đầy đủ.
	f, err := Parse([]byte(sampleCompose))
	if err != nil {
		t.Fatalf("Parse với anchor/alias: %v", err)
	}
	if _, ok := f.Services["api"]; !ok {
		t.Error("service dùng alias *app-env phải parse được bình thường")
	}
}

func TestParse_InvalidYAML(t *testing.T) {
	_, err := Parse([]byte("services: [not-a-map"))
	if err == nil {
		t.Fatal("muốn lỗi với YAML hỏng")
	}
}

func TestLoad_ReadsFileFromDisk(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(path, []byte(sampleCompose), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	f, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if f.Path != path {
		t.Errorf("Path = %q, muốn %q", f.Path, path)
	}
	if len(f.Services) != 4 {
		t.Errorf("số service = %d, muốn 4", len(f.Services))
	}
}

func TestBaseArgs(t *testing.T) {
	got := BaseArgs("/tmp/compose.yaml", "up", "-d", "db")
	want := []string{"compose", "-f", "/tmp/compose.yaml", "up", "-d", "db"}
	if len(got) != len(want) {
		t.Fatalf("BaseArgs = %v, muốn %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("BaseArgs[%d] = %q, muốn %q", i, got[i], want[i])
		}
	}
}

// F-37: mọi dịch vụ phải giới hạn log (json-file, 3 tệp × 10 MB) — log không
// giới hạn làm đầy đĩa máy Owner. Đọc YAML thô (không qua Parse) để thấy
// khoá logging sau khi anchor *logging đã được giải.
func repoComposePath() string {
	return filepath.Join("..", "..", "..", "..", "deploy", "compose.yaml")
}

func readRepoCompose(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(repoComposePath())
	if err != nil {
		t.Fatalf("đọc deploy/compose.yaml: %v", err)
	}
	return data
}

func composeServices(t *testing.T, data []byte) map[string]any {
	t.Helper()
	var doc map[string]any
	if err := yaml.Unmarshal(data, &doc); err != nil {
		t.Fatalf("yaml.Unmarshal: %v", err)
	}
	services, ok := doc["services"].(map[string]any)
	if !ok || len(services) == 0 {
		t.Fatal("compose không có khối services")
	}
	return services
}

func assertEveryServiceHasLogLimits(t *testing.T, label string, data []byte) {
	t.Helper()
	for name, raw := range composeServices(t, data) {
		svc, _ := raw.(map[string]any)
		logging, ok := svc["logging"].(map[string]any)
		if !ok {
			t.Errorf("%s: service %q thiếu logging: *logging (F-37)", label, name)
			continue
		}
		if got := logging["driver"]; got != "json-file" {
			t.Errorf("%s: service %q logging.driver = %v, muốn json-file", label, name, got)
		}
		opts, _ := logging["options"].(map[string]any)
		if got := opts["max-size"]; got != "10m" {
			t.Errorf("%s: service %q logging.options.max-size = %v, muốn \"10m\"", label, name, got)
		}
		if got := opts["max-file"]; got != "3" {
			t.Errorf("%s: service %q logging.options.max-file = %v, muốn \"3\"", label, name, got)
		}
	}
}

func TestDeployCompose_EveryServiceHasLogLimits(t *testing.T) {
	assertEveryServiceHasLogLimits(t, "deploy/compose.yaml", readRepoCompose(t))
}

func TestEmbeddedCompose_EveryServiceHasLogLimits(t *testing.T) {
	assertEveryServiceHasLogLimits(t, "embedded_compose.yaml", embeddedComposeYAML)
}

func TestEmbeddedComposeMatchesRepo(t *testing.T) {
	if !bytes.Equal(readRepoCompose(t), embeddedComposeYAML) {
		t.Fatal("apps/genh/internal/compose/embedded_compose.yaml lệch deploy/compose.yaml — chép lại cho khớp")
	}
}

func TestDeployCompose_WebHealthcheckUsesHealthz(t *testing.T) {
	web, ok := composeServices(t, readRepoCompose(t))["web"].(map[string]any)
	if !ok {
		t.Fatal("deploy/compose.yaml thiếu service web")
	}
	hc, _ := web["healthcheck"].(map[string]any)
	test, _ := hc["test"].([]any)
	for _, part := range test {
		if s, ok := part.(string); ok && strings.Contains(s, "/healthz") {
			return
		}
	}
	t.Fatalf("healthcheck.test của web = %v, phải gọi /healthz", hc["test"])
}
