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
	for _, got := range []string{updateDoneLine(true), deferredAfterRunLine} {
		if strings.Contains(got, "genh: cập nhật xong.") || strings.Contains(got, "cập nhật xong") {
			t.Fatalf("bị hoãn mà dòng kết vẫn nói cập nhật xong: %q", got)
		}
		if !strings.Contains(got, "đợi đủ 24 giờ") {
			t.Errorf("dòng kết khi hoãn thiếu %q: %q", "đợi đủ 24 giờ", got)
		}
	}
	if !strings.Contains(updateDoneLine(true), "không có gì để cập nhật") {
		t.Errorf("hoãn + dịch vụ đã khớp: phải nói không có gì để cập nhật: %q", updateDoneLine(true))
	}
}

func TestDecideServiceUpdate(t *testing.T) {
	const v = "v0.1.34"
	cases := []struct {
		name     string
		in       serviceUpdateInput
		wantSkip bool
		wantKind string
	}{
		{"(a) lịch đêm + bản bị chặn đúng bản này → blocked",
			serviceUpdateInput{Scheduled: true, Version: v, BlockedVersion: v}, true, "blocked"},
		{"(b) lịch đêm + bị chặn bản KHÁC + chưa khớp → chạy (bản mới hơn vẫn nhận)",
			serviceUpdateInput{Scheduled: true, Version: v, BlockedVersion: "v0.1.33"}, false, ""},
		{"(c) gõ tay/\"Cập nhật ngay\" + bị chặn đúng bản này → chạy",
			serviceUpdateInput{Scheduled: false, Version: v, BlockedVersion: v}, false, ""},
		{"(d) đã khớp + không vừa tự cập nhật → up-to-date",
			serviceUpdateInput{Version: v, InSync: true}, true, "up-to-date"},
		{"(e) vừa tự cập nhật + đã khớp → chạy",
			serviceUpdateInput{Version: v, InSync: true, SelfUpdated: true}, false, ""},
		{"(f) bị chặn bản khác + đã khớp → up-to-date",
			serviceUpdateInput{Scheduled: true, Version: v, InSync: true, BlockedVersion: "v0.1.33"}, true, "up-to-date"},
		{"lịch đêm + bị chặn đúng bản + đã khớp → blocked (ưu tiên)",
			serviceUpdateInput{Scheduled: true, Version: v, InSync: true, BlockedVersion: v}, true, "blocked"},
		{"so khớp CHÍNH XÁC version (v0.1.3 ≠ v0.1.34)",
			serviceUpdateInput{Scheduled: true, Version: v, BlockedVersion: "v0.1.3"}, false, ""},
	}
	for _, c := range cases {
		skip, kind := decideServiceUpdate(c.in)
		if skip != c.wantSkip || kind != c.wantKind {
			t.Errorf("%s: được (%v,%q), muốn (%v,%q)", c.name, skip, kind, c.wantSkip, c.wantKind)
		}
	}
}

func TestServiceUpdateLines_E2EContract(t *testing.T) {
	if !strings.Contains(blockedLine("v0.1.34"), "lịch đêm không tự thử lại") {
		t.Errorf("dòng bản bị chặn phải chứa \"lịch đêm không tự thử lại\": %q", blockedLine("v0.1.34"))
	}
	if !strings.Contains(upToDateLine("v0.1.34"), "không cần cập nhật") {
		t.Errorf("dòng đã mới nhất phải chứa \"không cần cập nhật\": %q", upToDateLine("v0.1.34"))
	}
	for _, l := range []string{blockedLine("v0.1.34"), upToDateLine("v0.1.34")} {
		if strings.Contains(l, "genh: cập nhật xong.") {
			t.Errorf("chỉ in \"genh: cập nhật xong.\" khi RunUpdate chạy xong: %q", l)
		}
	}
}
