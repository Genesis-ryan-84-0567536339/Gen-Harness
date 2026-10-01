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
  Mặc định lấy **bản chính thức (latest)** qua `/releases/latest` — bản thử (prerelease) không bao giờ tới máy người dùng.
  Từ v0.1.33 `install.sh` nhận biến tuỳ chọn `GEN_HARNESS_RELEASE_TAG` (chỉ dùng cho CI/E2E) để cài đúng một tag, kể cả bản thử:
  tag phải đúng regex `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`; tag không tồn tại/thiếu asset → báo lỗi dễ hiểu (không
  phải dòng 404 trơ trọi của curl); máy **đã cài** thì chạy `genh update --no-self-update` (không để genh tự thay bản ghim
  bằng `releases/latest`). Test: `apps/genh/cmd/genh/installsh_unix_test.go` (chạy `install.sh` thật với curl/genh giả).
- **Kiểm SHA-256** theo `checksums.txt` của cùng bản phát hành. Chữ ký cosign có ĐÍNH KÈM trên Release nhưng
  `install.sh`/`install.ps1`/`genh` **CHƯA kiểm** (việc sau); sai SHA-256 → dừng, không chạy.
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
| 1 | Kiểm tra máy | 3% | OS, kiến trúc, RAM ≥ 4 GB (khuyến nghị 8), đĩa trống ≥ 5 GB (khuyến nghị 10), cổng 8443 rảnh, kết nối mạng, đồng hồ hệ thống |
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
| `genh update [--channel stable\|beta] [--yes] [--quiet] [--no-self-update]` | **v0.1.5:** tự hỏi bản `genh` mới nhất trên GitHub Releases (`/repos/<owner>/<repo>/releases/latest`), kiểm SHA-256, thay binary rồi RE-EXEC bằng code mới (`internal/selfupdate`), rồi mới nâng cấp dịch vụ theo thứ tự an toàn (xem mục "`genh update` — thứ tự an toàn" ngay dưới bảng). `--yes`: không hỏi gì; không kèm `--if-requested` ⇒ chỉ cài bản genh đã là bản chính thức ≥ 24 giờ (lịch đêm — xem "Cổng phát hành"). Không có TTY mà không `--yes`: cũng không hỏi gì (`RunUpdate` vốn không có bước hỏi) và **không** bị chặn 24 giờ. `--quiet`: chỉ in dòng quan trọng; "genh: cập nhật xong." CHỈ in khi phần nâng cấp dịch vụ thật sự chạy xong (bị hoãn thì dòng kết chứa "đợi đủ 24 giờ", không phải "cập nhật xong."). `--no-self-update`: chỉ nâng cấp dịch vụ, không đụng binary — **v0.1.34:** bỏ qua nếu dịch vụ đã khớp bản genh này (không sao lưu, không tải; in "không cần cập nhật"). **v0.1.33:** `/releases/latest` chỉ trả **bản chính thức** (đã qua E2E) |
| `genh auto-update enable\|disable\|status` | **v0.1.5:** bật/tắt/kiểm lịch tự chạy `genh update --yes --quiet` mỗi đêm ~03:00 giờ máy (`internal/autoupdate`) — systemd `--user` timer (fallback crontab) trên Linux, LaunchAgent trên macOS, Task Scheduler trên Windows. `genh install` tự bật mặc định (tắt bằng `--no-auto-update`) |
| `genh backup [--to path]` / `genh restore <file>` | Chạy trong container |
| `genh export --to <file>` / `genh import <file> [--yes]` | Gói hồ sơ Owner `.ghbundle` (CSDL + object + bí mật, mã hoá) — chuyển sang máy khác (v0.1.1 §1b/2b, `docs/reports/HANDOFF-v0.1.1.md`) |
| `genh doctor` | Chẩn đoán: runtime, cổng, chứng chỉ, dung lượng, đồng hồ, kết nối kênh — xuất báo cáo zip để gửi hỗ trợ |
| `genh reset-setup` | Sinh mã thiết lập mới (cần xác nhận) |
| `genh stop` / `genh start` | |
| `genh uninstall [--keep-data]` | Gỡ sạch container, runtime do genh cài, lối tắt, PATH; hỏi trước khi xoá dữ liệu |

