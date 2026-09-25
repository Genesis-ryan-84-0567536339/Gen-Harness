package ops

import (
	"context"
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/browseropen"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// UninstallOptions là các cờ đã phân tích của `genh uninstall`.
type UninstallOptions struct {
	KeepData bool // --keep-data: KHÔNG xoá volume dữ liệu
	// AutoApprove bỏ qua hỏi xác nhận — KHÔNG có cờ CLI riêng theo tài liệu
	// gốc (tài liệu chỉ nói "hỏi trước khi xoá dữ liệu", không nói cờ bỏ
	// qua), nên cmd/genh KHÔNG đăng ký cờ --yes cho uninstall — trường này
	// tồn tại chỉ để test gọi RunUninstall trực tiếp không phải mô phỏng
	// stdin cho từng test case. Luôn false khi gọi từ CLI thật.
	AutoApprove bool
}

// RunUninstall gỡ container + volume (trừ khi --keep-data) + lối tắt desktop
// + dòng PATH mà install.sh/install.ps1 đã thêm.
//
// GIỚI HẠN QUAN TRỌNG (đọc kỹ trước khi coi lệnh này "gỡ sạch"): tài liệu
// nói "Gỡ sạch container, runtime do genh cài, lối tắt, PATH". internal/
// install/steps_runtime.go (Bước 2) hiện KHÔNG ghi lại bất kỳ đánh dấu nào
// phân biệt "runtime genh tự cài" (Docker rootless/Colima/WSL rootfs) với
// "runtime đã có sẵn trên máy Owner từ trước" — không có marker file nào
// trong ~/.gen-harness/runtime để đọc lại. Tự đoán rồi gỡ nhầm Docker Engine/
// Colima của Owner có thể phá vỡ các phần mềm KHÁC đang dùng chung runtime
// đó, hậu quả nặng hơn nhiều so với việc để lại một runtime không dùng nữa.
// Vì vậy RunUninstall CHỈ gỡ những gì chắc chắn do chính genh quản lý
// (container/volume của compose.yaml, lối tắt, dòng PATH) — KHÔNG đụng tới
// ~/.gen-harness/runtime. Owner tự gỡ runtime nếu muốn (thông báo in ra khi
// chạy lệnh này).
func RunUninstall(ctx context.Context, env *Env, opts UninstallOptions, runner dockercli.Runner, in io.Reader, out io.Writer) error {
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}

	if !opts.AutoApprove {
		_, _ = fmt.Fprintln(out, "Gỡ Gen-Harness khỏi máy này?")
		if opts.KeepData {
			_, _ = fmt.Fprintln(out, "  --keep-data: dữ liệu (CSDL, tệp) sẽ được GIỮ LẠI.")
		} else {
			_, _ = fmt.Fprintln(out, "  KHÔNG có --keep-data: TOÀN BỘ dữ liệu (CSDL, tệp đã tải lên) sẽ bị XOÁ VĨNH VIỄN.")
		}
		_, _ = fmt.Fprintln(out, "Tiếp tục? [y/N]")
		if !confirmYesNo(in) {
			return &OpError{
				Code: ErrCodeUninstallCancelled,
				What: "Đã huỷ — không gỡ gì cả",
				Next: "Chạy lại `genh uninstall` khi chắc chắn.",
			}
		}
	}

	composePath, locErr := env.LocatePath()
	if locErr != nil {
		// Không có compose.yaml nghĩa là không có gì để `docker compose down`
		// — vẫn tiếp tục gỡ lối tắt/PATH thay vì dừng hẳn (idempotent, an
		// toàn để chạy lại `genh uninstall` nhiều lần).
		_, _ = fmt.Fprintln(out, "Không tìm thấy deploy/compose.yaml — bỏ qua `docker compose down` ("+locErr.Error()+").")
	} else {
		sub := []string{"down"}
		if !opts.KeepData {
			sub = append(sub, "--volumes")
		}
		downArgs := compose.BaseArgs(composePath, sub...)

		var envOverlay []string
		if bundle, secErr := env.LoadSecrets(); secErr == nil {
			envOverlay = EnvOverlay(bundle)
		}
		if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: downArgs, Env: envOverlay, Dir: composeDir(composePath)}); err != nil {
			return &OpError{
				Code: ErrCodeUninstallFailed,
				What: "`docker compose down` thất bại",
				Why:  err.Error(),
				Next: "Xem log ở trên; có thể cần `docker compose down` tay rồi chạy lại `genh uninstall`.",
				Err:  err,
			}
		}
		_, _ = fmt.Fprintln(out, "Đã dừng và gỡ container"+volumesSuffix(opts.KeepData)+".")
	}

	if path, err := browseropen.ShortcutPath(); err == nil {
		if rmErr := os.Remove(path); rmErr == nil {
			_, _ = fmt.Fprintln(out, "Đã gỡ lối tắt "+path)
		} else if !os.IsNotExist(rmErr) {
			_, _ = fmt.Fprintln(out, "Không gỡ được lối tắt "+path+": "+rmErr.Error())
		}
	}

	if removed, rcFile, rmErr := removeFromShellRC(); rmErr != nil {
		_, _ = fmt.Fprintln(out, "Không tự gỡ được PATH khỏi "+rcFile+": "+rmErr.Error()+" — tự xoá dòng \"# Gen-Harness (genh)\" trong tệp đó nếu cần.")
	} else if removed {
		_, _ = fmt.Fprintln(out, "Đã gỡ dòng PATH khỏi "+rcFile+" — mở phiên shell mới để có hiệu lực.")
	} else if rcFile != "" {
		_, _ = fmt.Fprintln(out, "Không thấy dòng PATH của Gen-Harness trong "+rcFile+" (có thể đã gỡ trước đó, hoặc PATH được thêm theo cách khác).")
	}

	_, _ = fmt.Fprintln(out, "\nGIỚI HẠN: genh uninstall KHÔNG tự gỡ Docker Engine/Colima/WSL kể cả khi genh đã tự cài ở Bước 2 (không có cách phân biệt an toàn với runtime sẵn có của Owner) — tự gỡ tay nếu không còn cần, xem ~/.gen-harness/runtime.")
	return nil
}

