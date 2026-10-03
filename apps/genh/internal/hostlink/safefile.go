package hostlink

import (
	"errors"
	"fmt"
	"io"
	"os"
)

// maxStateFileBytes giới hạn kích thước tệp trạng thái genh đọc từ run/ — các
// tệp genh tự ghi chỉ vài trăm byte.
const maxStateFileBytes = 64 << 10

// errUnsafeStateFile: tệp trong run/ không phải tệp thường genh có thể tin
// (symlink, thiết bị, FIFO, nhiều hard link, quá lớn, sai chủ).
var errUnsafeStateFile = errors.New("tệp trạng thái không an toàn")

// readStateFile đọc một tệp trạng thái trong run/ AN TOÀN: run/ bind-mount vào
// container api (2770 nhóm 10001 từ v0.1.45; bản cài cũ/macOS có thể còn 0777),
// nên ai ghi được run/ cũng cài được symlink /
// hard link tới tệp bí mật của người chạy genh (~/.ssh/id_*,
// ~/.docker/config.json) hoặc tới /dev/zero. Chỉ nhận tệp THƯỜNG (Lstat — không
// đi theo symlink), một liên kết, ≤ maxStateFileBytes; mở bằng O_NOFOLLOW
// (Unix) rồi đối chiếu lại đúng tệp đã Lstat. requireOwner: tệp phải thuộc uid
// đang chạy genh (Unix) — dùng cho tệp genh tự ghi và tin theo (update-blocked).
// Không có tệp → lỗi bọc os.ErrNotExist như os.ReadFile.
func readStateFile(path string, requireOwner bool) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if err := checkStateFileInfo(fi, requireOwner); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	f, err := openNoFollow(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	fi2, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(fi, fi2) {
		return nil, fmt.Errorf("%s: %w (tệp bị thay giữa chừng)", path, errUnsafeStateFile)
	}
	if err := checkStateFileInfo(fi2, requireOwner); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	b, err := io.ReadAll(io.LimitReader(f, maxStateFileBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxStateFileBytes {
		return nil, fmt.Errorf("%s: %w (quá lớn)", path, errUnsafeStateFile)
	}
	return b, nil
}

func checkStateFileInfo(fi os.FileInfo, requireOwner bool) error {
	if !fi.Mode().IsRegular() {
		return fmt.Errorf("%w (không phải tệp thường)", errUnsafeStateFile)
	}
	if fi.Size() > maxStateFileBytes {
		return fmt.Errorf("%w (quá lớn)", errUnsafeStateFile)
	}
	if links(fi) > 1 {
		return fmt.Errorf("%w (nhiều hard link)", errUnsafeStateFile)
	}
	if requireOwner && !ownedBySelf(fi) {
		return fmt.Errorf("%w (không thuộc người dùng đang chạy genh)", errUnsafeStateFile)
	}
	return nil
}

// errForeignRequest: tệp yêu cầu không do api (uid của container api) hay chính
// người chạy genh tạo — tệp lạ trong hộp thư, bỏ qua.
var errForeignRequest = errors.New("tệp yêu cầu không do Console (api) hay genh tạo")

// readRequestFile đọc một tệp YÊU CẦU trong run/request/ (v0.1.45): như
// readStateFile (tệp thường, 1 liên kết, ≤ 64 KiB, không theo symlink) VÀ chủ
// sở hữu (Unix) phải là người chạy genh hoặc uid của tiến trình api (apiUID —
// mặc định 10001; Docker rootless: uid thật dò được, lưu ở config/hostlink.json).
// Hộp thư run/ từ v0.1.45 là 2770 nhóm 10001 nên chỉ genh và api ghi được; kiểm
// chủ sở hữu là lớp thứ hai (thư mục cũ chưa kịp siết, tiến trình lạ cùng nhóm).
func readRequestFile(installDir, path string) ([]byte, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if err := checkStateFileInfo(fi, false); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if !requestOwnerOK(installDir, fi) {
		return nil, fmt.Errorf("%s: %w", path, errForeignRequest)
	}
	b, err := readStateFile(path, false)
	if err != nil {
		return nil, err
	}
	// readStateFile đã đối chiếu tệp mở được với một lần Lstat của chính nó;
	// kiểm lại chủ trên lần Lstat thứ hai để tệp không bị thay giữa hai lần.
	fi2, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !os.SameFile(fi, fi2) || !requestOwnerOK(installDir, fi2) {
		return nil, fmt.Errorf("%s: %w", path, errForeignRequest)
	}
	return b, nil
}

// requestInfoOK: tệp yêu cầu (đã Lstat) có đủ điều kiện tin không — tệp thường,
// 1 liên kết, ≤ 64 KiB, đúng chủ. Dùng cho update.json (chỉ cần "có yêu cầu").
func requestInfoOK(installDir string, fi os.FileInfo) bool {
	return checkStateFileInfo(fi, false) == nil && requestOwnerOK(installDir, fi)
}
