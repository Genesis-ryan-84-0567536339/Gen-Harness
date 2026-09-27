package ops

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/term"

	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/compose"
	"github.com/Genesis-ryan-84-0567536339/gen-harness/apps/genh/internal/dockercli"
)

// Gói hồ sơ .ghbundle — HỢP ĐỒNG với một agent Python khác đang viết
// `python -m gh.bundle` (xem docs mục "Gói hồ sơ .ghbundle"): genh chỉ gọi
// vào hai lệnh con qua `docker compose exec`, KHÔNG biết/không cần biết định
// dạng bytes bên trong gói (mã hoá bằng mật khẩu Owner tự chọn, khác hẳn
// GH_MASTER_KEY dùng cho `genh backup`/`genh restore` — xem backupcore.go).
//
//   - `python -m gh.bundle export --out -`  : gói ra STDOUT, log ra STDERR.
//   - `python -m gh.bundle import --in -`   : gói đọc từ STDIN.
//   - Mật khẩu truyền qua biến môi trường GH_BUNDLE_PASSWORD (KHÔNG qua argv
//     — argv của tiến trình con hiện ra trong `ps`/log hệ thống, môi trường
//     của một tiến trình không-con thì không).
//   - Mã thoát: 0 ok · 1 lỗi khác · 2 sai mật khẩu/gói hỏng · 3 gói không
//     tương thích (phiên bản gh.bundle khác).
const (
	bundleMagic          = "GHBUNDLE1\n"
	bundlePasswordEnv    = "GH_BUNDLE_PASSWORD"
	minBundlePasswordLen = 12
)

// bundleServiceName là service compose chạy `python -m gh.bundle` — cùng
// container với gh.backup (backupServiceName ở backupcore.go): cần đọc
// GH_DATABASE_URL/khoá bí mật runtime đã mount sẵn ở container api đang
// sống, không phải một container `run` mới.
const bundleServiceName = backupServiceName

