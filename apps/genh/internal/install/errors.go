package install

// Mã lỗi tra được (GH-E0xx) theo đúng yêu cầu docs/handoff/05-installer.md
// (mục "Lỗi"): mỗi lỗi hiện chuyện gì xảy ra · vì sao · làm gì tiếp, kèm mã
// này để tra cứu/hỗ trợ. Đánh số theo bước: 0xx dành cho Bước 1 (Kiểm tra
// máy), 1xx cho Bước 4 (Sinh bí mật & cấu hình). Các dải còn lại (2xx Runtime,
// 3xx Tải image, 5xx Khởi động dữ liệu, 6xx Migration, 7xx Khởi động dịch
// vụ, 8xx Hoàn tất) dành cho phiên B khi cài các Step tương ứng — chỉ cần
// thêm hằng số mới, không đụng tới các mã đã có ở đây.
const (
	ErrCodeUnsupportedPlatform = "GH-E001"
	ErrCodeInsufficientRAM     = "GH-E002"
	ErrCodeInsufficientDisk    = "GH-E003"
	ErrCodePortInUse           = "GH-E004"
	ErrCodeNetworkUnreachable  = "GH-E005"

	ErrCodeSecretsWriteFailed = "GH-E010"
)
