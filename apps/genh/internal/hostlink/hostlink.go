// Package hostlink là "hộp thư" giữa Console (container api) và genh trên máy
// chủ, để Owner bấm "Cập nhật ngay" trong ứng dụng thay vì gõ lệnh:
//
//	<gốc cài đặt>/run/           ← bind-mount vào api tại /var/lib/gh/host
//	  genh.json                  ← genh ghi: phiên bản đang chạy + cơ chế nhận yêu cầu
//	  request/update.json        ← api ghi khi Owner bấm nút; genh xoá khi bắt đầu
//	  update-status.json         ← genh ghi: running → done/failed (+ thông báo)
//	  request/restore.json       ← api ghi khi Owner bấm "Khôi phục" (v0.1.20): {key}
//	  restore-status.json        ← genh ghi: running → done/failed (+ bản an toàn)
//	  update-blocked.json        ← genh ghi (v0.1.34): bản đã lỗi + đã quay về bản cũ sau khi
//	                               đụng CSDL — lịch đêm không thử lại; xoá khi cập nhật thành công
//	  disk-status.json           ← genh ghi (v0.1.34) mỗi lần update kiểm đĩa: ok|low + số byte
//	  update-inprogress.json     ← genh ghi (v0.1.34) ngay trước khi đổi compose.yaml; xoá khi xong —
//	                               còn tệp = lần trước dừng giữa chừng, lần sau phải chạy lại đủ
//	  genh-heartbeat.json        ← genh ghi (v0.1.37) mỗi 30 giây khi đang giữ khoá loại trừ
//	                               (update/restore/import): {pid, op, boot_id, started_at, at};
//	                               xoá khi nhả khoá — Console suy "tiến trình còn sống" từ đây
//	  autostart-status.json      ← genh ghi (v0.1.37) lúc status/doctor/update: Docker và linger
//	                               có tự chạy lại khi bật máy không (xem autostart.go)
//
// Khoá loại trừ (lock.go) KHÔNG nằm trong run/ mà ở <gốc cài đặt>/genh.lock —
// run/ 0777 và bind-mount vào api, ai ghi được run/ sẽ xoá/thay/giữ được khoá.
//
// Bên máy chủ, một "watcher" (systemd path unit / crontab mỗi phút / launchd
// QueueDirectories — xem internal/autoupdate) chạy `genh handle-requests`
// khi thấy request/update.json hoặc request/restore.json — genh tự chọn việc
// (cập nhật trước, khôi phục sau) (thư mục riêng để launchd
// QueueDirectories chỉ chạy khi thư mục này có tệp). Container api chạy dưới uid
// khác người dùng máy chủ nên thư mục run để 0777: trong đó chỉ có vài tệp
// trạng thái nhỏ, không có bí mật — và vì ai cũng ghi được, genh không tin tệp
// nào ở đây khi đọc (readStateFile: không theo symlink, giới hạn kích thước).
package hostlink

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"
)

// EnvDir là biến môi trường genh đặt cho docker compose: đường dẫn hộp thư trên
// máy chủ (compose.yaml: ${GH_HOST_LINK_DIR:-../run}:/var/lib/gh/host).
const EnvDir = "GH_HOST_LINK_DIR"

const (
	InfoFile    = "genh.json"
	RequestDir  = "request"
	RequestFile = "update.json"
	StatusFile  = "update-status.json"

	RestoreRequestFile = "restore.json"
	RestoreStatusFile  = "restore-status.json"
)

// Requests là các loại yêu cầu watcher hiện tại nhận (ghi vào genh.json để
// Console biết nút nào bấm được — watcher cũ v0.1.19 chỉ nhận "update").
var Requests = []string{"update", "restore"}

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
	Updater string `json:"updater"`
	// Requests: loại yêu cầu watcher nhận (rỗng khi chưa có watcher).
	Requests []string `json:"requests,omitempty"`
	// AutoUpdateEnabled (v0.1.33): lịch tự cập nhật đêm (~03:00) đang bật hay
	// tắt — ghi lúc cài/update và khi `genh auto-update enable|disable`. nil
	// (không có khoá) = không rõ (genh cũ / không đọc được) ⇒ Console không
	// hứa "Tự cài đêm …".
	AutoUpdateEnabled *bool  `json:"auto_update_enabled,omitempty"`
	WrittenAt         string `json:"written_at"`
}