// readSecretLine đọc MỘT dòng ẩn (không echo) từ terminal thật — tách ra
// thành một biến thay vì gọi thẳng term.ReadPassword để test tiêm giả (sandbox
// test không có TTY thật để gõ mật khẩu).
var readSecretLine = func() (string, error) {
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// resolveBundlePassword lấy mật khẩu gói .ghbundle: ưu tiên biến môi trường
// GH_BUNDLE_PASSWORD (dùng cho script/test, xem hợp đồng ở trên) — nếu có,
// KHÔNG hỏi gì thêm, kể cả khi confirm=true (env đã là một giá trị chắc
// chắn, hỏi lại hai lần chỉ có ý nghĩa khi Owner tự gõ). Nếu không có, hỏi
// ẩn qua readSecretLine: một lần khi confirm=false (import — chỉ cần đúng
// mật khẩu đã dùng lúc export), hai lần khi confirm=true (export — gõ sai
// một lần là mất khả năng đọc lại gói, phải bắt khớp trước khi dùng).
func resolveBundlePassword(out io.Writer, confirm bool, shortCode string) (string, error) {
	if v := os.Getenv(bundlePasswordEnv); v != "" {
		if len(v) < minBundlePasswordLen {
			return "", &OpError{
				Code: shortCode,
				What: fmt.Sprintf("Mật khẩu qua biến %s quá ngắn", bundlePasswordEnv),
				Why:  fmt.Sprintf("cần ít nhất %d ký tự, %s hiện có %d ký tự", minBundlePasswordLen, bundlePasswordEnv, len(v)),
				Next: fmt.Sprintf("Đặt %s dài hơn (≥%d ký tự) rồi thử lại.", bundlePasswordEnv, minBundlePasswordLen),
			}
		}
		return v, nil
	}

	_, _ = fmt.Fprintf(out, "Mật khẩu gói .ghbundle (ẩn, ≥%d ký tự): ", minBundlePasswordLen)
	p1, err := readSecretLine()
	_, _ = fmt.Fprintln(out)
	if err != nil {
		return "", &OpError{
			Code: shortCode,
			What: "Không đọc được mật khẩu từ terminal",
			Why:  err.Error(),
			Next: fmt.Sprintf("Chạy trong terminal thật (có TTY), hoặc đặt biến %s để bỏ qua hỏi mật khẩu (script/CI).", bundlePasswordEnv),
			Err:  err,
		}
	}
	if len(p1) < minBundlePasswordLen {
		return "", &OpError{
			Code: shortCode,
			What: "Mật khẩu quá ngắn",
			Why:  fmt.Sprintf("cần ít nhất %d ký tự, bạn gõ %d ký tự", minBundlePasswordLen, len(p1)),
			Next: "Gõ lại một mật khẩu dài hơn.",
		}
	}
	if !confirm {
		return p1, nil
	}

	_, _ = fmt.Fprint(out, "Gõ lại mật khẩu để xác nhận: ")
	p2, err := readSecretLine()
	_, _ = fmt.Fprintln(out)
	if err != nil {
		return "", &OpError{
			Code: shortCode,
			What: "Không đọc được mật khẩu xác nhận từ terminal",
			Why:  err.Error(),
			Next: fmt.Sprintf("Chạy trong terminal thật (có TTY), hoặc đặt biến %s để bỏ qua hỏi mật khẩu (script/CI).", bundlePasswordEnv),
			Err:  err,
		}
	}
	if p1 != p2 {
		return "", &OpError{
			Code: shortCode,
			What: "Hai lần gõ mật khẩu không khớp",
			Next: "Chạy lại `genh export` và gõ đúng cùng một mật khẩu cả hai lần.",
		}
	}
	return p1, nil
}

// ExportDeps cho phép tiêm dockercli.Runner giả khi test — không có cách
// tiêm readSecretLine qua đây (nó là biến gói dùng chung với import, test tự
// đổi giá trị rồi khôi phục, xem bundle_test.go).
type ExportDeps struct {
	Runner dockercli.Runner
}

// RunExport chạy `python -m gh.bundle export --out -` trong container api,
// stream bytes stdout THẲNG vào một tệp tạm cạnh toPath rồi rename — KHÔNG
// bao giờ đọc cả gói vào RAM (gói có thể rất lớn, chứa toàn bộ dữ liệu Owner).
func RunExport(ctx context.Context, env *Env, toPath string, deps ExportDeps, out io.Writer) error {
	runner := deps.Runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}

	password, err := resolveBundlePassword(out, true, ErrCodeExportPasswordMismatch)
	if err != nil {
		return err
	}

	composePath, err := env.LocatePath()
	if err != nil {
		return err
	}
	bundle, err := env.LoadSecrets()
	if err != nil {
		return err
	}
	envOverlay := append(append([]string{}, EnvOverlay(bundle)...), bundlePasswordEnv+"="+password)
	dir := composeDir(composePath)

	args := compose.BaseArgs(composePath, "exec", "-T", "-e", bundlePasswordEnv, bundleServiceName, "python", "-m", "gh.bundle", "export", "--out", "-")

	absTo, err := filepath.Abs(toPath)
	if err != nil {
		return &OpError{
			Code: ErrCodeExportWriteFailed,
			What: "Đường dẫn --to không hợp lệ",
			Why:  err.Error(),
			Next: "Dùng một đường dẫn tệp hợp lệ cho --to.",
			Err:  err,
		}
	}
	tmpPath := absTo + ".tmp-genh-export"
	tmpFile, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return &OpError{
			Code: ErrCodeExportWriteFailed,
			What: "Không tạo được tệp tạm cạnh " + toPath,
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục chứa " + toPath + " rồi thử lại.",
			Err:  err,
		}
	}

	_, _ = fmt.Fprintln(out, "Đang xuất gói .ghbundle…")
	runErr := runner.RunIO(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: envOverlay, Dir: dir}, nil, tmpFile)
	closeErr := tmpFile.Close()

	if runErr != nil {
		_ = os.Remove(tmpPath)
		return &OpError{
			Code: ErrCodeExportFailed,
			What: "`python -m gh.bundle export` thất bại",
			Why:  runErr.Error(),
			Next: "Kiểm `genh status` (db phải healthy) rồi thử lại `genh export --to " + toPath + "`.",
			Err:  runErr,
		}
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return &OpError{
			Code: ErrCodeExportWriteFailed,
			What: "Ghi tệp tạm " + tmpPath + " thất bại",
			Why:  closeErr.Error(),
			Next: "Kiểm dung lượng đĩa còn trống rồi thử lại.",
			Err:  closeErr,
		}
	}
	if err := os.Rename(tmpPath, absTo); err != nil {
		_ = os.Remove(tmpPath)
		return &OpError{
			Code: ErrCodeExportWriteFailed,
			What: "Không đổi tên tệp tạm thành " + toPath,
			Why:  err.Error(),
			Next: "Kiểm quyền ghi thư mục chứa " + toPath + " rồi thử lại.",
			Err:  err,
		}
	}
	if err := os.Chmod(absTo, 0o600); err != nil {
		_, _ = fmt.Fprintln(out, "Cảnh báo: không đặt được quyền 0600 cho "+absTo+": "+err.Error())
	}

	_, _ = fmt.Fprintln(out, "Xuất gói xong: "+absTo)
	return nil
}

// ImportOptions là các cờ đã phân tích của `genh import`.
type ImportOptions struct {
	AutoApprove bool // --yes: bỏ qua hỏi xác nhận GHI ĐÈ
}

