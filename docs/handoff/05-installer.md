# 05 · Trình cài đặt một lệnh (TUI)

## Mục tiêu

- **Một lệnh duy nhất** trên mỗi hệ điều hành.
- **Không ỷ lại môi trường sẵn có.** Máy người dùng chỉ được giả định có shell mặc định (`sh` trên Linux/macOS, PowerShell 5.1 trên Windows 10/11) và kết nối mạng. Không cần có sẵn Docker, git, curl-plugin, Python, Node, psql, make hay bất kỳ công cụ nào khác.
- **TUI chuyên nghiệp:** một khung gọn, thanh tiến độ tổng có %, danh sách bước có trạng thái, không trút log thô ra màn hình.
- Kết thúc bằng việc **mở trình duyệt vào trình thiết lập Owner** (`docs/06`).

## Lệnh cài

```sh
# Linux · macOS
curl -fsSL https://github.com/<owner>/Gen-Harness/releases/latest/download/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://github.com/<owner>/Gen-Harness/releases/latest/download/install.ps1 | iex
```

Nếu máy Linux tối giản không có `curl`, `install.sh` cũng chạy được bằng `wget -qO- … | sh`; README ghi cả hai.

## Hai tầng

**1. Bootstrap (`install.sh` / `install.ps1`, ≤ 150 dòng mỗi tệp)** — việc duy nhất là lấy về binary `genh` đúng nền tảng và chạy nó.

