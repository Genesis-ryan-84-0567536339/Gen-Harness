package ops

import (
	"context"
	"fmt"
	"regexp"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// backupServiceName là service compose chạy CLI `python -m gh.backup` (xem
// apps/api/gh/backup.py) — cùng image với "api"/"migrate", chạy qua `docker
// compose exec` vào container "api" đang sống (không phải `run` một
// container mới, vì backup cần đọc GH_DATABASE_URL/khoá bí mật runtime đã
// mount sẵn ở container api).
const backupServiceName = "api"

// backupKeyRe khớp khoá bản backup mà apps/api/gh/backup.py sinh ra, ví dụ
// "backups/20260925T120000Z-abcd1234.pgcustom.enc" — xuất hiện trong dòng
// log INFO "Backup mới: <khoá> (...)" mà run_backup() ghi (logging module
// mặc định ra stderr, dockercli không phân biệt được stdout/stderr khi
// Stream gộp cả hai theo thứ tự — không thành vấn đề, chỉ cần bắt được
// dòng).
var backupKeyRe = regexp.MustCompile(`backups/\S+\.enc`)

// getObjectBytesScript đọc thẳng bytes đã MÃ HOÁ của một khoá backup qua
// đúng abstraction ObjectStore mà apps/api/gh/backup.py dùng (get_object_
// store().get(key)) — không giả định biết trước đường dẫn đĩa thật của
// backend (LocalObjectStore hiện tại, hoặc MinIO thật sau này khi được nối
// dây — xem apps/api/gh/chassis/objects.py), nên vẫn đúng bất kể backend
// nào đang cấu hình.
const getObjectBytesScript = `import asyncio, sys
from gh.chassis.objects import get_object_store
async def _m():
    data = await get_object_store().get(sys.argv[1])
    sys.stdout.buffer.write(data)
asyncio.run(_m())`

// runBackupInContainer chạy `python -m gh.backup run` trong container api và
// trả về khoá backup vừa tạo (đọc từ dòng log) — logic dùng chung giữa `genh
// backup` (backup.go) và `genh update` (update.go — rollback cần đúng khoá
// backup vừa tạo TRƯỚC khi đụng gì).
func runBackupInContainer(ctx context.Context, runner dockercli.Runner, composePath string, envOverlay []string, dir string) (string, error) {
	args := compose.BaseArgs(composePath, "exec", "-T", backupServiceName, "python", "-m", "gh.backup", "run")
	var lines []string
	if err := runner.Stream(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: envOverlay, Dir: dir}, func(line string) {
		lines = append(lines, line)
	}); err != nil {
		return "", err
	}
	key := findBackupKey(lines)
	if key == "" {
		return "", fmt.Errorf("backup chạy xong nhưng không đọc được khoá từ log")
	}
	return key, nil
}

func findBackupKey(lines []string) string {
	for _, l := range lines {
		if m := backupKeyRe.FindString(l); m != "" {
			return m
		}
	}
	return ""
}

// restoreInContainer chạy `python -m gh.backup restore --key <key>` trong
// container api — dùng chung giữa `genh restore` (backup.go) và rollback tự
// động của `genh update` (update.go).
func restoreInContainer(ctx context.Context, runner dockercli.Runner, composePath string, envOverlay []string, dir, key string) error {
	args := compose.BaseArgs(composePath, "exec", "-T", backupServiceName, "python", "-m", "gh.backup", "restore", "--key", key)
	_, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: envOverlay, Dir: dir})
	return err
}
