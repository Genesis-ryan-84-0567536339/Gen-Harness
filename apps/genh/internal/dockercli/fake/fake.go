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

	// OutputSeq, nếu khác nil, làm Output đổi theo SỐ LẦN response này đã
	// khớp trước đó trong cùng Runner (0-based, kẹp ở phần tử cuối khi vượt
	// quá) — dùng để giả lập trạng thái đổi qua nhiều lần gọi, ví dụ
	// `docker compose ps` báo "starting" vài lần rồi "healthy" (xem
	// internal/compose.WaitHealthy).
	OutputSeq [][]byte
}

// Runner là dockercli.Runner giả, phát Response đã định sẵn theo thứ tự
// khớp đầu tiên, và ghi lại mọi Call để test kiểm tra ngược lại.
type Runner struct {
	mu          sync.Mutex
	Responses   []Response
	Calls       []Call
	matchCounts []int // song song với Responses, đếm số lần mỗi response đã khớp
}

func (r *Runner) record(cmd dockercli.Cmd) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.Calls = append(r.Calls, Call{Cmd: cmd})
}

// match trả về response khớp đầu tiên cùng số lần nó ĐÃ khớp trước lần này
// (0 ở lần khớp đầu tiên) — dùng cho OutputSeq.
func (r *Runner) match(cmd dockercli.Cmd) (Response, int, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.matchCounts) != len(r.Responses) {
		r.matchCounts = make([]int, len(r.Responses))
	}
	for i, resp := range r.Responses {
		if resp.Match == nil || resp.Match(cmd) {
			occurrence := r.matchCounts[i]
			r.matchCounts[i]++
			return resp, occurrence, true
		}
	}
	return Response{}, 0, false
}

func (r *Runner) Output(ctx context.Context, cmd dockercli.Cmd) ([]byte, error) {
	r.record(cmd)
	resp, occurrence, ok := r.match(cmd)
	if !ok {
		return nil, fmt.Errorf("fake.Runner: không có Response khớp lệnh %s %v", cmd.Name, cmd.Args)
	}
	if resp.OutputSeq != nil {
		idx := occurrence
		if idx >= len(resp.OutputSeq) {
			idx = len(resp.OutputSeq) - 1
		}
		if idx >= 0 {
			return resp.OutputSeq[idx], resp.Err
		}
	}
	return resp.Output, resp.Err
}

func (r *Runner) Stream(ctx context.Context, cmd dockercli.Cmd, onLine func(line string)) error {
	r.record(cmd)
	resp, _, ok := r.match(cmd)
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
