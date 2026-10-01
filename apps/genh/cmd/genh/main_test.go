package main

import (
	"strings"
	"testing"
	"time"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/autoupdate"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/selfupdate"
)

func TestSelfUpdateMinAge(t *testing.T) {
	if selfupdate.NightlyMinAge != 24*time.Hour {
		t.Fatalf("thời gian chín của lịch đêm phải là 24 giờ, được %v", selfupdate.NightlyMinAge)
	}
	cases := []struct {
		name             string
		yes, ifRequested bool
		want             time.Duration
	}{
		{"lịch đêm: --yes, không --if-requested", true, false, 24 * time.Hour},
		{"Cập nhật ngay: --yes --if-requested", true, true, 0},
		{"gõ tay genh update (không --yes)", false, false, 0},
		{"--if-requested không --yes", false, true, 0},
	}
	for _, c := range cases {
		if got := selfUpdateMinAge(c.yes, c.ifRequested); got != c.want {
			t.Errorf("%s: selfUpdateMinAge(%v, %v) = %v, muốn %v", c.name, c.yes, c.ifRequested, got, c.want)
		}
	}
}

// Đi trọn đường nút "Cập nhật ngay": cờ runHandleRequests chuyển sang (kèm
// --port/--install-dir như thật) → parse bằng đúng bộ cờ của `genh update` →
// ifRequested = true → thời gian chín = 0 (không bị chặn).
func TestHandleRequestUpdateArgs_CapNhatNgayKhongBiChan(t *testing.T) {
	for _, quiet := range []bool{true, false} {
		args := append(handleRequestUpdateArgs(quiet), "--port", "8443", "--install-dir", t.TempDir())
		f, err := parseUpdateFlags(args)
		if err != nil {
			t.Fatalf("quiet=%v: parse %q bằng cờ của genh update lỗi: %v", quiet, args, err)
		}
		if !f.yes || !f.ifRequested || f.quiet != quiet {
			t.Fatalf("quiet=%v: muốn yes=true ifRequested=true quiet=%v — được %+v", quiet, quiet, f)
		}
		if got := selfUpdateMinAge(f.yes, f.ifRequested); got != 0 {
			t.Fatalf("quiet=%v: nút \"Cập nhật ngay\" không được bị thời gian chín chặn, MinAge = %v", quiet, got)
		}
	}
}

// Đi trọn đường lịch đêm: lấy đúng các cờ timer truyền cho `genh update`
// (dòng crontab do internal/autoupdate sinh) → parse → thời gian chín 24 giờ.
func TestLichDem_ApThoiGianChin24h(t *testing.T) {
	line := autoupdate.CrontabLine("/opt/genh/bin/genh", "/tmp/auto-update.log", 7)
	fields := strings.Fields(line)
	var args []string
	inUpdate := false
	for _, f := range fields {
		if f == ">>" {
			break
		}
		if inUpdate {
			args = append(args, f)
		}
		if f == "update" {
			inUpdate = true
		}
	}
	if !inUpdate {
		t.Fatalf("dòng crontab không gọi `genh update`: %q", line)
	}
	f, err := parseUpdateFlags(args)
	if err != nil {
		t.Fatalf("parse cờ lịch đêm %q lỗi: %v", args, err)
	}
	if got := selfUpdateMinAge(f.yes, f.ifRequested); got != selfupdate.NightlyMinAge {
		t.Fatalf("lịch đêm (%q) phải áp thời gian chín %v, được %v", args, selfupdate.NightlyMinAge, got)
	}
}

// Bản genh mới bị thời gian chín hoãn: dòng kết của `--quiet` (vào
// logs/auto-update.log) KHÔNG được nói "cập nhật xong." — người đọc log sẽ
// tưởng bản mới đã cài.
func TestUpdateDoneLine_HoanThiKhongNoiCapNhatXong(t *testing.T) {
	if got := updateDoneLine(false); got != "genh: cập nhật xong." {
		t.Fatalf("không hoãn: muốn %q, được %q", "genh: cập nhật xong.", got)
	}
	got := updateDoneLine(true)
	if strings.Contains(got, "cập nhật xong") {
		t.Fatalf("bị hoãn mà dòng kết vẫn nói cập nhật xong: %q", got)
	}
	for _, want := range []string{"dịch vụ đã kiểm/khởi động lại xong", "đang đợi đủ 24 giờ"} {
		if !strings.Contains(got, want) {
			t.Errorf("dòng kết khi hoãn thiếu %q: %q", want, got)
		}
	}
}
