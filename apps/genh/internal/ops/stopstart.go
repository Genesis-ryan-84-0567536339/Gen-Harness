package ops

import (
	"context"
	"fmt"
	"io"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// RunStop chạy `docker compose stop` (KHÔNG rebuild, KHÔNG xoá gì) cho toàn
// bộ service.
func RunStop(ctx context.Context, env *Env, runner dockercli.Runner, out io.Writer) error {
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	composePath, err := env.LocatePath()
	if err != nil {
		return err
	}
	bundle, err := env.LoadSecrets()
	if err != nil {
		return err
	}
	args := compose.BaseArgs(composePath, "stop")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: EnvOverlay(bundle), Dir: composeDir(composePath)}); err != nil {
		return &OpError{
			Code: ErrCodeStopFailed,
			What: "`docker compose stop` thất bại",
			Why:  err.Error(),
			Next: "Xem log ở trên rồi thử lại — dữ liệu không bị mất (chỉ dừng container).",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "Đã dừng Gen-Harness (dữ liệu giữ nguyên).")
	return nil
}

// RunStart chạy `docker compose up -d` (KHÔNG rebuild, KHÔNG migrate lại)
// cho toàn bộ service.
func RunStart(ctx context.Context, env *Env, runner dockercli.Runner, out io.Writer) error {
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	composePath, err := env.LocatePath()
	if err != nil {
		return err
	}
	bundle, err := env.LoadSecrets()
	if err != nil {
		return err
	}
	args := compose.BaseArgs(composePath, "up", "-d")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: EnvOverlay(bundle), Dir: composeDir(composePath)}); err != nil {
		return &OpError{
			Code: ErrCodeStartFailed,
			What: "`docker compose up -d` thất bại",
			Why:  err.Error(),
			Next: "Xem log ở trên rồi thử lại (`genh logs`).",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "Đã khởi động Gen-Harness. Xem `genh status` để kiểm healthy.")
	return nil
}