// ImportDeps cho phép tiêm dockercli.Runner/http.Client giả + thời gian chờ
// ngắn hơn khi test (cùng vai trò UpdateDeps ở update.go — RunImport dùng lại
// waitReady sau khi restart api/worker).
type ImportDeps struct {
	Runner    dockercli.Runner
	Client    *http.Client
	Timeout   time.Duration
	PollEvery time.Duration
}

// validateBundleFile mở path, kiểm tồn tại + không phải thư mục + bắt đầu
// bằng bundleMagic ("GHBUNDLE1\n") — trả về *os.File đã seek về đầu (sẵn
// sàng dùng làm stdin của `gh.bundle import`) nếu hợp lệ.
func validateBundleFile(path string) (*os.File, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, &OpError{
			Code: ErrCodeImportNotBundle,
			What: "Không tìm thấy tệp gói .ghbundle",
			Why:  err.Error(),
			Next: "Kiểm đường dẫn " + path + " rồi thử lại.",
			Err:  err,
		}
	}
	if info.IsDir() {
		return nil, &OpError{
			Code: ErrCodeImportNotBundle,
			What: path + " là một thư mục, không phải tệp gói .ghbundle",
			Next: "Trỏ đúng tệp .ghbundle do `genh export` tạo ra.",
		}
	}

	f, err := os.Open(path)
	if err != nil {
		return nil, &OpError{
			Code: ErrCodeImportNotBundle,
			What: "Không mở được " + path,
			Why:  err.Error(),
			Next: "Kiểm quyền đọc tệp rồi thử lại.",
			Err:  err,
		}
	}

	magic := make([]byte, len(bundleMagic))
	if _, err := io.ReadFull(bufio.NewReader(f), magic); err != nil || string(magic) != bundleMagic {
		_ = f.Close()
		why := fmt.Sprintf("không bắt đầu bằng %q", bundleMagic)
		if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
			why = err.Error()
		}
		return nil, &OpError{
			Code: ErrCodeImportNotBundle,
			What: path + " không phải một gói .ghbundle hợp lệ",
			Why:  why,
			Next: "Kiểm bạn trỏ đúng tệp do `genh export` tạo ra, chưa bị sửa/cắt bớt.",
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		_ = f.Close()
		return nil, &OpError{
			Code: ErrCodeImportNotBundle,
			What: "Không đọc lại được " + path + " từ đầu",
			Why:  err.Error(),
			Next: "Thử lại; nếu vẫn lỗi, kiểm tệp có nằm trên một hệ tệp hỗ trợ seek (không phải pipe/FIFO).",
			Err:  err,
		}
	}
	return f, nil
}