### `genh update` — thứ tự an toàn (v0.1.34, F-10/F-11/F-33)

Trước khi đụng dịch vụ, `cmd/genh` (`decideServiceUpdate`) quyết định có chạy `ops.RunUpdate` không:

- **Bản bị chặn tự cập nhật** — lịch đêm (`--yes` không kèm `--if-requested`) mà `run/update-blocked.json` ghi **đúng** bản genh đang chạy (so khớp chính xác chuỗi version) ⇒ bỏ qua, thoát 0, log: "… lịch đêm không tự thử lại bản này …" (nếu `rollback_failed` thì log nói rõ "tự quay về bản cũ CŨNG THẤT BẠI — cần xử lý tay" + bản sao lưu cần khôi phục khi CSDL đã bị đụng, hoặc chỉ `docker compose up -d --remove-orphans` — KHÔNG khôi phục — khi CSDL chưa bị đụng). Lịch đêm chạy trùng lúc Owner vừa bấm "Cập nhật ngay" (đã nuốt yêu cầu) thì chạy như `--if-requested`, không bị chặn. `run/update-status.json` được trả về như lần lỗi để lại (parse rồi ghi lại đúng các trường genh ghi — không chép nguyên byte; tệp không phải tệp thường/symlink/quá 64 KiB thì bỏ) (không làm mới `finished_at` — thẻ đỏ Console tự hết sau 24 giờ; không ghi đè thông điệp gốc). Có bản genh mới hơn thì vẫn tự cài. Nút **Cập nhật ngay** và gõ tay `genh update` **không** bị chặn.
- **Đã mới nhất** — không vừa tự cập nhật binary, `compose.yaml` **genh quản lý** + `proxy/Caddyfile` đã trùng bản nhúng **và** không còn `run/update-inprogress.json` (`ops.UpdateNeeded` → `compose.InSyncWithEmbedded`) ⇒ không sao lưu, không tải ảnh, log: "… không cần cập nhật …", thoát 0. Compose ngoài (`GENH_COMPOSE_FILE`, checkout repo) **không bao giờ** coi là đã khớp — luôn chạy đủ (genh không biết tệp ngoài đã dựng lên chưa).

`ops.RunUpdate` chạy theo thứ tự:

1. **Kiểm đĩa** — đo chỗ trống ở gốc cài đặt và (Docker gốc trên Linux) `docker info --format {{.DockerRootDir}}`, lấy số nhỏ hơn. Dưới 5 GB (`machine.MinDiskBytes`) ⇒ **dọn ảnh cũ** rồi đo lại; vẫn thiếu ⇒ **GH-E948**, dừng, chưa đụng gì. Đo lỗi ⇒ chỉ cảnh báo. Mỗi lần đo ghi `run/disk-status.json`.
2. **Tải bản mới** TRƯỚC sao lưu — nếu compose sẽ đổi, tải bằng `deploy/compose.update-next.yaml` (bản nhúng, cùng thư mục, xoá ngay sau đó); `compose.yaml` thật chưa đổi. Thử 3 lần, mỗi lần tối đa 20 phút, chờ 20 giây rồi 60 giây giữa các lần. Hết lần ⇒ **GH-E941 "chưa đụng gì"**: không sao lưu, không khôi phục, không `up`; lịch đêm tự thử lại đêm sau.
3. **Dò thay đổi CSDL** — `run --rm --no-deps -T migrate alembic current` bằng ảnh mới; còn revision không phải `(head)`, hoặc tập revision hiện tại khác tập `alembic heads` của ảnh mới (bản mới thêm head riêng), hoặc `alembic current` lỗi — coi như có ⇒ có **migration chờ** ⇒ **tạm dừng worker và bridge** (nguồn ghi) để bản sao lưu không lỡ ghi chép. api **cố ý không dừng** (Console phải chạy để Owner thấy tiến trình): khoảng hở chấp nhận là ghi của api trong vài giây giữa lúc sao lưu xong và lúc migrate — chỉ mất nếu phải khôi phục bản sao lưu đó.
4. **Sao lưu** (`pre-update`). Lỗi ⇒ bật lại worker/bridge, **GH-E940**, chưa đụng gì.
5. Ghi **`run/update-inprogress.json`** rồi **đồng bộ compose.yaml** với bản nhúng (giữ `compose.yaml.bak`), rồi di trú `/tmp/gh-objects` của bản cài cũ nếu có. Lỗi ⇒ trả `compose.yaml` về bản cũ (từ bộ nhớ) + `up -d --remove-orphans`, **không khôi phục CSDL** (chưa bị đụng), giữ mã lỗi gốc (GH-E947/GH-E946).
6. **Migrate** → `up -d --remove-orphans` → chờ `/api/v1/ready` (sẵn sàng ⇒ xoá `update-inprogress.json`). Từ lúc bắt đầu migrate, lỗi nghĩa là **bản này hỏng** (chặn lịch đêm); CSDL chỉ coi là **đã bị đụng** khi bước 3 thấy có migration chờ.
7. **Thành công** ⇒ xoá `run/update-blocked.json`, **dọn ảnh cũ** (giữ ảnh bản hiện tại + bản liền trước), tin cậy lại CA.