func volumesSuffix(keepData bool) string {
	if keepData {
		return " (giữ nguyên dữ liệu — --keep-data)"
	}
	return " và volume dữ liệu"
}

// removeFromShellRC gỡ đúng khối "# Gen-Harness (genh)\nexport PATH=..." mà
// install.sh đã thêm (xem hàm add_to_path trong install.sh) khỏi rc file
// tương ứng ($HOME/.zshrc, $HOME/.bashrc, hoặc $HOME/.profile mặc định —
// cùng thứ tự ưu tiên theo $SHELL mà install.sh dùng để CHỌN rc file lúc
// thêm, nên phải dò đúng thứ tự đó để gỡ đúng chỗ).
//
// GIỚI HẠN: chỉ xử lý Linux/macOS (rc file dạng POSIX shell, đúng những gì
// install.sh sửa). Trên Windows, install.ps1 sửa biến PATH của user qua
// registry ([Environment]::SetEnvironmentVariable('Path', ..., 'User')) —
// không phải một rc file — gỡ đúng chỗ đó cần gọi Windows API tương ứng,
// CHƯA triển khai ở đây (không có Windows thật để test trong môi trường
// viết code này) để tránh rủi ro ghi sai biến PATH hệ thống của Owner mà
// không kiểm chứng được.
func removeFromShellRC() (removed bool, rcFile string, err error) {
	if strings.EqualFold(runtime.GOOS, "windows") {
		return false, "", nil
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return false, "", err
	}
	rcFile = home + "/.profile"
	switch {
	case strings.HasSuffix(os.Getenv("SHELL"), "/zsh"):
		rcFile = home + "/.zshrc"
	case strings.HasSuffix(os.Getenv("SHELL"), "/bash"):
		rcFile = home + "/.bashrc"
	}

	data, err := os.ReadFile(rcFile)
	if err != nil {
		if os.IsNotExist(err) {
			return false, rcFile, nil
		}
		return false, rcFile, err
	}

	lines := strings.Split(string(data), "\n")
	var kept []string
	skipNext := false
	found := false
	for _, l := range lines {
		if skipNext {
			skipNext = false
			found = true
			continue
		}
		if strings.TrimSpace(l) == "# Gen-Harness (genh)" {
			skipNext = true
			found = true
			continue
		}
		kept = append(kept, l)
	}
	if !found {
		return false, rcFile, nil
	}

	if err := os.WriteFile(rcFile, []byte(strings.Join(kept, "\n")), 0o644); err != nil {
		return false, rcFile, err
	}
	return true, rcFile, nil
}