// RunImport khôi phục một gói .ghbundle: kiểm tệp hợp lệ, cảnh báo GHI ĐÈ +
// hỏi xác nhận (trừ --yes), backup AN TOÀN vào ObjectStore nội bộ TRƯỚC khi
// đụng gì (dùng lại runBackupInContainer — cùng logic `genh backup`/rollback
// của `genh update`), rồi chạy `python -m gh.bundle import --in -` với chính
// tệp làm stdin (không đọc vào RAM). Thành công → restart api/worker + đợi
// healthy, giống hệt bước cuối của `genh update`.
func RunImport(ctx context.Context, env *Env, path string, opts ImportOptions, deps ImportDeps, in io.Reader, out io.Writer) error {
	runner := deps.Runner
	if runner == nil {
		runner = dockercli.ExecRunner{}
	}
	client := deps.Client
	if client == nil {
		client = insecureLocalClient(5 * time.Second)
	}
	timeout := deps.Timeout
	if timeout <= 0 {
		timeout = defaultUpdateReadyTimeout
	}
	pollEvery := deps.PollEvery
	if pollEvery <= 0 {
		pollEvery = defaultUpdatePollEvery
	}

	f, err := validateBundleFile(path)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()

	_, _ = fmt.Fprintln(out, "CẢNH BÁO: import sẽ GHI ĐÈ toàn bộ dữ liệu hiện tại của Gen-Harness bằng nội dung trong gói "+path+".")
	if !opts.AutoApprove {
		_, _ = fmt.Fprintln(out, "Tiếp tục? [y/N]")
		if !confirmYesNo(in) {
			return &OpError{
				Code: ErrCodeImportCancelled,
				What: "Đã huỷ — không import gì cả, dữ liệu hiện tại còn nguyên",
				Next: "Chạy lại `genh import " + path + "` (hoặc kèm --yes) khi chắc chắn.",
			}
		}
	}

	password, err := resolveBundlePassword(out, false, ErrCodeImportPasswordInvalid)
	if err != nil {
		return err
	}

	composePath, err := env.LocatePath()
	if err != nil {
		return err
	}
	bundle, err := env.LoadSecrets()
	if err != nil {
		return err
	}
	envOverlay := EnvOverlay(bundle)
	dir := composeDir(composePath)

	_, _ = fmt.Fprintln(out, "1/2 Backup an toàn trước khi import…")
	key, err := runBackupInContainer(ctx, runner, composePath, envOverlay, dir)
	if err != nil {
		return &OpError{
			Code: ErrCodeImportBackupFailed,
			What: "Backup an toàn trước khi import thất bại — DỪNG LẠI, chưa đụng gì",
			Why:  err.Error(),
			Next: "Kiểm `genh status` (db phải healthy) rồi thử lại `genh import " + path + "`.",
			Err:  err,
		}
	}
	_, _ = fmt.Fprintln(out, "     backup an toàn: "+key)
	restoreHint := "`docker compose exec -T " + bundleServiceName + " python -m gh.backup restore --key " + key + "` rồi `docker compose up -d`"

	_, _ = fmt.Fprintln(out, "2/2 Import gói…")
	args := compose.BaseArgs(composePath, "exec", "-T", "-e", bundlePasswordEnv, bundleServiceName, "python", "-m", "gh.bundle", "import", "--in", "-")
	importEnv := append(append([]string{}, envOverlay...), bundlePasswordEnv+"="+password)
	runErr := runner.RunIO(ctx, dockercli.Cmd{Name: "docker", Args: args, Env: importEnv, Dir: dir}, f, out)

	if runErr != nil {
		var exitErr *dockercli.ExitError
		if errors.As(runErr, &exitErr) {
			switch exitErr.Code {
			case 2:
				return &OpError{
					Code: ErrCodeImportWrongPassword,
					What: "Sai mật khẩu gói .ghbundle, hoặc gói bị hỏng",
					Why:  runErr.Error(),
					Next: "Kiểm đúng mật khẩu đã dùng lúc `genh export` và tệp gói còn nguyên vẹn. Dữ liệu hiện tại KHÔNG bị mất — backup an toàn " + key + " vẫn còn; khôi phục về trước import nếu cần: " + restoreHint + ".",
					Err:  runErr,
				}
			case 3:
				return &OpError{
					Code: ErrCodeImportIncompatible,
					What: "Gói .ghbundle không tương thích với phiên bản Gen-Harness hiện tại",
					Why:  runErr.Error(),
					Next: "Dùng bản genh/gh.bundle cùng phiên bản đã tạo gói này. Dữ liệu hiện tại KHÔNG bị mất — backup an toàn " + key + " vẫn còn; khôi phục về trước import nếu cần: " + restoreHint + ".",
					Err:  runErr,
				}
			default:
				return &OpError{
					Code: ErrCodeImportFailed,
					What: "`python -m gh.bundle import` thất bại",
					Why:  runErr.Error(),
					Next: "Xem log ở trên. Dữ liệu hiện tại KHÔNG bị mất — backup an toàn " + key + " vẫn còn; khôi phục về trước import nếu cần: " + restoreHint + ".",
					Err:  runErr,
				}
			}
		}
		return &OpError{
			Code: ErrCodeImportFailed,
			What: "Không chạy được `python -m gh.bundle import`",
			Why:  runErr.Error(),
			Next: "Kiểm Gen-Harness đang chạy (`genh status`). Dữ liệu hiện tại KHÔNG bị mất — backup an toàn " + key + " vẫn còn; khôi phục về trước import nếu cần: " + restoreHint + ".",
			Err:  runErr,
		}
	}

	_, _ = fmt.Fprintln(out, "     import xong, khởi động lại api/worker…")
	restartArgs := compose.BaseArgs(composePath, "restart", "api", "worker")
	if _, err := runner.Output(ctx, dockercli.Cmd{Name: "docker", Args: restartArgs, Env: envOverlay, Dir: dir}); err != nil {
		return &OpError{
			Code: ErrCodeImportRestartFailed,
			What: "Import xong nhưng `docker compose restart api worker` thất bại",
			Why:  err.Error(),
			Next: "Chạy tay `docker compose restart api worker` rồi kiểm `genh status`. Dữ liệu ĐÃ import — backup an toàn trước đó (" + key + ") vẫn còn nếu cần quay lại.",
			Err:  err,
		}
	}

	readyURL := localURL(env.Port, readyPath)
	if err := waitReady(ctx, client, readyURL, timeout, pollEvery); err != nil {
		return &OpError{
			Code: ErrCodeImportRestartFailed,
			What: readyPath + " không trả 200 sau khi import + khởi động lại",
			Why:  err.Error(),
			Next: "Xem `docker compose logs api worker`. Dữ liệu ĐÃ import — backup an toàn trước đó (" + key + ") vẫn còn nếu cần quay lại.",
			Err:  err,
		}
	}

	_, _ = fmt.Fprintln(out, "Import xong, dịch vụ đã sẵn sàng. (backup an toàn trước import: "+key+")")
	return nil
}
