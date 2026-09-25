package secretgen

import (
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEnsure_FirstRunGeneratesEverything(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")

	res, err := Ensure(dir)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !res.GeneratedNew {
		t.Error("lần chạy đầu phải báo GeneratedNew=true")
	}

	b := res.Bundle
	for name, v := range map[string]string{
		"MasterKey":      b.MasterKey,
		"DBPassword":     b.DBPassword,
		"MinIOAccessKey": b.MinIOAccessKey,
		"MinIOSecretKey": b.MinIOSecretKey,
		"BackupKey":      b.BackupKey,
		"SetupToken":     b.SetupToken,
	} {
		if v == "" {
			t.Errorf("%s rỗng sau lần sinh đầu tiên", name)
		}
	}
	if b.CreatedAt.IsZero() {
		t.Error("CreatedAt chưa được gán")
	}

	if _, err := os.Stat(res.CACertPath); err != nil {
		t.Errorf("thiếu tệp CA cert: %v", err)
	}
	if _, err := os.Stat(res.CAKeyPath); err != nil {
		t.Errorf("thiếu tệp CA key: %v", err)
	}

	block, _ := pem.Decode(res.CACertPEM)
	if block == nil {
		t.Fatal("CACertPEM không giải mã được PEM")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("ParseCertificate: %v", err)
	}
	if !cert.IsCA {
		t.Error("chứng chỉ sinh ra không phải CA")
	}
	if cert.NotAfter.Before(cert.NotBefore) {
		t.Error("NotAfter phải sau NotBefore")
	}
}

func TestEnsure_IdempotentOnSecondRun(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")

	first, err := Ensure(dir)
	if err != nil {
		t.Fatalf("Ensure (1): %v", err)
	}

	second, err := Ensure(dir)
	if err != nil {
		t.Fatalf("Ensure (2): %v", err)
	}
	if second.GeneratedNew {
		t.Error("lần chạy thứ hai không được sinh lại bí mật (GeneratedNew phải là false)")
	}

	if first.Bundle != second.Bundle {
		t.Errorf("bí mật thay đổi giữa hai lần chạy:\n1: %+v\n2: %+v", first.Bundle, second.Bundle)
	}
	if string(first.CACertPEM) != string(second.CACertPEM) {
		t.Error("CA cert bị sinh lại ở lần chạy thứ hai")
	}
}

func TestEnsure_FillsOnlyMissingFields(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")

	first, err := Ensure(dir)
	if err != nil {
		t.Fatalf("Ensure (1): %v", err)
	}

	// Giả lập secrets.json cũ, thiếu trường backup_key (ví dụ nâng cấp từ
	// bản trước khi có tính năng sao lưu) — Ensure phải giữ nguyên các
	// trường đã có và chỉ sinh thêm trường thiếu.
	partial := first.Bundle
	partial.BackupKey = ""
	if err := saveBundle(dir, partial); err != nil {
		t.Fatalf("saveBundle: %v", err)
	}

	res, err := Ensure(dir)
	if err != nil {
		t.Fatalf("Ensure (2): %v", err)
	}
	if !res.GeneratedNew {
		t.Error("phải báo GeneratedNew=true vì backup_key vừa được điền")
	}
	if res.Bundle.BackupKey == "" {
		t.Error("backup_key vẫn rỗng sau khi Ensure điền lại")
	}
	if res.Bundle.MasterKey != first.Bundle.MasterKey {
		t.Error("master_key không được đổi khi chỉ backup_key bị thiếu")
	}
	if res.Bundle.SetupToken != first.Bundle.SetupToken {
		t.Error("setup_token không được đổi khi chỉ backup_key bị thiếu")
	}
}

func TestEnsure_FilePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bit quyền POSIX (0600/0700) không áp dụng trên Windows")
	}

	dir := filepath.Join(t.TempDir(), "config")
	res, err := Ensure(dir)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}

	dirInfo, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("stat dir: %v", err)
	}
	if perm := dirInfo.Mode().Perm(); perm != dirPerm {
		t.Errorf("quyền thư mục config = %o, muốn %o", perm, dirPerm)
	}

	for _, p := range []string{
		filepath.Join(dir, secretsFileName),
		res.CACertPath,
		res.CAKeyPath,
	} {
		info, err := os.Stat(p)
		if err != nil {
			t.Fatalf("stat %s: %v", p, err)
		}
		if perm := info.Mode().Perm(); perm != filePerm {
			t.Errorf("quyền %s = %o, muốn %o", p, perm, filePerm)
		}
	}
}

func TestRandomSetupCode_Format(t *testing.T) {
	code, err := randomSetupCode()
	if err != nil {
		t.Fatalf("randomSetupCode: %v", err)
	}
	// XXXX-XXXX-XXXX
	if len(code) != 14 {
		t.Fatalf("độ dài mã thiết lập = %d, muốn 14 (XXXX-XXXX-XXXX): %q", len(code), code)
	}
	for i, c := range code {
		if i == 4 || i == 9 {
			if c != '-' {
				t.Errorf("vị trí %d phải là '-', được %q trong %q", i, c, code)
			}
			continue
		}
		if !containsRune(setupCodeAlphabet, c) {
			t.Errorf("ký tự %q ngoài bảng chữ cái mã thiết lập trong %q", c, code)
		}
	}
}

func containsRune(s string, r rune) bool {
	for _, c := range s {
		if c == r {
			return true
		}
	}
	return false
}
