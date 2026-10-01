package hostlink

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// UpdateBlockedFile ghi lại bản genh đã lỗi ở lần cập nhật trước VÀ đã tự quay
// về bản cũ sau khi đụng CSDL (F-33) — lịch đêm (`genh update --yes`, không
// --if-requested) đọc tệp này để không thử lại đúng bản đó mỗi đêm. Nút "Cập
// nhật ngay" và gõ tay không bị chặn; cập nhật thành công thì genh xoá tệp.
const UpdateBlockedFile = "update-blocked.json"

// UpdateBlocked là nội dung update-blocked.json (không chứa bí mật).
type UpdateBlocked struct {
	Version   string `json:"version"`
	BlockedAt string `json:"blocked_at"`
	Code      string `json:"code,omitempty"`
	BackupKey string `json:"backup_key,omitempty"`
	Message   string `json:"message,omitempty"`
}

func updateBlockedPath(installDir string) string {
	return filepath.Join(Dir(installDir), UpdateBlockedFile)
}

// WriteUpdateBlocked ghi update-blocked.json (BlockedAt rỗng → thời điểm hiện tại).
func WriteUpdateBlocked(installDir string, b UpdateBlocked) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	if b.BlockedAt == "" {
		b.BlockedAt = now()
	}
	return writeJSON(updateBlockedPath(installDir), b)
}

// ReadUpdateBlocked đọc update-blocked.json — không có tệp → (rỗng, false, nil).
func ReadUpdateBlocked(installDir string) (UpdateBlocked, bool, error) {
	var b UpdateBlocked
	raw, err := os.ReadFile(updateBlockedPath(installDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return b, false, nil
		}
		return b, false, err
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return b, false, err
	}
	return b, true, nil
}

// ClearUpdateBlocked xoá update-blocked.json — không có tệp → nil.
func ClearUpdateBlocked(installDir string) error {
	err := os.Remove(updateBlockedPath(installDir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
