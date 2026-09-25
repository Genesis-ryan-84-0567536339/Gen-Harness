package ops

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// RunBackup chạy `python -m gh.backup run` trong container api (backup vào
// ObjectStore nội bộ — phần lõi bắt buộc của lệnh này). Nếu toPath khác
// rỗng, SAU KHI backup xong trong container, cố COPY thêm bản đó ra host
// tại toPath — đọc bytes qua getObjectBytesScript rồi ghi thẳng ra đĩa host.
//
// GIỚI HẠN: bytes ghi ra toPath là bản ĐÃ MÃ HOÁ bằng gh.crypto (đúng những
// gì ObjectStore giữ, xem BACKUP_AAD trong apps/api/gh/backup.py) — không tự
// giải mã ở đây (khoá giải mã là GH_MASTER_KEY, chỉ container api nên biết
// thẳng, genh không nên có bản rõ trên host). Tệp ở toPath dùng được để lưu
// trữ ngoài/gửi hỗ trợ, KHÔNG dùng trực tiếp được với `pg_restore` bên ngoài
// container.
func RunBackup(ctx context.Context, env *Env, toPath string, runner dockercli.Runner, out io.Writer) error {
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
	envOverlay := EnvOverlay(bundle)
	dir := composeDir(composePath)

	key, backupErr := runBackupInContainer(ctx, runner, composePath, envOverlay, dir)
	if backupErr != nil && key == "" && strings.Contains(backupErr.Error(), "không đọc được khoá") {
		// Lệnh chạy xong (không lỗi tiến trình) nhưng không đọc được khoá từ
		// log — không phải lỗi chặn, backup vẫn có thể đã nằm trong
		// ObjectStore, chỉ là genh không biết khoá nào để in ra/copy tiếp.
		_, _ = fmt.Fprintln(out, "Backup có vẻ đã chạy xong nhưng không đọc được khoá từ log — dùng `docker compose exec api python -m gh.backup list` để kiểm tay.")
	} else if backupErr != nil {
		return &OpError{
			Code: ErrCodeBackupFailed,
			What: "`python -m gh.backup run` thất bại trong container " + backupServiceName,
			Why:  backupErr.Error(),
			Next: "Kiểm `genh status` (db phải healthy) rồi thử lại.",
			Err:  backupErr,
		}
	} else {
		_, _ = fmt.Fprintln(out, "Backup xong: "+key)
	}

	if toPath == "" {
		return nil
	}
	if key == "" {
		return &OpError{
			Code: ErrCodeBackupFailed,
			What: "Không copy được backup ra host vì không xác định được khoá vừa tạo",
			Why:  "không thấy dòng log \"Backup mới: ...\" trong output của `python -m gh.backup run`",
			Next: "Backup vẫn nằm trong ObjectStore nội bộ — dùng `docker compose exec api python -m gh.backup list` để tìm khoá rồi tự copy tay nếu cần.",
		}
	}

	scriptArgs := compose.BaseArgs(composePath, "exec", "-T", backupServiceName, "python", "-c", getObjectBytesScript, key)
	data, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: scriptArgs, Env: envOverlay, Dir: dir})
	if err != nil {
		return &OpError{
			Code: ErrCodeBackupFailed,
			What: "Backup đã lưu trong ObjectStore nội bộ, nhưng copy ra host thất bại",
			Why:  err.Error(),
			Next: "Backup vẫn an toàn (khoá: " + key + "); thử lại `genh backup --to " + toPath + "` hoặc bỏ --to.",
			Err:  err,
		}
	}
	if err := os.WriteFile(toPath, data, 0o600); err != nil {
		return &OpError{
			Code: ErrCodeBackupFailed,
			What: "Backup đã lưu trong ObjectStore nội bộ, nhưng ghi ra " + toPath + " thất bại",
			Why:  err.Error(),
			Next: "Kiểm quyền ghi/đường dẫn " + toPath + " rồi thử lại — backup không mất (khoá: " + key + ").",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintf(out, "Đã copy bản mã hoá ra %s (%d byte) — xem GIỚI HẠN trong ops.RunBackup: tệp này vẫn ở dạng mã hoá.\n", toPath, len(data))
	return nil
}

// RunRestore khôi phục một bản backup: nếu key được biết đúng định dạng
// ObjectStore ("backups/....enc", đúng những gì `genh backup`/`genh backup
// list`-tương đương trả về) gọi thẳng `python -m gh.backup restore --key`.
//
// GIỚI HẠN QUAN TRỌNG: apps/api/gh/backup.py::restore_backup(key: str, ...)
// CHỈ nhận một khoá đã có sẵn trong ObjectStore nội bộ (đọc qua store.get(key))
// — KHÔNG có tham số nhận đường dẫn file tuỳ ý trên host. Vì vậy genh restore
// hiện KHÔNG hỗ trợ khôi phục từ một tệp bất kỳ trên máy Owner: nếu arg trỏ
// tới một tệp có thật trên đĩa host (os.Stat thành công) nhưng không đúng
// định dạng khoá "backups/...", trả lỗi rõ ràng thay vì âm thầm thất bại ở
// tầng container.
func RunRestore(ctx context.Context, env *Env, key string, runner dockercli.Runner, out io.Writer) error {
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	if !strings.HasPrefix(key, "backups/") {
		if info, statErr := os.Stat(key); statErr == nil && !info.IsDir() {
			return &OpError{
				Code: ErrCodeRestoreFailed,
				What: "genh restore chưa hỗ trợ khôi phục từ một tệp tuỳ ý trên host",
				Why:  fmt.Sprintf("%q là một tệp có thật trên máy này, nhưng apps/api/gh/backup.py::restore_backup() chỉ nhận khoá đã có sẵn trong ObjectStore nội bộ (dạng \"backups/...\"), không nhận đường dẫn file host", key),
				Next: "Dùng khoá từ `docker compose exec api python -m gh.backup list` (tương đương `genh backup list` khi có), ví dụ: genh restore backups/20260925T...enc",
			}
		}
	}

	composePath, err := env.LocatePath()
	if err != nil {
		return err
	}
	bundle, err := env.LoadSecrets()
	if err != nil {
		return err
	}
	envOverlay := EnvOverlay(bundle)
	dir := composeDir(composePath)

	args := compose.BaseArgs(composePath, "exec", "-T", backupServiceName, "python", "-m", "gh.backup", "restore", "--key", key)
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: envOverlay, Dir: dir}); err != nil {
		return &OpError{
			Code: ErrCodeRestoreFailed,
			What: "`python -m gh.backup restore --key " + key + "` thất bại",
			Why:  err.Error(),
			Next: "Kiểm khoá đúng (dùng `docker compose exec api python -m gh.backup list`) rồi thử lại.",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "Đã khôi phục "+key)
	return nil
}
