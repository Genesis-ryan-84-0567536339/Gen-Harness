package autoupdate

import "testing"

func TestSystemdServiceUnit_ContainsGenhPathAndLogFile(t *testing.T) {
	unit := SystemdServiceUnit("/home/o/.gen-harness/bin/genh", "/home/o/.gen-harness/logs/auto-update.log")
	mustContain(t, unit, "/home/o/.gen-harness/bin/genh update --yes --quiet")
	mustContain(t, unit, "StandardOutput=append:/home/o/.gen-harness/logs/auto-update.log")
	mustContain(t, unit, "Type=oneshot")
}

func TestSystemdServiceUnit_QuotesPathWithSpaces(t *testing.T) {
	unit := SystemdServiceUnit("/home/o dir/genh", "/tmp/log")
	mustContain(t, unit, `"/home/o dir/genh" update --yes --quiet`)
}

func TestSystemdTimerUnit_DailyAt3AMPersistent(t *testing.T) {
	timer := SystemdTimerUnit()
	mustContain(t, timer, "OnCalendar=*-*-* 03:00:00")
	mustContain(t, timer, "Persistent=true")
	mustContain(t, timer, "RandomizedDelaySec=1800")
}

func TestCrontabLine_DailyAt3(t *testing.T) {
	line := CrontabLine("/home/o/.gen-harness/bin/genh", "/tmp/log", 7)
	want := "7 3 * * * /home/o/.gen-harness/bin/genh update --yes --quiet >> /tmp/log 2>&1"
	if line != want {
		t.Fatalf("CrontabLine = %q, muốn %q", line, want)
	}
}

func TestCrontabLine_MinuteWraps(t *testing.T) {
	line := CrontabLine("genh", "/tmp/log", 45) // 45 % 30 = 15
	if !contains(line, "15 3 * * *") {
		t.Fatalf("muốn phút lẻ hoá về 0-29, được %q", line)
	}
}

func TestMergeCrontab_AppendsWhenEmpty(t *testing.T) {
	got := MergeCrontab("", "0 3 * * * genh update --yes --quiet", false)
	want := CrontabMarker + "\n0 3 * * * genh update --yes --quiet\n"
	if got != want {
		t.Fatalf("MergeCrontab = %q, muốn %q", got, want)
	}
}

func TestMergeCrontab_KeepsOtherLines_ReplacesOwnLine(t *testing.T) {
	existing := "0 9 * * * some-other-job\n" + CrontabMarker + "\n0 3 * * * genh update --yes --quiet (cu)\n30 22 * * * backup-job\n"
	got := MergeCrontab(existing, "5 3 * * * genh update --yes --quiet (moi)", false)

	mustContain(t, got, "0 9 * * * some-other-job")
	mustContain(t, got, "30 22 * * * backup-job")
	mustContain(t, got, "5 3 * * * genh update --yes --quiet (moi)")
	if contains(got, "(cu)") {
		t.Fatalf("dòng cron CŨ của genh phải bị thay, còn thấy trong %q", got)
	}
	// Chỉ đúng MỘT marker (không nhân đôi).
	if countOccurrences(got, CrontabMarker) != 1 {
		t.Fatalf("muốn đúng 1 marker, được nội dung %q", got)
	}
}

func TestMergeCrontab_RemoveOnly_DropsGenhLineKeepsOthers(t *testing.T) {
	existing := "0 9 * * * some-other-job\n" + CrontabMarker + "\n0 3 * * * genh update --yes --quiet\n"
	got := MergeCrontab(existing, "", true)

	mustContain(t, got, "0 9 * * * some-other-job")
	if contains(got, "genh update") {
		t.Fatalf("removeOnly phải bỏ dòng genh, còn thấy trong %q", got)
	}
	if contains(got, CrontabMarker) {
		t.Fatalf("removeOnly phải bỏ marker, còn thấy trong %q", got)
	}
}

func TestMergeCrontab_RemoveOnly_EmptyResultWhenNothingElse(t *testing.T) {
	existing := CrontabMarker + "\n0 3 * * * genh update --yes --quiet\n"
	got := MergeCrontab(existing, "", true)
	if got != "" {
		t.Fatalf("muốn rỗng khi không còn dòng nào khác, được %q", got)
	}
}

func TestLaunchdPlist_ContainsScheduleAndArgs(t *testing.T) {
	plist := LaunchdPlist("/Users/o/.gen-harness/bin/genh", "/Users/o/.gen-harness/logs/auto-update.log", 12)
	mustContain(t, plist, "<string>/Users/o/.gen-harness/bin/genh</string>")
	mustContain(t, plist, "<string>update</string>")
	mustContain(t, plist, "<string>--yes</string>")
	mustContain(t, plist, "<string>--quiet</string>")
	mustContain(t, plist, "<integer>3</integer>")
	mustContain(t, plist, "<integer>12</integer>")
	mustContain(t, plist, "com.gen-harness.update")
}

func TestSchtasksCreateArgs_DailyAt3(t *testing.T) {
	args := SchtasksCreateArgs(`C:\Users\o\genh.exe`, `C:\Users\o\log.txt`)
	joined := ""
	for _, a := range args {
		joined += a + "|"
	}
	mustContain(t, joined, "/Create")
	mustContain(t, joined, "/SC|DAILY")
	mustContain(t, joined, "/ST|03:00")
	mustContain(t, joined, TaskName)
	mustContain(t, joined, "update --yes --quiet")
}

func TestSchtasksDeleteAndQueryArgs_UseTaskName(t *testing.T) {
	del := SchtasksDeleteArgs()
	if del[0] != "/Delete" || del[2] != TaskName {
		t.Fatalf("SchtasksDeleteArgs = %v", del)
	}
	q := SchtasksQueryArgs()
	if q[0] != "/Query" || q[2] != TaskName {
		t.Fatalf("SchtasksQueryArgs = %v", q)
	}
}

func TestParseMinuteFromClock(t *testing.T) {
	if m := parseMinuteFromClock("03:17:42"); m != 17 {
		t.Fatalf("parseMinuteFromClock = %d, muốn 17", m)
	}
	if m := parseMinuteFromClock("khong-hop-le"); m != 0 {
		t.Fatalf("parseMinuteFromClock chuỗi lỗi phải trả 0, được %d", m)
	}
}

// --- trợ giúp ---

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !contains(haystack, needle) {
		t.Fatalf("muốn thấy %q trong:\n%s", needle, haystack)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) == 0 || indexOf(haystack, needle) >= 0
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func countOccurrences(haystack, needle string) int {
	count := 0
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			count++
			i += len(needle) - 1
		}
	}
	return count
}