- Phát hiện OS + kiến trúc: `linux-amd64`, `linux-arm64`, `darwin-amd64`, `darwin-arm64`, `windows-amd64`, `windows-arm64`.
- Tải `genh-<os>-<arch>` từ GitHub Releases vào `~/.gen-harness/bin/` (Windows: `%LOCALAPPDATA%\GenHarness\bin\`).
- **Kiểm SHA-256** theo `checksums.txt` của cùng bản phát hành, và chữ ký cosign nếu có. Sai → dừng, không chạy.
- Thêm thư mục vào PATH của người dùng (không cần quyền admin).
- `exec genh install` — từ đây TUI tiếp quản.

**2. `genh` (Go, binary tĩnh, `CGO_ENABLED=0`)** — nhúng sẵn `compose.yaml`, cấu hình Caddy, và mọi thứ cần để dựng hệ thống. Tự mang theo hoặc tự tải **có kiểm checksum** mọi công cụ nó cần, đặt trong `~/.gen-harness/` — không ghi đè công cụ sẵn có của người dùng.

## Container runtime — tự cung cấp

| Hệ điều hành | Có sẵn Docker hợp lệ | Không có |
|---|---|---|
| Linux | Dùng nếu Engine ≥ 24 và Compose v2 | Cài **Docker Engine rootless** vào `~/.gen-harness/runtime` (binary tĩnh từ download.docker.com + `rootlesskit`), systemd user service. Chỉ dùng `sudo` cho bước bắt buộc (`newuidmap`), hỏi trước, giải thích lý do |
| macOS | Dùng nếu Docker Desktop / OrbStack / Colima đang chạy | Tải **Colima + Lima + docker CLI + compose plugin** bản tĩnh vào `~/.gen-harness/runtime`, tạo VM `gen-harness` (4 CPU, 6 GB RAM, 60 GB đĩa — điều chỉnh theo máy) |
| Windows | Dùng nếu Docker Desktop đang chạy | Bật **WSL2** (cần UAC một lần, có thể cần khởi động lại — trình cài tự tiếp tục sau khi đăng nhập lại qua RunOnce), nhập bản phân phối tối giản `gen-harness` (rootfs Alpine đóng gói kèm bản phát hành) chứa Docker Engine; `genh.exe` điều khiển qua `wsl -d gen-harness` |

Compose luôn dùng **bản compose plugin do `genh` mang theo**, không phụ thuộc bản của người dùng. Mọi công cụ khác (psql, pg_dump, mc, openssl…) chạy **bên trong container**.

## Các bước và trọng số tiến độ

% tổng = tổng có trọng số của % từng bước. Bước tải image tính theo **byte thật của các layer** (đọc tiến độ từ Docker API), không đoán.

| # | Bước | Trọng số | Nội dung |
|---|---|---|---|
| 1 | Kiểm tra máy | 3% | OS, kiến trúc, RAM ≥ 4 GB (khuyến nghị 8), đĩa trống ≥ 20 GB, cổng 8443 rảnh, kết nối mạng, đồng hồ hệ thống |
| 2 | Chuẩn bị container runtime | 17% | Như bảng trên. Bỏ qua (tính xong ngay) nếu đã có runtime hợp lệ |
| 3 | Tải image | 50% | `db`, `redis`, `objects`, `proxy`, `api`, `web`, `bridge` — tải song song, hiển thị MB/s và thời gian còn lại |
| 4 | Sinh bí mật & cấu hình | 3% | Khoá master, mật khẩu DB, khoá MinIO, khoá backup, CA TLS nội bộ, setup token một lần. Ghi `~/.gen-harness/config/` quyền 600 |
| 5 | Khởi động dữ liệu | 8% | `db`, `redis`, `objects` → chờ healthy |
| 6 | Tạo cấu trúc dữ liệu | 9% | Chạy migration trong container `api` (tiến độ theo số migration) |
| 7 | Khởi động dịch vụ | 6% | `api`, `worker`, `bridge`, `web`, `proxy` → chờ `/api/ready` |
| 8 | Hoàn tất | 4% | Tin cậy CA (hỏi), tạo lối tắt, mở trình duyệt `https://localhost:8443/setup?token=…`, **v0.1.5:** bật `genh auto-update` (tắt bằng `--no-auto-update` lúc cài — xem README mục "Nâng cấp") |

## Giao diện TUI

Khung 76 cột, căn giữa, viền bo. Màu lấy từ token Nocturne (accent `#9184d9`, OK/WARN/BAD như `docs/02`), tự tắt màu khi `NO_COLOR` hoặc terminal không hỗ trợ.

```
╭──────────────────────────────────────────────────────────────────────────╮
│  GEN-HARNESS  ·  Genesis Harness OS  v2.2.0                              │
│  Đang cài đặt vào ~/.gen-harness                                         │
│                                                                          │
│  ██████████████████████████████░░░░░░░░░░░░░░░░░░░░░░   58%   ~2 phút   │
│                                                                          │
│  ✓  Kiểm tra máy                     8 GB RAM · 112 GB trống      0:02   │
│  ✓  Chuẩn bị container runtime       Docker Engine 27.1 (sẵn có)  0:01   │
│  ⠼  Tải image                        412 / 690 MB · 18.4 MB/s            │
│       api      ███████████████████░░░  86%                               │
│       bridge   ████████████░░░░░░░░░░  54%                               │
│       db       ██████████████████████  xong                              │
│  ·  Sinh bí mật & cấu hình                                               │
│  ·  Khởi động dữ liệu                                                    │
│  ·  Tạo cấu trúc dữ liệu                                                 │
│  ·  Khởi động dịch vụ                                                    │
│  ·  Hoàn tất                                                             │
│                                                                          │
│  l  xem log     q  huỷ an toàn                                           │
╰──────────────────────────────────────────────────────────────────────────╯
```

- Trạng thái bước: `·` chờ · spinner đang chạy · `✓` xong (OK) · `!` cảnh báo (WARN, vẫn tiếp tục) · `✕` lỗi (BAD).
- Dòng con chỉ hiện ở bước đang chạy, tối đa 4 dòng.
- `l` mở khung log cuộn (tail 200 dòng); log đầy đủ luôn ghi vào `~/.gen-harness/logs/install-<timestamp>.log`.
- `q` huỷ an toàn: dừng container đã tạo, giữ image đã tải để lần sau nhanh hơn.
- Không có TTY (CI, pipe): tự chuyển sang chế độ dòng — mỗi bước một dòng `[ 58%] Tải image 412/690 MB` — cùng mã thoát.

Màn kết thúc:

```
╭──────────────────────────────────────────────────────────────────────────╮
│  ✓  Gen-Harness đã sẵn sàng                                  4 phút 12s  │
│                                                                          │
│     Mở trình thiết lập:  https://localhost:8443/setup                    │
│     Mã thiết lập:        K7QF-2MXD-9PLA    (hết hạn sau 24 giờ)          │
│                                                                          │
│     Đã mở trình duyệt. Nếu chưa thấy, bấm vào đường dẫn trên.            │
│                                                                          │
│     genh status    trạng thái        genh logs     xem log               │
│     genh update    cập nhật          genh backup   sao lưu               │
╰──────────────────────────────────────────────────────────────────────────╯
```

## Lỗi

Mỗi lỗi hiện: **chuyện gì xảy ra · vì sao · làm gì tiếp**, kèm mã lỗi tra được (`GH-E0xx`) và nút `r` thử lại bước đó. Ví dụ:

```
✕  Khởi động dịch vụ
   Cổng 8443 đang bị tiến trình khác dùng (pid 4412, nginx).
   Chọn cổng khác:  genh install --port 9443     hoặc dừng tiến trình đó rồi bấm r.
   GH-E021 · log: ~/.gen-harness/logs/install-20260923-2103.log
```

Mọi bước **idempotent**: chạy lại `genh install` sau lỗi tiếp tục từ bước dở, không tạo lại bí mật đã có, không xoá dữ liệu.

## Lệnh vận hành

| Lệnh | Việc |
|---|---|
| `genh status` | Bảng dịch vụ + healthy + phiên bản + dung lượng dữ liệu |
| `genh open` | Mở Console |
| `genh logs [dịch vụ] [-f]` | Log gọn, có màu theo mức |
| `genh update [--channel stable\|beta] [--yes] [--quiet] [--no-self-update]` | **v0.1.5:** tự hỏi bản `genh` mới nhất trên GitHub Releases (`/repos/<owner>/<repo>/releases/latest`), kiểm SHA-256, thay binary rồi RE-EXEC bằng code mới (`internal/selfupdate`), rồi mới backup tự động, migrate, khởi động lại theo thứ tự; lỗi ở bất kỳ bước nào → tự rollback. `--yes`/không có TTY: không hỏi gì (hiện tại `RunUpdate` vốn không hỏi gì, cờ này dành cho lịch tự động + tương lai). `--quiet`: chỉ in dòng quan trọng. `--no-self-update`: chỉ nâng cấp dịch vụ, không đụng binary |
| `genh auto-update enable\|disable\|status` | **v0.1.5:** bật/tắt/kiểm lịch tự chạy `genh update --yes --quiet` mỗi đêm ~03:00 giờ máy (`internal/autoupdate`) — systemd `--user` timer (fallback crontab) trên Linux, LaunchAgent trên macOS, Task Scheduler trên Windows. `genh install` tự bật mặc định (tắt bằng `--no-auto-update`) |
| `genh backup [--to path]` / `genh restore <file>` | Chạy trong container |
| `genh export --to <file>` / `genh import <file> [--yes]` | Gói hồ sơ Owner `.ghbundle` (CSDL + object + bí mật, mã hoá) — chuyển sang máy khác (v0.1.1 §1b/2b, `docs/reports/HANDOFF-v0.1.1.md`) |
| `genh doctor` | Chẩn đoán: runtime, cổng, chứng chỉ, dung lượng, đồng hồ, kết nối kênh — xuất báo cáo zip để gửi hỗ trợ |
| `genh reset-setup` | Sinh mã thiết lập mới (cần xác nhận) |
| `genh stop` / `genh start` | |
| `genh uninstall [--keep-data]` | Gỡ sạch container, runtime do genh cài, lối tắt, PATH; hỏi trước khi xoá dữ liệu |

## Phát hành

**Từ v0.1.4: phát hành = tăng `VERSION` trong PR, merge vào main.** Không còn bước tay nào khác (không tự tạo tag, không tự bấm "Draft a release" trên web) — agent code không tạo được tag qua proxy, nên `.github/workflows/release.yml` (job `meta`) đọc thẳng tệp `VERSION` ở gốc repo mỗi lần có push vào `main`:
- Nếu tag ứng với version đó **chưa tồn tại** trên remote → chạy toàn bộ pipeline phát hành (build 6 nền tảng, build+push image, sinh Release, tự tạo tag `vX.Y.Z` trỏ đúng commit vừa merge).
- Nếu tag **đã tồn tại** (PR merge không đổi `VERSION`) → job `meta` trả `skip=true`, mọi job khác bỏ qua — không publish lại, không tạo Release trùng.
- Tag do workflow tự tạo (`softprops/action-gh-release`, ký bằng `GITHUB_TOKEN`) sẽ **không** tự kích hoạt lại `release.yml` — đúng ý, tránh chạy 2 lần vì chính tag mình vừa tạo.
- Đẩy tag `v*` bằng tay (hiếm dùng, vd. khôi phục sau sự cố) vẫn hoạt động như trước — job `meta` nhận version từ tag đó thay vì đọc `VERSION`.
- CI (`ci.yml`, job `version`) kiểm định dạng `VERSION` (`vMAJOR.MINOR.PATCH[-PRERELEASE]`) ngay từ PR, không đợi tới lúc chạy trên main mới phát hiện sai.
- GitHub Actions: build `genh` cho 6 nền tảng, build + push image đa kiến trúc (`linux/amd64`, `linux/arm64`) lên GHCR, sinh `checksums.txt`, ký bằng cosign keyless, đính `install.sh`, `install.ps1`, rootfs WSL vào Release.
- Image gắn tag theo phiên bản; `compose.yaml` nhúng trong `genh` ghim đúng digest của bản phát hành đó.
- Job `verify-docker-pins` tải lại 4 tệp Docker Engine tĩnh đã ghim SHA-256 trong `apps/genh/internal/runtime/bootstrap_linux.go` (xem mục "Docker Engine tĩnh trên Linux" bên dưới) và so sha256 mỗi lần release — fail sớm nếu Docker thay nội dung tệp mà không đổi tên.

## Docker Engine tĩnh trên Linux (bootstrap tự cài)

`apps/genh/internal/runtime/bootstrap_linux.go` tự tải Docker Engine tĩnh (`docker-<version>.tgz` + `docker-rootless-extras-<version>.tgz`) từ `download.docker.com` khi máy Linux chưa có Docker hợp lệ. Docker **không** phát hành tệp `SHA256SUMS` trong thư mục `linux/static/stable/<arch>/` (đã xác minh: trả 404, thư mục chỉ có các `*.tgz`) — nên thay vì tải tệp checksum đó (bug GH-E021, khiến `genh install` luôn lỗi trên máy Linux sạch), SHA-256 của từng gói/kiến trúc được **ghim cứng** trong biến `dockerStaticChecksums`.

Cập nhật khi nâng `dockerStaticVersion`: tải cả 4 tệp (2 kiến trúc × 2 gói) từ `https://download.docker.com/linux/static/stable/<arch>/`, tính `sha256sum`, dán vào bảng — rồi để job `verify-docker-pins` (release.yml) xác nhận lại trên CI.

## Kiểm thử trình cài

Ma trận CI: Ubuntu 22.04/24.04, Debian 12, Fedora 40 (có và không có Docker), macOS 14 arm64 (không Docker), Windows 11 (không Docker, WSL tắt sẵn). Mỗi ô: cài sạch → `/api/ready` xanh → `genh update` → `genh uninstall`. Kiểm tra thêm: mất mạng giữa chừng rồi chạy lại, cổng bận, đĩa đầy.