// Status là nội dung update-status.json.
type Status struct {
	State      string `json:"state"` // running | done | failed
	From       string `json:"from,omitempty"`
	To         string `json:"to,omitempty"`
	Message    string `json:"message,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
	// PID (v0.1.37) là PID tiến trình genh NGOÀI CÙNG (tiến trình giữ khoá và
	// ghi nhịp sống genh-heartbeat.json) — Console đối chiếu với nhịp sống.
	PID int `json:"pid,omitempty"`
	// BootID (v0.1.37): /proc/sys/kernel/random/boot_id lúc Start ("" ngoài
	// Linux) — khác boot_id hiện tại ⇒ máy đã khởi động lại, lần chạy đã chết.
	BootID string `json:"boot_id,omitempty"`
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(path, append(b, '\n'))
}

// writeFileAtomic ghi data ra path qua tệp tạm TÊN NGẪU NHIÊN (os.CreateTemp —
// O_EXCL, không đi theo symlink) rồi rename. Thư mục run/ để 0777 và được
// bind-mount vào container api: tên tạm cố định (<tệp>.tmp) cho phép ai ghi
// được run/ cài sẵn symlink để genh (có thể chạy bằng root) ghi đè tệp ngoài.
// rename thay chính đường dẫn đích (kể cả khi đích là symlink) chứ không đi theo.
func writeFileAtomic(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	done := false
	defer func() {
		if !done {
			_ = os.Remove(tmp)
		}
	}()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	// CreateTemp tạo 0600 — api (uid khác) phải đọc được tệp trạng thái.
	if err := f.Chmod(0o644); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	done = true
	return nil
}

// WriteInfo ghi phiên bản genh đang chạy + cơ chế nhận yêu cầu + trạng thái
// lịch tự cập nhật đêm (autoUpdate nil = không rõ, bỏ khoá).
func WriteInfo(installDir, version, updater string, autoUpdate *bool) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	info := Info{Version: version, Updater: updater, AutoUpdateEnabled: autoUpdate, WrittenAt: now()}
	if updater != "" {
		info.Requests = Requests
	}
	return writeJSON(filepath.Join(Dir(installDir), InfoFile), info)
}

// SetAutoUpdate chỉ đổi trạng thái lịch tự cập nhật đêm trong genh.json (giữ
// nguyên version/updater/requests đã ghi). Chưa có genh.json (hoặc hỏng) thì
// ghi mới với version cho trước, chưa có watcher.
func SetAutoUpdate(installDir, version string, enabled bool) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	info, err := ReadInfo(installDir)
	if err != nil {
		info = Info{Version: version}
	}
	info.AutoUpdateEnabled = &enabled
	info.WrittenAt = now()
	return writeJSON(filepath.Join(Dir(installDir), InfoFile), info)
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

// Start ghi trạng thái "running" kèm PID tiến trình này (tiến trình NGOÀI CÙNG
// — chỉ nó gọi Start) và boot_id của máy.
func Start(installDir, from string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	return writeJSON(filepath.Join(Dir(installDir), StatusFile), Status{
		State: "running", From: from, StartedAt: now(), PID: os.Getpid(), BootID: BootID(),
	})
}

// Finish ghi trạng thái cuối (done/failed) giữ nguyên From/StartedAt/PID/
// BootID của lần chạy đang dở nếu có.
func Finish(installDir, state, to, message string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	st, _ := ReadStatus(installDir)
	st.State, st.To, st.Message, st.FinishedAt = state, to, message, now()
	return writeJSON(filepath.Join(Dir(installDir), StatusFile), st)
}

// SnapshotStatus chụp update-status.json hiện có (ok=false nếu chưa có, hoặc
// tệp không an toàn/hỏng) — để RestoreStatusSnapshot trả hộp thư về như cũ.
// KHÔNG chép nguyên byte: run/ 0777 (container api ghi được) nên tệp có thể là
// symlink/hard link tới bí mật của người chạy genh hoặc /dev/zero — chỉ đọc tệp
// thường nhỏ (readStateFile), parse thành Status rồi ghi lại đúng các trường
// đó (cùng định dạng writeJSON — tệp genh tự ghi thì trùng từng byte).
func SnapshotStatus(installDir string) (raw []byte, ok bool) {
	b, err := readStateFile(filepath.Join(Dir(installDir), StatusFile), false)
	if err != nil {
		return nil, false
	}
	var st Status
	if err := json.Unmarshal(b, &st); err != nil {
		return nil, false
	}
	out, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return nil, false
	}
	return append(out, '\n'), true
}

// RestoreStatusSnapshot ghi lại update-status.json đúng từng byte như lúc
// SnapshotStatus (ok=false → xoá tệp, như trước đó chưa có). Dùng khi một lần
// chạy quyết định KHÔNG làm gì sau khi đã báo "running" (lịch đêm gặp bản bị
// chặn): không làm mới finished_at, không ghi đè thông điệp lỗi gốc.
func RestoreStatusSnapshot(installDir string, raw []byte, ok bool) error {
	path := filepath.Join(Dir(installDir), StatusFile)
	if !ok {
		err := os.Remove(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return writeFileAtomic(path, raw)
}

// ReadStatus đọc update-status.json (Status rỗng nếu chưa có).
// Chỉ đọc tệp thường nhỏ (readStateFile) — xem SnapshotStatus.
func ReadStatus(installDir string) (Status, error) {
	var s Status
	b, err := readStateFile(filepath.Join(Dir(installDir), StatusFile), false)
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(b, &s)
}

// ─── Khôi phục từ Console (v0.1.20) ─────────────────────────────────────────

// RestoreRequestPath là tệp yêu cầu khôi phục api ghi.
func RestoreRequestPath(installDir string) string {
	return filepath.Join(RequestDirPath(installDir), RestoreRequestFile)
}

// RestoreRequest là nội dung request/restore.json.
type RestoreRequest struct {
	ID          string `json:"id,omitempty"`
	Key         string `json:"key"`
	RequestedAt string `json:"requested_at,omitempty"`
	By          string `json:"by,omitempty"`
}

// RestoreStatus là nội dung restore-status.json.
type RestoreStatus struct {
	State      string `json:"state"` // running | done | failed
	Key        string `json:"key,omitempty"`
	SafetyKey  string `json:"safety_key,omitempty"`
	Message    string `json:"message,omitempty"`
	StartedAt  string `json:"started_at,omitempty"`
	FinishedAt string `json:"finished_at,omitempty"`
}

// HasRestoreRequest báo Console có đang yêu cầu khôi phục không.
func HasRestoreRequest(installDir string) bool {
	_, err := os.Stat(RestoreRequestPath(installDir))
	return err == nil
}

// ConsumeRestoreRequest đọc rồi XOÁ yêu cầu khôi phục (xoá trước khi chạy để
// watcher không kích lặp). Tệp hỏng vẫn bị xoá, trả lỗi.
func ConsumeRestoreRequest(installDir string) (RestoreRequest, error) {
	var r RestoreRequest
	path := RestoreRequestPath(installDir)
	b, err := os.ReadFile(path)
	if err != nil {
		return r, err
	}
	_ = os.Remove(path)
	if err := json.Unmarshal(b, &r); err != nil {
		return r, err
	}
	if r.Key == "" {
		return r, errors.New("yêu cầu khôi phục thiếu khoá bản sao lưu")
	}
	return r, nil
}

// StartRestore ghi trạng thái khôi phục "running".
func StartRestore(installDir, key string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	return writeJSON(filepath.Join(Dir(installDir), RestoreStatusFile), RestoreStatus{State: "running", Key: key, StartedAt: now()})
}

// FinishRestore ghi trạng thái khôi phục cuối (done/failed), giữ Key/StartedAt.
func FinishRestore(installDir, state, safetyKey, message string) error {
	if err := EnsureDir(installDir); err != nil {
		return err
	}
	st, _ := ReadRestoreStatus(installDir)
	st.State, st.SafetyKey, st.Message, st.FinishedAt = state, safetyKey, message, now()
	return writeJSON(filepath.Join(Dir(installDir), RestoreStatusFile), st)
}

// ReadRestoreStatus đọc restore-status.json.
func ReadRestoreStatus(installDir string) (RestoreStatus, error) {
	var s RestoreStatus
	b, err := os.ReadFile(filepath.Join(Dir(installDir), RestoreStatusFile))
	if err != nil {
		return s, err
	}
	return s, json.Unmarshal(b, &s)
}

// Pending cho biết watcher cần làm việc gì: "update" (ưu tiên — cập nhật đã
// tự sao lưu trước), "restore", hoặc "" khi hộp thư trống.
func Pending(installDir string) string {
	switch {
	case HasRequest(installDir):
		return "update"
	case HasRestoreRequest(installDir):
		return "restore"
	default:
		return ""
	}
}
