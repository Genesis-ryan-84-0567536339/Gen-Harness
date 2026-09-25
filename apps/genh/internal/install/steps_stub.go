package install

import "context"

// stubStep là chỗ cắm cho các bước chưa được triển khai thật trong phần A
// (Bước 2, 3, 5, 6, 7, 8). Run của nó không đụng Docker, không tải gì,
// không khởi động gì — chỉ báo StatusWarn kèm ghi chú rõ ràng rồi trả về
// ngay, để toàn bộ khung 8 bước chạy được hết lượt (Runner, tính % tổng,
// TUI) và có thể test end-to-end ở mức khung, trước khi có nội dung thật.
//
// Phiên B thay từng dòng trong Registry() bằng một Step thật cùng StepID —
// không cần sửa Runner hay TUI.
type stubStep struct {
	id   StepID
	name string
}

func (s stubStep) ID() StepID   { return s.id }
func (s stubStep) Name() string { return s.name }

func (s stubStep) Run(ctx context.Context, env *Env, rep Reporter) error {
	rep.Report(Progress{
		StepID:  s.id,
		Status:  StatusWarn,
		Percent: 100,
		Detail:  "chưa triển khai trong phần A — chờ Step thật ở phiên sau",
	})
	return nil
}

// Registry trả về 8 Step theo đúng thứ tự StepID trong bảng trọng số của
// docs/handoff/05-installer.md. Bước 1, 2, 3 và 4 là cài đặt thật; các bước
// còn lại vẫn là stubStep, thay dần trong các commit tiếp theo.
func Registry() []Step {
	return []Step{
		machineCheckStep{},
		runtimeStep{},
		pullStep{},
		secretsStep{},
		stubStep{id: StepStartData, name: "Khởi động dữ liệu"},
		stubStep{id: StepMigrate, name: "Tạo cấu trúc dữ liệu"},
		stubStep{id: StepStartServices, name: "Khởi động dịch vụ"},
		stubStep{id: StepFinalize, name: "Hoàn tất"},
	}
}