**Dấu cập nhật dở (`run/update-inprogress.json`):** genh bị tắt / máy khởi động lại / Ctrl-C sau khi đã ghi compose.yaml mới mà chưa `up -d` xong ⇒ còn dấu ⇒ lần sau (đêm, "Cập nhật ngay", gõ tay) KHÔNG coi "đã khớp", chạy lại đủ. Xoá khi sẵn sàng, hoặc khi đã trả compose.yaml về bản cũ và khởi động lại được.

**Khi nào khôi phục CSDL:** chỉ khi lỗi xảy ra ở bước 6 (migrate/up/ready lỗi) **và có migration chờ**. Quay về bản cũ: ghi lại `compose.yaml` cũ (từ bộ nhớ — không dùng `.bak`, vì `.bak` có thể cũ từ lần trước), dừng api/worker/bridge/web, dựng lại db bằng ảnh **cũ** (`up -d --wait --no-deps db`, tối đa 3 phút — để bản sao lưu được khôi phục bởi đúng ảnh db sẽ chạy tiếp), khôi phục bản sao lưu bằng **container tạm từ ảnh cũ** (`run --rm --no-deps -T api python -m gh.backup restore --key …` — không `exec` vào api ảnh mới đang lỗi), `up -d --remove-orphans`, rồi ghi `run/update-blocked.json` (kể cả khi quay về bản cũ thất bại — kèm `rollback_failed: true`) ⇒ **GH-E945**, thoát 1, log có "rollback". **Không có migration chờ** (worker/bridge/api vẫn ghi suốt từ lúc sao lưu): KHÔNG khôi phục (sẽ mất các ghi đó) — chỉ trả `compose.yaml` cũ + `up -d --remove-orphans`, vẫn ghi `update-blocked.json` ⇒ **GH-E945**.

