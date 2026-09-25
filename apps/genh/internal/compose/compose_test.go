package compose

import (
	"os"
	"path/filepath"
	"testing"
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
