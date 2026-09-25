// Package dockercli bọc việc gọi `docker`/`docker compose` bằng dòng lệnh
// thành một interface nhỏ (Runner) có thể tiêm giả lập khi test — không có
// Step nào trong internal/runtime, internal/pull, internal/compose,
// internal/migrate gọi thẳng os/exec, tất cả đi qua Runner để test được mà
// không cần Docker daemon thật (sandbox CI không có).
//
// genh KHÔNG dùng thư viện Docker Engine API chính thức (github.com/docker/
// docker/client): gọi CLI đơn giản hơn, không kéo theo cây phụ thuộc nặng, và
// khi stdout không phải TTY (luôn đúng khi genh tự chạy subprocess), chính
// docker CLI in tiến độ dạng NDJSON — một dòng một JSON — thay vì vẽ thanh
// tiến độ, nên vẫn phân tích được tiến độ thật theo byte mà không cần API.
package dockercli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// Cmd mô tả một lệnh docker/docker compose cần chạy.
type Cmd struct {
	Name string   // thường là "docker"
	Args []string // ví dụ {"compose", "-f", path, "up", "-d", "db"}
	// Env là các biến môi trường THÊM vào (không thay hẳn os.Environ()) —
	// dùng để truyền mật khẩu DB/MinIO sinh ở Bước 4 cho `docker compose`
	// đọc qua ${POSTGRES_PASSWORD:?...} mà không phải ghi ra tệp .env.
	Env []string
	// Dir là thư mục làm việc của lệnh (thường là thư mục chứa compose.yaml,
	// để các đường dẫn tương đối trong compose.yaml — ví dụ context: ..  —
	// giải quyết đúng).
	Dir string
}

// ErrNotFound báo lệnh (thường là "docker") không có trên PATH — dùng để
// Bước 2 phân biệt "chưa có Docker, cần tự cài" với lỗi thật sự khác.
var ErrNotFound = exec.ErrNotFound

// Runner thực thi một Cmd. Cài đặt thật (ExecRunner) gọi os/exec; test tiêm
// một FakeRunner phát ra output định sẵn, không đụng Docker thật.
type Runner interface {
	// Output chạy lệnh, chờ xong, trả về toàn bộ stdout (đã trim). stderr
	// được gộp vào lỗi trả về nếu lệnh thất bại, để thông báo lỗi có ngữ
	// cảnh mà không cần gọi lại lệnh.
	Output(ctx context.Context, cmd Cmd) ([]byte, error)

	// Stream chạy lệnh và gọi onLine cho mỗi dòng xuất hiện trên stdout HOẶC
	// stderr (một số lệnh docker in NDJSON tiến độ ra stdout, log ra stderr
	// — Stream gộp cả hai theo thứ tự xuất hiện tốt nhất có thể để không bỏ
	// sót dòng nào). Trả lỗi nếu lệnh thoát khác 0 (sau khi đã gọi hết
	// onLine cho các dòng đã in được).
	Stream(ctx context.Context, cmd Cmd, onLine func(line string)) error
}

// ExecRunner là Runner thật, gọi os/exec — dùng trong genh khi chạy thật.
type ExecRunner struct{}

func (ExecRunner) buildCmd(ctx context.Context, cmd Cmd) *exec.Cmd {
	c := exec.CommandContext(ctx, cmd.Name, cmd.Args...)
	c.Dir = cmd.Dir
	if len(cmd.Env) > 0 {
		c.Env = append(os.Environ(), cmd.Env...)
	}
	return c
}

func (r ExecRunner) Output(ctx context.Context, cmd Cmd) ([]byte, error) {
	c := r.buildCmd(ctx, cmd)
	out, err := c.Output()
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			return out, fmt.Errorf("%s %v: %w — %s", cmd.Name, cmd.Args, err, trimTail(exitErr.Stderr, 2000))
		}
		return out, fmt.Errorf("%s %v: %w", cmd.Name, cmd.Args, err)
	}
	return out, nil
}

func (r ExecRunner) Stream(ctx context.Context, cmd Cmd, onLine func(line string)) error {
	c := r.buildCmd(ctx, cmd)

	stdout, err := c.StdoutPipe()
	if err != nil {
		return fmt.Errorf("%s %v: mở stdout: %w", cmd.Name, cmd.Args, err)
	}
	stderr, err := c.StderrPipe()
	if err != nil {
		return fmt.Errorf("%s %v: mở stderr: %w", cmd.Name, cmd.Args, err)
	}

	if err := c.Start(); err != nil {
		return fmt.Errorf("%s %v: khởi chạy: %w", cmd.Name, cmd.Args, err)
	}

	var wg sync.WaitGroup
	var mu sync.Mutex // onLine không đảm bảo an toàn đa luồng từ phía gọi
	var lastErrLines []string

	pump := func(r io.Reader, captureAsError bool) {
		defer wg.Done()
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			line := scanner.Text()
			mu.Lock()
			onLine(line)
			if captureAsError {
				lastErrLines = append(lastErrLines, line)
				if len(lastErrLines) > 40 {
					lastErrLines = lastErrLines[len(lastErrLines)-40:]
				}
			}
			mu.Unlock()
		}
	}

	wg.Add(2)
	go pump(stdout, false)
	go pump(stderr, true)
	wg.Wait()

	if err := c.Wait(); err != nil {
		mu.Lock()
		tail := joinTail(lastErrLines, 2000)
		mu.Unlock()
		return fmt.Errorf("%s %v: %w — %s", cmd.Name, cmd.Args, err, tail)
	}
	return nil
}

func trimTail(b []byte, max int) string {
	s := string(b)
	if len(s) > max {
		s = "…" + s[len(s)-max:]
	}
	return s
}

func joinTail(lines []string, max int) string {
	s := ""
	for i, l := range lines {
		if i > 0 {
			s += "\n"
		}
		s += l
	}
	return trimTail([]byte(s), max)
}
