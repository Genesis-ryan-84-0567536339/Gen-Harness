// Package hostlink là "hộp thư" giữa Console (container api) và genh trên máy
// chủ, để Owner bấm "Cập nhật ngay" trong ứng dụng thay vì gõ lệnh:
//
//	<gốc cài đặt>/run/           ← bind-mount vào api tại /var/lib/gh/host
//	  genh.json                  ← genh ghi: phiên bản đang chạy + cơ chế nhận yêu cầu
//	  request/update.json        ← api ghi khi Owner bấm nút; genh xoá khi bắt đầu
//	  update-status.json         ← genh ghi: running → done/failed (+ thông báo)
//
// Bên máy chủ, một "watcher" (systemd path unit / crontab mỗi phút / launchd
// QueueDirectories — xem internal/autoupdate) chạy `genh update --yes --quiet
// --if-requested` khi thấy request/update.json (thư mục riêng để launchd
// QueueDirectories chỉ chạy khi thư mục này có tệp). Container api chạy dưới uid
// khác người dùng máy chủ nên thư mục run để 0777: trong đó chỉ có ba tệp
// trạng thái nhỏ, không có bí mật.
package hostlink

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

const (
	InfoFile    = "genh.json"
	RequestDir  = "request"
	RequestFile = "update.json"
	StatusFile  = "update-status.json"
)

// Dir là thư mục hộp thư dưới gốc cài đặt.
func Dir(installDir string) string { return filepath.Join(installDir, "run") }

// RequestDirPath là thư mục chứa yêu cầu (launchd QueueDirectories theo dõi thư mục này).
func RequestDirPath(installDir string) string { return filepath.Join(Dir(installDir), RequestDir) }

// RequestPath là đường dẫn tệp yêu cầu cập nhật (systemd/cron theo dõi tệp này).
func RequestPath(installDir string) string {
	return filepath.Join(RequestDirPath(installDir), RequestFile)
}

// EnsureDir tạo thư mục run (0777 để container api ghi được yêu cầu) —
// PHẢI chạy trước `docker compose up`, nếu không Docker tự tạo thư mục bind
// mount với chủ root và api không ghi được.
func EnsureDir(installDir string) error {
	for _, d := range []string{Dir(installDir), RequestDirPath(installDir)} {
		if err := os.MkdirAll(d, 0o777); err != nil {
			return err
		}
		if err := os.Chmod(d, 0o777); err != nil {
			return err
		}
	}
	return nil
}

// Info là nội dung genh.json.
type Info struct {
	Version string `json:"version"`
	// Updater là cơ chế nhận yêu cầu từ Console: "systemd", "cron", "launchd"
	// hoặc "" (chưa có — Console hiện lệnh để Owner tự chạy).
	Updater   string `json:"updater"`
	WrittenAt string `json:"written_at"`
}

// Status là nội dung update-status.json.
type Status struct {
	State      string `json:"state"` // running | done | failed
	From       string `json:"from,omitempty"`
	To         string `json:"to,omitempty"`
	Message    string `json:"message,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// WriteInfo ghi phiên bản genh đang chạy + cơ chế nhận yêu cầu.
func WriteInfo(installDir, version, updater string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	return writeJSON(filepath.Join(Dir(installDir), InfoFile), Info{Version: version, Updater: updater, WrittenAt: now()})
}

// ReadInfo đọc genh.json (lỗi nếu chưa có).
func ReadInfo(installDir string) (Info, error) {
	var i Info
	b, err := os.ReadFile(filepath.Join(Dir(installDir), InfoFile))
	if err != nil {
		return i, err
	}
	return i, json.Unmarshal(b, &i)
}

// HasRequest báo Console có đang yêu cầu cập nhật không.
func HasRequest(installDir string) bool {
	_, err := os.Stat(RequestPath(installDir))
	return err == nil
}

// ConsumeRequest xoá tệp yêu cầu (gọi khi bắt đầu cập nhật) — trả true nếu
// trước đó có yêu cầu. Xoá TRƯỚC khi chạy để watcher không kích lặp lại.
func ConsumeRequest(installDir string) bool {
	err := os.Remove(RequestPath(installDir))
	return err == nil || !errors.Is(err, os.ErrNotExist)
}

// Start ghi trạng thái "running".
func Start(installDir, from string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	return writeJSON(filepath.Join(Dir(installDir), StatusFile), Status{State: "running", From: from, StartedAt: now()})
}

// Finish ghi trạng thái cuối (done/failed) giữ nguyên From/StartedAt của lần
// chạy đang dở nếu có.
func Finish(installDir, state, to, message string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	st, _ := ReadStatus(installDir)
	st.State, st.To, st.Message, st.FinishedAt = state, to, message, now()
	return writeJSON(filepath.Join(Dir(installDir), StatusFile), st)
}

// ReadStatus đọc update-status.json (Status rỗng nếu chưa có).
func ReadStatus(installDir string) (Status, error) {
	var s Status
	b, err := os.ReadFile(filepath.Join(Dir(installDir), StatusFile))
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(b, &s)
}
