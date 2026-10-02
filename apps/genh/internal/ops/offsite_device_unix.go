//go:build !windows

package ops

import (
	"fmt"
	"os"
	"syscall"
)

// sameDevice (Unix): dest và installDir cùng thiết bị (Stat_t.Dev)? Ổ USB/NAS
// đã mount có Dev riêng; rút ổ ra thì thư mục mount rỗng nằm lại trên ổ chính
// — cùng Dev với gốc cài ⇒ coi là "chưa thấy ổ USB/NAS".
func sameDevice(dest, installDir string) (bool, error) {
	a, err := os.Stat(dest)
	if err != nil {
		return false, err
	}
	b, err := os.Stat(installDir)
	if err != nil {
		return false, err
	}
	sa, ok1 := a.Sys().(*syscall.Stat_t)
	sb, ok2 := b.Sys().(*syscall.Stat_t)
	if !ok1 || !ok2 {
		return false, fmt.Errorf("không đọc được thông tin thiết bị")
	}
	return sa.Dev == sb.Dev, nil
}
