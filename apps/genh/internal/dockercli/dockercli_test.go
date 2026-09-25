package dockercli

import (
	"context"
	"runtime"
	"strings"
	"testing"
)

func shellCmd(script string) Cmd {
	if runtime.GOOS == "windows" {
		return Cmd{Name: "cmd", Args: []string{"/C", script}}
	}
	return Cmd{Name: "sh", Args: []string{"-c", script}}
}

func TestExecRunner_Output(t *testing.T) {
	r := ExecRunner{}
	out, err := r.Output(context.Background(), shellCmd("echo hello"))
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	if strings.TrimSpace(string(out)) != "hello" {
		t.Errorf("Output = %q, muốn %q", out, "hello")
	}
}

func TestExecRunner_Output_NonZeroExit_IncludesStderr(t *testing.T) {
	r := ExecRunner{}
	_, err := r.Output(context.Background(), shellCmd("echo boom 1>&2; exit 3"))
	if err == nil {
		t.Fatal("muốn lỗi khi lệnh thoát khác 0")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("lỗi phải kèm stderr, được: %v", err)
	}
}

func TestExecRunner_Stream_ReceivesAllLines(t *testing.T) {
	r := ExecRunner{}
	var lines []string
	err := r.Stream(context.Background(), shellCmd("printf 'a\\nb\\nc\\n'"), func(l string) {
		lines = append(lines, l)
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if len(lines) != 3 || lines[0] != "a" || lines[1] != "b" || lines[2] != "c" {
		t.Errorf("lines = %v, muốn [a b c]", lines)
	}
}

func TestExecRunner_Stream_NonZeroExit_ReturnsError(t *testing.T) {
	r := ExecRunner{}
	err := r.Stream(context.Background(), shellCmd("echo x; exit 1"), func(string) {})
	if err == nil {
		t.Fatal("muốn lỗi khi lệnh thoát khác 0")
	}
}

func TestExecRunner_Env_IsPassedThrough(t *testing.T) {
	r := ExecRunner{}
	out, err := r.Output(context.Background(), Cmd{
		Name: shellCmd("").Name,
		Args: func() []string {
			if runtime.GOOS == "windows" {
				return []string{"/C", "echo %GENH_TEST_VAR%"}
			}
			return []string{"-c", "echo $GENH_TEST_VAR"}
		}(),
		Env: []string{"GENH_TEST_VAR=xin-chao"},
	})
	if err != nil {
		t.Fatalf("Output: %v", err)
	}
	if strings.TrimSpace(string(out)) != "xin-chao" {
		t.Errorf("Output = %q, muốn env truyền qua đúng", out)
	}
}
