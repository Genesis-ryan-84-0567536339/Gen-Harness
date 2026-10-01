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
	// RollbackFailed: tự quay về bản cũ CŨNG thất bại (khôi phục CSDL hoặc khởi
	// động lại lỗi) — máy cần xử lý tay. Không có khoá (tệp cũ) = quay về ổn.
	RollbackFailed bool `json:"rollback_failed,omitempty"`
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

// UpdateInProgressFile đánh dấu một lần `genh update` đã bắt đầu đổi máy (ghi
// ngay TRƯỚC khi đồng bộ compose.yaml) mà chưa xong. genh bị tắt/máy khởi động
// lại giữa chừng thì compose.yaml đã là bản mới trong khi container còn cũ —
// còn tệp này thì lần sau KHÔNG được coi "đã khớp bản nhúng" (ops.UpdateNeeded).
const UpdateInProgressFile = "update-inprogress.json"

// UpdateInProgress là nội dung update-inprogress.json (không chứa bí mật).
type UpdateInProgress struct {
	Version   string `json:"version"`
	BackupKey string `json:"backup_key,omitempty"`
	StartedAt string `json:"started_at"`
}

func updateInProgressPath(installDir string) string {
	return filepath.Join(Dir(installDir), UpdateInProgressFile)
}

// MarkUpdateInProgress ghi update-inprogress.json (StartedAt rỗng → bây giờ).
func MarkUpdateInProgress(installDir string, p UpdateInProgress) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	if p.StartedAt == "" {
		p.StartedAt = now()
	}
	return writeJSON(updateInProgressPath(installDir), p)
}

// UpdateInProgressExists báo còn dấu "đang cập nhật dở" không.
func UpdateInProgressExists(installDir string) bool {
	_, err := os.Lstat(updateInProgressPath(installDir))
	return err == nil
}

// ClearUpdateInProgress xoá update-inprogress.json — không có tệp → nil.
func ClearUpdateInProgress(installDir string) error {
	err := os.Remove(updateInProgressPath(installDir))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