**Hộp thư Console khi lỗi:** `update-status.json` `message` = `<việc> — <cách xử lý> (GH-E9xx)` (ổ đĩa đầy kèm số GB còn trống; bỏ dấu `` ` ``). Console chọn lời dẫn theo mã: GH-E948 "Ổ đĩa máy chủ sắp đầy — chưa đụng gì" (Owner phải dọn đĩa), GH-E941/GH-E940/GH-E900/GH-E901 "Chưa đụng gì", quay về thất bại "Cần xử lý tay" (ưu tiên trường `blocked_rollback_failed`), GH-E946 sau khi cập nhật xong "Bản mới đã chạy — còn bước chép dữ liệu cũ", "đã tự quay về bản đang dùng" chỉ cho GH-E945/E949/E946/E947 khi thông điệp nói đã quay về, còn lại "Cập nhật chưa xong — xem Chi tiết kỹ thuật"; nguyên văn trong "Chi tiết kỹ thuật". Máy chủ chưa nhận yêu cầu từ nút bấm (`can_request=false`) ⇒ thẻ lỗi hiện lệnh chạy tay thay cho "bấm Thử lại". `GET /system/update` có thêm `blocked_version` và `blocked_rollback_failed` (đọc `update-blocked.json`) — Console không hứa "Tự cài đêm" cho bản đang bị chặn.

**Dọn ảnh cũ:** chỉ repo `ghcr.io/<owner>/gen-harness-*` **có mặt trong các compose được giữ** (không đụng ảnh gen-harness của owner khác dùng chung Docker); giữ mọi ảnh có trong compose hiện tại/bản đích và compose cũ/`.bak`; `docker rmi` từng ảnh (không `-f`, không `docker image prune`); ảnh đang dùng thì bỏ qua. Compose không có ảnh gen-harness (dev/build cục bộ) ⇒ không dọn gì.

**Tệp trạng thái mới trong `run/`** (không chứa bí mật):

| Tệp | Nội dung | Ghi / xoá |
|---|---|---|
| `update-blocked.json` | `{version, blocked_at, code, backup_key?, db_touched, message, rollback_failed?}` | genh ghi khi bản mới lỗi từ bước migrate trở đi (đã quay về bản cũ, hoặc quay về thất bại ⇒ `rollback_failed: true`); `backup_key` chỉ có khi CSDL đã bị đụng (`db_touched`); genh chỉ tin tệp thường của chính uid chạy genh; xoá khi cập nhật thành công |
| `update-inprogress.json` | `{version, backup_key, started_at}` | genh ghi ngay trước khi đổi compose.yaml; xoá khi sẵn sàng / đã trả compose.yaml về bản cũ |
| `disk-status.json` | `{state: ok\|low, free_bytes, min_bytes, path, pruned_images, checked_at}` | genh ghi mỗi lần `genh update` kiểm đĩa (chuông "đĩa sắp đầy" v0.1.36 đọc — giữ tên khoá) |

**Mã lỗi mới:** **GH-E948** — ổ đĩa không đủ chỗ (sau khi đã dọn ảnh cũ), dừng trước khi tải, chưa đụng gì. **GH-E949** — bản đã quay về bản cũ, lịch đêm không thử lại (chỉ dùng cho thông điệp/log, không phải lỗi thoát). GH-E941 nay nghĩa là "tải thất bại, chưa đụng gì"; GH-E945 = bản mới lỗi từ bước migrate trở đi và genh đã tự quay về bản cũ (khôi phục CSDL chỉ khi có migration chờ).

**Ghi tệp trong `run/`:** qua tệp tạm tên ngẫu nhiên (`os.CreateTemp`, O_EXCL) + rename — `run/` để 0777 và bind-mount vào api, tên tạm cố định sẽ cho phép cài sẵn symlink để genh ghi đè tệp ngoài.

## Phát hành

**Từ v0.1.4: phát hành = tăng `VERSION` trong PR, merge vào main.** Không còn bước tay nào khác (không tự tạo tag, không tự bấm "Draft a release" trên web) — agent code không tạo được tag qua proxy, nên `.github/workflows/release.yml` (job `meta`) đọc thẳng tệp `VERSION` ở gốc repo mỗi lần có push vào `main`:
- Nếu tag ứng với version đó **chưa tồn tại** trên remote → chạy toàn bộ pipeline phát hành (build 6 nền tảng, build+push image, sinh Release, tự tạo tag `vX.Y.Z` trỏ đúng commit vừa merge).
- Nếu tag **đã tồn tại** (PR merge không đổi `VERSION`) → job `meta` trả `skip=true`, mọi job khác bỏ qua — không publish lại, không tạo Release trùng.
- Tag do workflow tự tạo (`softprops/action-gh-release`, ký bằng `GITHUB_TOKEN`) sẽ **không** tự kích hoạt lại `release.yml` — đúng ý, tránh chạy 2 lần vì chính tag mình vừa tạo.
- Đẩy tag `v*` bằng tay (hiếm dùng, vd. khôi phục sau sự cố) vẫn hoạt động như trước — job `meta` nhận version từ tag đó thay vì đọc `VERSION`.
- CI (`ci.yml`, job `version`) kiểm định dạng `VERSION` (`vMAJOR.MINOR.PATCH[-PRERELEASE]`) ngay từ PR, không đợi tới lúc chạy trên main mới phát hiện sai. Từ v0.1.33 job này còn chạy `.github/scripts/check_release_gate.py` (kiểm các bất biến của cổng phát hành bên dưới — PR lỡ tay gỡ cổng sẽ đỏ ngay).
- GitHub Actions: build `genh` cho 6 nền tảng, build + push image đa kiến trúc (`linux/amd64`, `linux/arm64`) lên GHCR, sinh `checksums.txt`, ký bằng cosign keyless (tệp `.sig`/`.pem` đính kèm — **chưa nơi nào kiểm chữ ký**, việc sau), đính `install.sh`, `install.ps1`, rootfs WSL vào Release.
- Image gắn tag theo phiên bản (`:<version>`); `compose.yaml` nhúng trong `genh` ghim đúng digest của bản phát hành đó. Từ v0.1.33 tag `:latest` của ảnh **không** gắn lúc build nữa — chỉ job `promote` gắn (`docker buildx imagetools create`) sau khi bản đó thành bản chính thức.
- Job `verify-docker-pins` tải lại 4 tệp Docker Engine tĩnh đã ghim SHA-256 trong `apps/genh/internal/runtime/bootstrap_linux.go` (xem mục "Docker Engine tĩnh trên Linux" bên dưới) và so sha256 mỗi lần release — fail sớm nếu Docker thay nội dung tệp mà không đổi tên.

### Cổng phát hành (từ v0.1.33)

Máy người dùng chỉ nhận bản đã qua CI + E2E cài thật. Tự động hoàn toàn, không cần người duyệt (F-9, `docs/audit/2026-10-01/0-ke-hoach-tong.md`).

1. **CI trước Release.** `release.yml` gọi `ci.yml` thành job `ci` (`uses: ./.github/workflows/ci.yml`, `workflow_call`, input `from_release: true`); job `release` có `ci` trong `needs` — CI đỏ thì không có Release. Khi `from_release` bật, `ci.yml` dùng **nhóm concurrency riêng theo `run_id`** (`cancel-in-progress: false`), nên không huỷ lẫn nhau với lượt CI do chính push vào `main` kích hoạt.
2. **Bản thử (prerelease).** Job `release` tạo Release + tag `vX.Y.Z` ở dạng **prerelease** (`make_latest: false`). `/releases/latest` của GitHub bỏ qua prerelease, nên `genh`, `install.sh` và Console (`apps/api/gh/system_api/update.py`) **chỉ thấy bản đã qua E2E** — bản thử chưa tới máy nào.
3. **E2E đúng tag.** `e2e-install.yml` (`workflow_run` sau Release) tìm **đúng tag** từ `workflow_run.head_sha` (không lấy "bản mới nhất"), cài bằng `install.sh` với `GEN_HARNESS_RELEASE_TAG=<tag>`; job `e2e-upgrade` cài **bản chính thức (latest)** hiện tại rồi nâng cấp lên đúng tag đó. Concurrency theo `head_sha`: lượt Release không tạo tag (VERSION không đổi) không huỷ E2E của bản có tag.
4. **Nâng thành bản chính thức (promote).** `e2e-install` + `e2e-upgrade` xanh → job `promote` chạy **một** lệnh `gh release edit <tag> --prerelease=false --latest --notes-file <ghi chú>` — ghi chú thêm dòng `<!-- genh:promoted_at=<UTC> -->` (dấu thời điểm promote, GitHub không hiện; định dạng = `selfupdate.PromotedMarker`). In `releases/latest` **trước/sau** vào log, `exit 1` nếu sau đó latest không phải tag này hoặc thiếu dấu. Rồi gắn ảnh GHCR `:latest` = `:<tag>` (lỗi chỉ cảnh báo — genh ghim digest, không dùng `:latest`). Bản có hậu tố `-` (vd `v0.2.0-rc.1`) **không bao giờ** được promote; tag có/không hậu tố cùng trỏ một commit thì `resolve` chọn tag không hậu tố.
5. **Promote tay** — chỉ khi E2E lỗi vì lý do **ngoài mã** (mạng, GitHub/GHCR chập chờn): **Actions → E2E cài đặt thật → Run workflow**, nhập `tag` = `vX.Y.Z`, chọn `promote` = true và `skip_e2e` = true. E2E đỏ vì lỗi mã thật → sửa mã, tăng `VERSION`, phát hành bản mới; **không** promote tay.
6. **Thời gian chín 24 giờ** (chỉ lịch đêm). `genh update --yes` **không** kèm `--if-requested` (timer đêm ~03:00) bỏ qua bản chưa là bản chính thức đủ 24 giờ (`selfupdate.NightlyMinAge`), để đêm sau. 24 giờ tính từ **dấu `promoted_at`** trong ghi chú Release (mục 4); không có dấu (bản trước v0.1.33) thì từ `published_at` — lấy mốc muộn hơn. Lý do: `published_at` là lúc tạo **bản thử**, promote không đổi nó — bản thử promote muộn (vd promote tay `skip_e2e` sau vài ngày) mà tính từ `published_at` thì lọt cổng ngay đêm đó. Nút **Cập nhật ngay** trong Console (`--yes --if-requested`) và `genh update` gõ tay không kèm `--yes` **không** bị chặn. `--yes` (chứ không phải một cờ riêng) là cờ kích hoạt cổng vì unit lịch đêm chỉ được ghi lúc `genh install`/`genh auto-update enable` — mọi máy đã cài đều đang chạy `update --yes --quiet`; ai gõ tay `genh update --yes` cũng bị đợi, dòng log nói rõ "chế độ --yes (lịch đêm)" và cách cài ngay. Console (`GET /system/update`, trường `published_at` = mốc trên) ghi trên thẻ "Có bản mới": "Tự cài lúc ~03:00 sau <ngày giờ> — hoặc bấm Cập nhật ngay".
7. **E2E đường tự cập nhật thật (sau promote).** Job `e2e-selfupdate` (needs `promote`, chỉ chạy khi chính lượt đó vừa promote): cài bản chính thức liền trước, (genh cũ ≥ v0.1.33) `genh update --yes --quiet` phải **hoãn** bản vừa promote (log có "đợi đủ 24 giờ", version không đổi, không in "cập nhật xong."), rồi `genh update` (không `--yes`) → genh cũ **tự** tải genh mới qua `releases/latest`, re-exec `--self-updated`, nâng cấp dịch vụ bằng compose nhúng mới → `genh version` = tag, `/api/v1/ready` xanh, ảnh trong `compose.yaml` = `compose.release.yaml` của tag, `app_db_password` không đổi. Đỏ ⇒ `::error` + tóm tắt job ghi cách lùi bản chính thức (`gh release edit <tag> --prerelease=true`, `gh release edit <bản trước> --latest`) — còn trong 24 giờ chín nên chưa máy nào tự cài.

Người bảo trì: merge xong, Release xanh mới chỉ là bản thử. Kiểm `gh api repos/<owner>/Gen-Harness/releases/latest` (hoặc log job `promote`) thấy đúng tag mới rồi mới báo "đã phát hành". Bảo vệ nhánh `main` + tag `v*` (required check `ci-ok`, `installer-ok`) là cài đặt trên GitHub, cần quyền admin — cách bật xem `docs/reports/HANDOFF-v0.1.1.md` mục v0.1.33; mã không phụ thuộc vào nó.

## Docker Engine tĩnh trên Linux (bootstrap tự cài)

`apps/genh/internal/runtime/bootstrap_linux.go` tự tải Docker Engine tĩnh (`docker-<version>.tgz` + `docker-rootless-extras-<version>.tgz`) từ `download.docker.com` khi máy Linux chưa có Docker hợp lệ. Docker **không** phát hành tệp `SHA256SUMS` trong thư mục `linux/static/stable/<arch>/` (đã xác minh: trả 404, thư mục chỉ có các `*.tgz`) — nên thay vì tải tệp checksum đó (bug GH-E021, khiến `genh install` luôn lỗi trên máy Linux sạch), SHA-256 của từng gói/kiến trúc được **ghim cứng** trong biến `dockerStaticChecksums`.

Cập nhật khi nâng `dockerStaticVersion`: tải cả 4 tệp (2 kiến trúc × 2 gói) từ `https://download.docker.com/linux/static/stable/<arch>/`, tính `sha256sum`, dán vào bảng — rồi để job `verify-docker-pins` (release.yml) xác nhận lại trên CI.

## Kiểm thử trình cài

Ma trận CI: Ubuntu 22.04/24.04, Debian 12, Fedora 40 (có và không có Docker), macOS 14 arm64 (không Docker), Windows 11 (không Docker, WSL tắt sẵn). Mỗi ô: cài sạch → `/api/ready` xanh → `genh update` → `genh uninstall`. Kiểm tra thêm: mất mạng giữa chừng rồi chạy lại, cổng bận, đĩa đầy.

`.github/workflows/installer-matrix.yml` ở trên smoke-test binary (`genh version`/`help`, cài đặt best-effort không có image publish sẵn) và **từ v0.1.33 chạy `go vet ./...` + `go test ./...` của `apps/genh` trên cả 4 hệ điều hành** (ubuntu-22.04, ubuntu-24.04, macos-14, windows-2022); job tổng `installer-ok` luôn chạy (không lọc đường dẫn) và là required check. **`.github/workflows/e2e-install.yml`** mới là lần cài THẬT bằng Docker (runner `ubuntu-24.04` có Docker sẵn):
cài sạch (`install.sh` thật ở chế độ bản phát hành, hoặc build từ source + ghim `compose.release.yaml` đã publish ở chế độ PR) → `/api/v1/ready` xanh → `genh status` → thử tạo dữ liệu mẫu qua `POST /setup/steps/1` (best-effort, xem ghi chú đầu file) → `genh backup` → `genh export`/`genh import` → `genh update --yes` → `genh auto-update enable/status/disable` → `genh uninstall --yes`. Kích hoạt:
- tự động sau khi workflow **Release** thành công (`workflow_run`) — kiểm **đúng tag** của commit vừa phát hành (tìm từ `head_sha`, cài bằng `install.sh` với `GEN_HARNESS_RELEASE_TAG`), xanh thì job `promote` nâng thành bản chính thức (xem "Cổng phát hành");
- tay qua **Actions → E2E cài đặt thật → Run workflow**: input `tag` (bỏ trống = bản chính thức hiện tại), `promote` (nâng tag đó thành bản chính thức nếu xanh), `skip_e2e` (chỉ dùng kèm `promote` khi E2E lỗi vì lý do ngoài mã);
- tự động trên PR/push (chế độ pr) đổi `apps/genh/**`, `deploy/**` (gồm `deploy/images/**`), `install.sh`, `apps/api/**`, `apps/web/Dockerfile`, `VERSION` (danh sách đầy đủ ở khối `paths:` đầu tệp). Chế độ pr ghim `compose.release.yaml` của **bản chính thức** qua `releases/latest` (không dùng `gh release list` — tránh lấy nhầm bản thử).

Có thêm job `e2e-upgrade` (chỉ chạy ở 2 cách kích hoạt đầu): cài **bản chính thức (latest) hiện tại**, rồi nâng cấp LÊN **đúng tag đang xét** — binary `genh` của tag đó được đặt bằng tay vì bản thử bị ẩn khỏi tự cập nhật — rồi `genh update`, xác nhận `app_db_password` không đổi (dữ liệu không bị tạo lại). Đường "genh cũ tự tải binary mới" (`internal/selfupdate`) không đi qua job này; nó do job `e2e-selfupdate` kiểm **sau promote** (xem "Cổng phát hành" mục 7) cùng `go test` của `selfupdate`.

**Đọc kết quả:** vào tab Actions → chọn lần chạy → mở job `e2e-install` (và `e2e-upgrade` nếu có). Mỗi bước đặt tên tiếng Việt đúng việc nó làm; hai bước cuối luôn chạy (`if: always()`) in log `docker compose logs --tail 200` + log `~/.gen-harness/logs` — bước nào đỏ, mở log của CHÍNH bước đó trước, rồi tới 2 bước log cuối để xem dịch vụ nào bên trong container lỗi. `genh uninstall --yes` cần cờ `--yes` mới CLI (thêm ở phiên e2e-install — trước đó `ops.UninstallOptions.AutoApprove` không có cờ CLI, xem `apps/genh/internal/ops/uninstall.go`).

Giới hạn đã biết (ghi rõ, không bịa đã làm): dữ liệu mẫu chỉ gọi được bước 1/12 của `/setup` (`mode=sample`, không cần tài khoản Owner) — các bước 2-12 (owner/PIN/tổ chức/kết nối Zalo QR/agent...) cần thao tác không tự động hoá được trong CI, KHÔNG chạy ở đây.
