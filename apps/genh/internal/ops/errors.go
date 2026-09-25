// Package ops cài các lệnh VẬN HÀNH của genh (status/open/logs/update/
// backup/restore/doctor/reset-setup/stop/start/uninstall — xem
// docs/handoff/05-installer.md mục "Lệnh vận hành"), khác với internal/
// install (8 bước của `genh install`). cmd/genh/main.go chỉ gọi vào các hàm
// Run* ở đây, giữ main.go mỏng đúng pattern đã có với runInstall.
package ops

// Mã lỗi tra được (GH-E9xx) cho các lệnh vận hành — dải MỚI, không đụng
// 0xx/1xx/2xx/3xx/5xx/6xx/7xx/8xx đã dùng cho 8 Step cài đặt (xem
// internal/install/errors.go). Đánh số theo lệnh, mỗi lệnh một dải 10 mã để
// còn chỗ mở rộng.
const (
	// 90x — chung cho mọi lệnh vận hành (không tìm compose.yaml, chưa cài,
	// chưa có bí mật…).
	ErrCodeNotInstalled    = "GH-E900" // chưa chạy `genh install` (thiếu bí mật/cấu hình)
	ErrCodeComposeNotFound = "GH-E901" // không tìm thấy deploy/compose.yaml

	// 91x — genh status.
	ErrCodeStatusFailed = "GH-E910"

	// 92x — genh open.
	ErrCodeOpenFailed = "GH-E920"

	// 93x — genh logs.
	ErrCodeLogsFailed = "GH-E930"

	// 94x — genh update (khung backup → pull → migrate → restart → healthcheck,
	// rollback tự động khi bất kỳ bước nào lỗi).
	ErrCodeUpdateBackupFailed  = "GH-E940"
	ErrCodeUpdatePullFailed    = "GH-E941"
	ErrCodeUpdateMigrateFailed = "GH-E942"
	ErrCodeUpdateRestartFailed = "GH-E943"
	ErrCodeUpdateNotReady      = "GH-E944"
	ErrCodeUpdateRolledBack    = "GH-E945" // một bước ở trên lỗi VÀ rollback đã tự chạy (thành công hoặc không)

	// 95x — genh backup / genh restore.
	ErrCodeBackupFailed  = "GH-E950"
	ErrCodeRestoreFailed = "GH-E951"

	// 96x — genh doctor.
	ErrCodeDoctorReportFailed = "GH-E960"

	// 97x — genh reset-setup.
	ErrCodeResetSetupFailed    = "GH-E970"
	ErrCodeResetSetupCancelled = "GH-E971"

	// 98x — genh stop / genh start.
	ErrCodeStopFailed  = "GH-E980"
	ErrCodeStartFailed = "GH-E981"

	// 99x — genh uninstall.
	ErrCodeUninstallCancelled = "GH-E990"
	ErrCodeUninstallFailed    = "GH-E991"
)

// OpError là lỗi có cấu trúc cho các lệnh vận hành, theo đúng tinh thần
// "chuyện gì xảy ra · vì sao · làm gì tiếp" của install.StepError (xem
// docs/handoff/05-installer.md mục "Lỗi") — KHÔNG dùng lại type đó vì các
// lệnh vận hành không chạy qua install.Runner/Reporter (không có khái niệm
// Percent/SubLines/StepID), một type riêng đơn giản hơn phù hợp hơn là ép
// dùng chung cho bằng được.
type OpError struct {
	Code string // ví dụ "GH-E941"
	What string // chuyện gì xảy ra
	Why  string // vì sao
	Next string // làm gì tiếp
	Err  error  // lỗi gốc, nếu có
}

func (e *OpError) Error() string {
	if e == nil {
		return ""
	}
	msg := e.What
	if e.Why != "" {
		msg += ": " + e.Why
	}
	if e.Code != "" {
		msg += " (" + e.Code + ")"
	}
	return msg
}

func (e *OpError) Unwrap() error { return e.Err }

// Report định dạng OpError đúng 3 dòng "chuyện gì · vì sao · làm gì tiếp"
// dùng chung cho mọi lệnh vận hành khi in ra stderr.
func (e *OpError) Report() string {
	s := "✕ " + e.What + "\n"
	if e.Why != "" {
		s += "  vì sao: " + e.Why + "\n"
	}
	if e.Next != "" {
		s += "  làm gì tiếp: " + e.Next + "\n"
	}
	s += "  " + e.Code + "\n"
	return s
}
