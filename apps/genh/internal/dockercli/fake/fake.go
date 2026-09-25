// Package fake cung cấp một dockercli.Runner giả cho test của các gói phụ
// thuộc dockercli (internal/runtime, internal/pull, internal/compose,
// internal/migrate) — không gọi Docker thật.
package fake

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// Call ghi lại một lần Runner được gọi, để test kiểm tra đúng lệnh/tham số
// đã dùng (ví dụ compose có truyền đúng -f <path> hay không).
type Call struct {
	Cmd dockercli.Cmd
}

// Response định sẵn kết quả trả về cho một lệnh khớp Match.
type Response struct {
	// Match nhận (name, args) đầy đủ của lệnh, trả true nếu đây là lệnh cần
	// khớp response này. nil Match khớp mọi lệnh chưa có response nào khác
	// khớp trước đó (dùng làm mặc định).
	Match  func(cmd dockercli.Cmd) bool
	Lines  []string // các dòng Stream sẽ phát ra tuần tự qua onLine
	Output []byte   // dữ liệu Output trả về
	Err    error    // lỗi trả về sau khi đã phát hết Lines/Output
}

// Runner là dockercli.Runner giả, phát Response đã định sẵn theo thứ tự
// khớp đầu tiên, và ghi lại mọi Call để test kiểm tra ngược lại.
type Runner struct {
	mu        sync.Mutex
	Responses []Response
	Calls     []Call
}

func (r *Runner) record(cmd dockercli.Cmd) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Calls = append(r.Calls, Call{Cmd: cmd})
}

func (r *Runner) match(cmd dockercli.Cmd) (Response, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, resp := range r.Responses {
		if resp.Match == nil || resp.Match(cmd) {
			return resp, true
		}
	}
	return Response{}, false
}

func (r *Runner) Output(ctx context.Context, cmd dockercli.Cmd) ([]byte, error) {
	r.record(cmd)
	resp, ok := r.match(cmd)
	if !ok {
		return nil, fmt.Errorf("fake.Runner: không có Response khớp lệnh %s %v", cmd.Name, cmd.Args)
	}
	return resp.Output, resp.Err
}

func (r *Runner) Stream(ctx context.Context, cmd dockercli.Cmd, onLine func(line string)) error {
	r.record(cmd)
	resp, ok := r.match(cmd)
	if !ok {
		return fmt.Errorf("fake.Runner: không có Response khớp lệnh %s %v", cmd.Name, cmd.Args)
	}
	for _, l := range resp.Lines {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		onLine(l)
	}
	return resp.Err
}

// MatchArgsContain trả về một Match khớp khi mọi chuỗi trong want đều xuất
// hiện (liền hoặc là chính xác một phần tử) trong Cmd.Args — tiện dựng test
// mà không cần so khớp toàn bộ danh sách tham số.
func MatchArgsContain(want ...string) func(dockercli.Cmd) bool {
	return func(cmd dockercli.Cmd) bool {
		joined := strings.Join(cmd.Args, " \x00 ")
		for _, w := range want {
			if !strings.Contains(joined, w) {
				return false
			}
		}
		return true
	}
}
