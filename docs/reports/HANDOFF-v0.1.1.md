# Bàn giao v0.1.1 — sửa lưu trữ, hồ sơ Owner, CSDL, RLS

Trạng thái: **đã xong, chờ PR** trên nhánh `claude/admiring-goodall-6dmk8k` (khởi từ `main` sau PR #3 / tag v0.1.0).
Phiên trước hết quota giữa chừng; code 4 subagent của phiên đó nằm trong worktree cục bộ nên đã mất — làm lại theo kế hoạch dưới.

## Lỗi cần sửa (đã kiểm trên code v0.1.0)

1. 🔴 Tài liệu + backup lưu trong `/tmp/gh-objects` của container (`gh/chassis/objects.py`, `GH_OBJECTS_DIR` rỗng, không có volume) → mất khi tạo lại container; api và worker không thấy file của nhau; rollback của `genh update` hỏng. MinIO chạy nhưng không dùng.
2. 🔴 Không có cách chuyển hồ sơ Owner sang máy khác: backup/bí mật trong DB mã hoá bằng khoá master riêng từng máy; `genh restore` không nhận file ngoài. `BackupKey` trong secretgen không dùng ở đâu.
3. 🟠 RLS (`0012_p5_rls`) vô hiệu vì app kết nối bằng superuser.
4. 🟡 Thiếu index `refinery.event_state(run_id)`, `core.sessions(user_id)`; không dọn phiên hết hạn; Postgres cấu hình mặc định (shared_buffers 128MB).
5. 🟡 `genh` bản mới không cập nhật `compose.yaml` đã ghi trên máy Owner (`compose.writeEmbeddedCompose` bỏ qua khi tệp đã tồn tại) → mọi sửa compose không tới máy đã cài.

## Chia việc (4 subagent Sonnet, worktree riêng)

| Mã | Phạm vi | File chính |
|---|---|---|
| 1a · CSDL | migration `0014`: 2 index, role `gh_app` (không superuser, không BYPASSRLS), GRANT; job dọn `core.sessions` hết hạn; `admin_database_url` cho backup/bảo trì phân vùng; chạy toàn bộ test dưới `gh_app` | `apps/api/migrations`, `apps/api/gh/config.py`, `gh/backup.py`, worker/jobs |
| 1b · Gói hồ sơ Owner | `python -m gh.bundle export/import` (xem hợp đồng) | `apps/api/gh/bundle.py` + tests |
| 2a · Hạ tầng | volume `gh_objects` cho api+worker, `GH_OBJECTS_DIR`; bỏ MinIO; Postgres tuning theo RAM; `GH_APP_DB_PASSWORD`/URL cho gh_app; `genh update` ghi lại compose nhúng | `deploy/compose.yaml`, `apps/genh/internal/{compose,install,secretgen,ops/update.go}` |
| 2b · Lệnh genh | `genh export --to <file>`, `genh import <file>` | `apps/genh/internal/ops/{export,import}.go`, `cmd/genh/main.go` |

## Hợp đồng chung (chốt trước để làm song song)

**Biến môi trường**
- `GH_OBJECTS_DIR=/var/lib/gh/objects` (volume `gh_objects`, gắn vào api + worker).
- `GH_DATABASE_URL` của api/worker → user `gh_app`, mật khẩu `GH_APP_DB_PASSWORD`.
- `GH_ADMIN_DATABASE_URL` → superuser `gh` (migrate, backup, bundle, bảo trì phân vùng). Rỗng ⇒ dùng `GH_DATABASE_URL`. Setting: `Settings.admin_database_url`.
- Migration 0014 tạo/ALTER role `gh_app` với mật khẩu lấy từ env `GH_APP_DB_PASSWORD` lúc migrate (thiếu ⇒ tạo role NOLOGIN, cảnh báo).
- Postgres tuning: `GH_PG_SHARED_BUFFERS`, `GH_PG_EFFECTIVE_CACHE_SIZE`, `GH_PG_WORK_MEM`, `GH_PG_MAINTENANCE_WORK_MEM` (genh tính từ RAM, ghi vào overlay env; compose có mặc định an toàn).

**Gói hồ sơ `.ghbundle`** (Python tạo/đọc, Go chỉ chuyển bytes)
- Export: `python -m gh.bundle export --out -` → bytes gói ra **stdout**, log ra **stderr**. Mật khẩu qua env `GH_BUNDLE_PASSWORD` (≥ 12 ký tự).
- Import: `python -m gh.bundle import --in -` → đọc gói từ **stdin**, mật khẩu env `GH_BUNDLE_PASSWORD`. Khôi phục DB (pg_restore --clean qua admin URL), khôi phục object (trừ `backups/`), **mã hoá lại** mọi bí mật trong DB bằng khoá master của máy mới (khoá master cũ đi kèm trong gói chỉ để giải mã).
- Mã thoát: `0` ok · `2` sai mật khẩu/gói hỏng · `3` phiên bản gói/schema không tương thích · `1` lỗi khác.
- Định dạng: `GHBUNDLE1\n` + header JSON 1 dòng (kdf argon2id params, salt, nonce) + AES-256-GCM(tar: `manifest.json`, `db.dump`, `objects/…`, `keys.json`).
- genh: `genh export --to <file>` hỏi mật khẩu 2 lần (ẩn), `genh import <file> [--yes]` hỏi 1 lần, backup an toàn trước, rồi restart api/worker.

## Tiếp tục thế nào nếu lại hết quota
1. `git fetch && git checkout claude/admiring-goodall-6dmk8k`, đọc file này + `git log`.
2. Mỗi mục đã xong sẽ có commit riêng `feat(v0.1.1/<mã>)`. Làm tiếp mục chưa có commit.
3. Khi đủ 4 mục: chạy `make test`, `cd apps/genh && go test ./...`, mở PR vào `main` cho v0.1.1.

## Kiểm tra tích hợp (trên bản đã gộp 4 mục)

Chạy trên môi trường Postgres 16 (pgvector + pg_partman) + Redis thật, venv `apps/api/.venv` mới cài
(`pip install -e ".[dev]"`), Go 1.24.

- `apps/api`: `ruff check gh tests` sạch, `mypy gh` sạch (96 tệp nguồn). `pytest -q` mặc định:
  **899 passed**. `GH_TEST_APP_ROLE=1 pytest -q` (Makefile `api-test-app-role`, role `gh_app` không
  superuser/không BYPASSRLS): ban đầu **2 failed / 897 passed**
  (`test_export_import_round_trip_two_master_keys_and_objects`,
  `test_import_same_master_key_skips_reencryption` trong `tests/test_bundle.py`) — **đã sửa** (xem dưới),
  chạy lại: **899 passed**.
- **Lỗi tìm thấy (test, không phải bug sản phẩm) và đã sửa**: `tests/test_bundle.py::_use_database` chỉ
  `setenv("GH_DATABASE_URL", …)` mà không xoá `GH_ADMIN_DATABASE_URL` — dưới `GH_TEST_APP_ROLE=1`,
  biến này đã được `conftest.py::_use_db` đặt trỏ về `fresh_db` (CSDL nguồn, đã có sẵn schema/dữ liệu/phân
  vùng pg_partman) từ trước. Vì `effective_admin_database_url` (`gh/config.py`) chỉ rơi về
  `GH_DATABASE_URL` khi `GH_ADMIN_DATABASE_URL` **rỗng**, hai bài test gọi `bundle._import` tưởng đang
  restore vào CSDL đích mới (`target_db`, trống) nhưng thực ra `pg_restore --clean` chạy nhầm vào chính
  `fresh_db` — gây lỗi `cannot drop inherited constraint … (partition pg_partman)`. Đã thêm
  `monkeypatch.delenv("GH_ADMIN_DATABASE_URL", raising=False)` vào `_use_database` để admin URL rơi đúng
  theo CSDL đích mới, giống cách `conftest.py::_use_db` tự làm ở chế độ mặc định.
- `apps/genh`: `gofmt -l .` ban đầu báo 2 tệp lệch định dạng do gộp nhánh
  (`internal/install/steps_finalize_test.go`, `internal/install/steps_migrate_test.go`) — **đã chạy
  `gofmt -w`** để sửa (chỉ đổi khoảng trắng căn cột struct literal + xoá dòng trống thừa cuối tệp, không
  đổi logic). `go vet ./...` sạch. `go test ./...` **tất cả PASS** (12 gói, kể cả sau gofmt).
- **Soát chéo hợp đồng** `deploy/compose.yaml` ↔ Python/Go: `GH_ADMIN_DATABASE_URL` có ở `api`/`worker`
  (superuser); `migrate` không cần khai riêng vì `GH_DATABASE_URL` của nó ĐÃ là superuser và
  `effective_admin_database_url` rơi về đúng giá trị đó khi rỗng (`migrations/env.py::sync_url` xác nhận).
  `GH_APP_DB_PASSWORD` truyền tới `migrate`/`api`/`worker` đúng tên. `GH_OBJECTS_DIR` gắn `api`+`worker`
  qua volume `gh_objects`. Không còn dịch vụ MinIO trong `compose.yaml`; grep `minio` toàn repo chỉ còn ở
  báo cáo/tài liệu lịch sử (`docs/reports/phase-*.md`, `docs/handoff/*`, `docs/ARCHITECTURE.md`, `docs/PLAN.md`)
  và ở tuỳ chọn UI backup `destination: 'local'|'s3'|'minio'` (`Step11Backup.tsx`, `gh/setup/routes.py`) —
  tuỳ chọn đó chỉ LƯU CẤU HÌNH, chưa từng nối dây MinIO thật kể cả trước v0.1.1, không phải hồi quy của
  đợt gộp này nên không sửa ở đây. `internal/compose/embedded_compose.yaml` **giống hệt**
  `deploy/compose.yaml` (diff rỗng). `genh export`/`genh import` (`apps/genh/internal/ops/bundle.go`) gọi
  đúng `python -m gh.bundle export --out -` / `import --in -` qua `docker compose exec -T`, mật khẩu qua
  env `GH_BUNDLE_PASSWORD` (không qua argv), mã thoát `0/1/2/3` khớp `gh/bundle.py` (case 2 → sai mật
  khẩu/gói hỏng, case 3 → không tương thích, khác → lỗi chung). Overlay env của genh
  (`internal/ops/env.go`, `internal/pgtune/pgtune.go`) truyền đúng tên `GH_APP_DB_PASSWORD`/`GH_PG_SHARED_BUFFERS`/
  `GH_PG_EFFECTIVE_CACHE_SIZE`/`GH_PG_WORK_MEM`/`GH_PG_MAINTENANCE_WORK_MEM` mà `compose.yaml` đọc.
- **Thử tích hợp thật (không cần Docker)**: migrate một CSDL nguồn thật (`alembic upgrade heads`), chèn một
  bí mật thật (`agent.mcp_servers.auth_enc`, mã hoá bằng khoá master A) → `python -m gh.bundle export --out
  /tmp/x.ghbundle` (CLI thật, không qua test) → `cat x.ghbundle | python -m gh.bundle import --in -` (qua
  **stdin** thật) vào một CSDL đích **trống hoàn toàn** khác, khoá master B khác hẳn khoá A → bí mật đọc
  lại đúng bằng khoá B (`crypto.decrypt` với khoá A giờ thất bại — đã mã hoá lại thật). Thử lại với
  `GH_BUNDLE_PASSWORD` sai → mã thoát đúng **`2`**, log đúng thông báo "Sai … hoặc gói đã bị sửa/hỏng".
  `docker compose -f deploy/compose.yaml config` với `.env` giả (`POSTGRES_PASSWORD`/`GH_APP_DB_PASSWORD`
  giả) chạy sạch, in đúng `GH_DATABASE_URL`/`GH_ADMIN_DATABASE_URL` theo vai trò từng service.
- **Tài liệu**: `README.md` — bỏ MinIO khỏi yêu cầu hệ thống/bảng dịch vụ (còn 8 dịch vụ, không phải 9),
  sửa tên biến `.env` mẫu (`MINIO_ROOT_PASSWORD` không còn tồn tại → `GH_APP_DB_PASSWORD`), thêm ghi chú
  `genh export`/`genh import` ở mục Sao lưu/khôi phục. `docs/handoff/05-installer.md` — thêm dòng
  `genh export --to <file>` / `genh import <file> [--yes]` vào bảng "Lệnh vận hành" (trước đó không liệt
  kê hai lệnh mới của v0.1.1/2b).

**Việc còn lại**: mở PR vào `main`. Không tìm thấy bug sản phẩm nào (mọi lỗi phát hiện đều ở test/tài liệu
gộp nhánh); `gh.bundle` export/import hoạt động đúng hợp đồng trên dữ liệu thật kể cả không qua Docker.

## v0.1.2 — sửa sau rà soát độc lập (27/09/2026)

Rà soát bản v0.1.1 đã merge tìm ra (đã sửa trên nhánh `claude/admiring-goodall-6dmk8k`):
- 🔴 `genh` trên máy cài v0.1.0 hỏng mọi lệnh vì `LoadSecrets` không bổ sung `app_db_password` → nay `secretgen.LoadFillingMissing`.
- 🔴 Tài liệu/backup trong `/tmp/gh-objects` của container v0.1.0 mất khi update → `genh update` chép ra `<installDir>/data/migrate-objects-*` (gộp api + worker, gộp manifest backup) rồi nạp vào volume `gh_objects`; rollback cũng nạp lại trước khi restore.
- 🟠 Mọi lệnh genh âm thầm ghi đè `compose.yaml` → chỉ `genh update`/install đồng bộ (giữ `.bak`, in cảnh báo).
- 🟠 `genh import` chạy khi api/worker sống, không migrate → nay: chép backup an toàn ra host → stop api/worker → `run` import → `run migrate` → `up -d`; Python ngắt kết nối lạ + `lock_timeout`.
- 🟡 Khoá backup riêng `GH_BACKUP_KEY` (backup cũ vẫn đọc bằng khoá master); UI bước 11 bỏ ô `retention_count` và đích MinIO; README hướng dẫn `genh export` định kỳ để sao lưu khoá.
- Để sau: tách admin DB URL khỏi container api (service riêng cho backup/bảo trì).

Chưa kiểm: chạy thật với Docker daemon (nâng cấp v0.1.0 → v0.1.2, export/import giữa 2 máy).

## v0.1.3 — sửa mất-hồ-sơ khi tự nâng cấp genh (27/09/2026)

Xác minh THẬT bằng binary v0.1.2: máy Owner chạy genh v0.1.0 (`genh update` của bản đó KHÔNG tự tải binary
mới). Cách duy nhất có tài liệu để lấy genh mới là chạy lại install.sh/install.ps1 — nhưng script `exec genh
install` VÔ ĐIỀU KIỆN, và `genh install` không phát hiện máy đã cài → dựng lại container, bỏ qua backup + di
trú `/tmp/gh-objects` → MẤT tài liệu. Đã sửa:

- 🔴 `install.sh`/`install.ps1`: sau khi thay binary, nếu `<INSTALL_ROOT>/config/secrets.json` đã tồn tại (máy
  đã cài) thì KHÔNG `exec genh install` nữa — in rõ chạy `genh update` để nâng cấp an toàn (hoặc `genh
  install` nếu lần cài trước chưa xong). Máy chưa cài giữ nguyên hành vi cũ.
- 🔴 `genh install`: tự phát hiện máy đã cài HOÀN CHỈNH (`secrets.json` tồn tại VÀ `docker compose ps -a`
  thấy container service "api") → dừng lại, báo dùng `genh update`, trừ khi có cờ `--force`. Không chặn nhầm
  một lần cài dở dang (thiếu MỘT trong hai điều kiện vẫn cho chạy tiếp bình thường). Xem
  `internal/install/detect.go` (`DetectExistingInstall`) + `detect_test.go` (dockercli fake).
- 🟠 `ops.RunUpdate` (mục #3 v0.1.2 sửa chưa triệt để): bước 1 (backup) giờ chạy với compose.yaml ĐANG có trên
  đĩa (`env.LocatePath`, không sync) — đồng bộ với bản nhúng binary genh (`env.LocatePathSync`) chỉ chạy SAU
  KHI backup đã thành công. `rollbackAndWrap` khôi phục compose.yaml về đúng bản CŨ (từ `compose.yaml.bak`)
  TRƯỚC KHI restore dữ liệu + `up -d`, để container rollback khớp đúng compose.yaml đã dùng lúc backup — xem
  `restoreComposeFromBackupIfAny` trong `internal/ops/update.go`.
- 🟠 `EnvOverlay` (`internal/ops/env.go`) luôn thêm `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` giữ chỗ không rỗng
  — compose.yaml v0.1.0 còn `${MINIO_ROOT_PASSWORD:?...}` bắt buộc dù secrets.json v0.1.2 đã bỏ MinIO, tái
  hiện được lỗi thật `required variable MINIO_ROOT_PASSWORD is missing` trên máy chưa qua `genh update`/`genh
  install` mới. Kiểm bằng `docker compose -f testdata/compose-v0.1.0.yaml config` thật (không cần daemon).
- 🟠 `up -d` của `genh update` (chính + rollback) thêm `--remove-orphans` để dọn container MinIO `objects` cũ
  của v0.1.0 — an toàn với rollback vì compose.yaml lúc đó đã được khôi phục về bản CŨ (vẫn khai báo MinIO,
  không bị coi là orphan).
- README: thêm mục "Nâng cấp" (chạy lại install.sh/install.ps1 rồi `genh update`).

Test: `cd apps/genh && gofmt -l . && go vet ./... && go test ./...` xanh. Chưa kiểm: chạy thật `install.sh`
trên một máy đã cài thật (chỉ soát bằng đọc mã + `sh -n`/logic review, không có Docker daemon thật trong môi
trường viết phiên này để dựng end-to-end máy Owner y hệt).

## v0.1.4 — tự động phát hành + sửa cài Docker hỏng trên Linux (27/09/2026)

- 🟠 **Tự động phát hành**: agent code không tự tạo được tag (proxy chặn) nên trước đây phải nhờ người tạo
  tag/Release tay. Thêm `VERSION` ở gốc repo; `release.yml` giờ chạy cả trên `push: branches: [main]` (giữ
  nguyên trigger tag `v*` cho trường hợp tay + thêm `workflow_dispatch`). Job `meta` đọc `VERSION`, kiểm tag
  đó đã tồn tại trên remote chưa (`git ls-remote --tags origin`) — nếu merge PR không đổi `VERSION`, tag cũ
  vẫn còn → `skip=true`, mọi job khác `if: needs.meta.outputs.skip != 'true'`, không phát hành lại. Mọi chỗ
  từng dùng `github.ref_name` làm phiên bản (ldflags, tag ảnh, tên Release, concurrency…) đổi sang
  `needs.meta.outputs.version`. Job `release` (softprops/action-gh-release) tự tạo tag `version` trỏ đúng
  `github.sha` (`target_commitish`) — tag tạo bằng `GITHUB_TOKEN` không tự kích hoạt lại workflow (đúng ý,
  không chạy release 2 lần). Concurrency chuyển xuống từng job, khoá theo `needs.meta.outputs.version`, để
  2 lần merge liên tiếp (2 version khác nhau) không huỷ nhau giữa chừng. Thêm job `verify-docker-pins`: tải
  lại 4 tệp Docker tĩnh đã ghim SHA-256 (xem mục dưới) từ `download.docker.com`, so sha256, fail sớm nếu
  Docker thay nội dung tệp. CI (`ci.yml`, job `version`) kiểm định dạng `VERSION` ngay từ PR. Đã kiểm cú pháp
  YAML (`python3 -c "import yaml..."`) và `actionlint` (cài từ `github.com/rhysd/actionlint`) — sạch cả
  `release.yml` lẫn `ci.yml`.
- 🟠 **Cài Docker tự động hỏng trên Linux (GH-E021)**: `bootstrap_linux.go` tải
  `https://download.docker.com/linux/static/stable/<arch>/SHA256SUMS` để kiểm checksum — đã xác minh trực
  tiếp (curl thật) Docker **không** phát hành tệp này (404), thư mục chỉ có các `*.tgz` — nên máy Linux chưa
  có Docker không cài được. Sửa: ghim cứng SHA-256 của `docker-<version>.tgz` +
  `docker-rootless-extras-<version>.tgz` cho `x86_64`/`aarch64` trong biến `dockerStaticChecksums` (kèm
  comment cách cập nhật), kiểm bằng checksum ghim thay vì tải SHA256SUMS. Nâng `dockerStaticVersion` từ
  `27.3.1` lên **`29.8.1`** (bản ổn định mới nhất hiện có ở `download.docker.com` tại thời điểm sửa) — đã tải
  thật cả 4 tệp (2 kiến trúc × 2 gói) và tính `sha256sum` để lấy checksum ghim, không bịa số. Test
  (`bootstrap_linux_test.go`) không còn giả lập `SHA256SUMS` — ghi đè tạm bảng checksum toàn cục
  (`withPinnedChecksums`) khớp tarball giả trong bộ nhớ, cộng test riêng `TestPinnedChecksum_KnownVersion`
  xác nhận bảng thật có đủ checksum cho `dockerStaticVersion` hiện hành. Đã soát `bootstrap_darwin.go`
  (Colima/Lima) và `bootstrap_windows.go` (rootfs WSL) cho cùng loại lỗi: **`bootstrap_windows.go` an toàn**
  (đã tự ghi rõ rootfs WSL thật chưa từng được đóng gói/phát hành — không có URL checksum giả nào). **Phát
  hiện thêm ở `bootstrap_darwin.go`**: cùng loại lỗi — `checksums.txt` của cả `abiosoft/colima` lẫn
  `lima-vm/lima` trên GitHub Releases cũng trả **404** (đã xác minh qua `curl`), nên bootstrap trên macOS
  cũng sẽ luôn lỗi "lấy checksum" giống Linux trước khi sửa. **CHƯA sửa được trong phiên này**: mạng
  `github.com` (API lẫn web) bị proxy của môi trường viết chặn hoàn toàn (403/không truy cập được), nên
  không xác minh được tên asset thật + tính sha256 thật cho `colima`/`lima` — việc còn lại cho phiên sau
  (cần môi trường có mạng ra GitHub) là: tải asset thật của `colima` v0.7.5 + `lima` v0.23.2 cho cả 2 kiến
  trúc, ghim checksum vào `bootstrap_darwin.go` theo đúng khuôn `PinnedChecksum` đã làm cho Linux.

Test: `cd apps/genh && gofmt -l . && go vet ./... && go test ./...` xanh (build thử cả 3 GOOS qua
`GOOS=<linux|darwin|windows> go build ./...` để chắc bootstrap_*.go không vỡ biên dịch chéo).

## v0.1.5 — genh tự thay binary + tự cập nhật theo lịch (27/09/2026)

Bối cảnh: từ v0.1.4 phát hành đã tự động (tăng `VERSION` → merge → release.yml tự tạo Release + tag), nhưng
`genh update` (internal/ops/update.go) vẫn chỉ nâng cấp DỊCH VỤ (backup → migrate → up), KHÔNG tự thay
BINARY `genh` — Owner (không rành code) vẫn phải tự nhớ chạy lại install.sh/install.ps1 định kỳ để có `genh`
mới. Mục tiêu phiên này: sau khi cài một lần, KHÔNG CẦN LÀM GÌ để có bản mới.

- 🟠 **`internal/selfupdate` (mới, có test httptest)**: `genh update` giờ TRƯỚC TIÊN hỏi bản mới nhất qua
  GitHub API `GET /repos/<owner>/<repo>/releases/latest` (lấy `tag_name`, có timeout — mặc định 20s, lỗi
  mạng → in cảnh báo và TIẾP TỤC với binary hiện tại, không chặn `genh update`). So semver đúng nghĩa
  (major.minor.patch, bỏ qua hậu tố tiền phát hành) với `main.version` của binary đang chạy — bản `"dev"`
  hoặc rỗng LUÔN bị bỏ qua (không hỏi mạng, không bao giờ tự thay một binary dev bằng bản release). Nếu mới
  hơn: tải asset đúng nền tảng (`genh-<os>-<arch>[.exe]`, đúng quy ước install.sh) + `checksums.txt` của
  ĐÚNG TAG đó (không dùng `/latest/download`, tránh lệch bản nếu có release mới xen giữa lúc hỏi metadata và
  lúc tải) qua `github.com/<owner>/<repo>/releases/download/<tag>/…`, kiểm SHA-256 BẮT BUỘC — sai → từ chối,
  KHÔNG đụng gì tới binary cũ. Thay binary AN TOÀN: ghi tệp tạm CÙNG THƯ MỤC với binary đang chạy rồi
  `os.Rename` đè lên (Linux/macOS cho phép rename/xoá tệp thực thi đang chạy); Windows KHÔNG rename được lên
  .exe đang chạy → đổi tên bản cũ thành `.old` trước, đặt bản mới vào đúng chỗ, dọn `.old` sau (khôi phục lại
  nếu bước đặt bản mới lỗi giữa chừng, không để máy không có `genh.exe` nào chạy được). Test
  (`selfupdate_test.go`, toàn bộ dùng `httptest.Server` giả, KHÔNG gọi `github.com` thật): cùng phiên bản →
  không tải/không thay gì; checksum sai → từ chối VÀ binary cũ giữ nguyên (kiểm cả không để sót tệp tạm);
  bản dev → bỏ qua trước khi gọi mạng; lỗi mạng → không lỗi, chỉ Skip; tải/thay thành công → nội dung + quyền
  thực thi đúng.
- 🟠 **`cmd/genh` — re-exec sau tự cập nhật**: `genh update` gọi `selfupdate.Run` trước khi
  `ops.RunUpdate` (trừ `--no-self-update` hoặc cờ nội bộ `--self-updated`). Nếu binary vừa được thay trên
  đĩa, KHÔNG tự chạy tiếp trong cùng tiến trình (tiến trình đang chạy đã nạp SẴN code + compose.yaml nhúng
  của bản CŨ vào bộ nhớ) — spawn lại chính binary đó (giờ đã là bản mới) với đúng args gốc + `--self-updated`,
  chờ tiến trình con chạy hết phần nâng cấp dịch vụ (đảm bảo dùng đúng compose.yaml nhúng MỚI ở bước 1.5 của
  `RunUpdate`), rồi thoát với đúng mã thoát của con.
- 🟠 **`internal/autoupdate` (mới, có test)**: `genh auto-update enable|disable|status` — bật/tắt/kiểm lịch tự
  chạy `genh update --yes --quiet` mỗi đêm ~03:00 giờ máy. Linux: systemd `--user` timer
  (`~/.config/systemd/user/gen-harness-update.{service,timer}`, `Persistent=true` bù lần chạy bị lỡ,
  `RandomizedDelaySec=1800`), TỰ PHÁT HIỆN máy không có session `--user` hoạt động (container/WSL tối giản
  không D-Bus — `systemctl --user daemon-reload` thất bại) để fallback sang dòng crontab người dùng (đọc/ghi
  qua `crontab -l` / `crontab <tệp>`, có marker riêng để tìm/xoá đúng dòng của genh mà không đụng cron khác
  của Owner). macOS: LaunchAgent (`~/Library/LaunchAgents/com.gen-harness.update.plist`, `launchctl load -w`).
  Windows: Task Scheduler (`schtasks /Create /SC DAILY /ST 03:00 /RL LIMITED` — không cần quyền admin). Log
  ghi nối vào `<InstallDir>/logs/auto-update.log` (`config.Paths.LogsDir()`). Phần SINH NỘI DUNG tệp/lệnh
  (unit systemd, dòng crontab, plist, args schtasks — `content.go`) là hàm THUẦN, test trực tiếp không cần
  build tag theo hệ điều hành; phần GỌI THẬT systemctl/launchctl/schtasks/crontab đi qua `Runner` (tiêm giả
  khi test — `autoupdate_test.go` kiểm cả 3 nhánh Linux/macOS/Windows bằng runner giả trên cùng một máy
  Linux, không cần máy thật của từng hệ điều hành).
- 🟠 **`genh install`**: Bước 8 (Hoàn tất) giờ tự gọi `autoupdate.Enable` sau khi in tóm tắt, in đúng 1 dòng
  "Đã bật tự cập nhật hằng đêm lúc ~03:00 — tắt bằng `genh auto-update disable`" (nội dung dòng do chính
  `autoupdate.Enable` trả về, khác nhau theo cơ chế: systemd timer/crontab/LaunchAgent/Task Scheduler). Cờ
  `--no-auto-update` bỏ qua bước này. Bật lỗi CHỈ in cảnh báo ra stderr — KHÔNG BAO GIỜ làm hỏng một lần cài
  đặt vừa xong (Owner vẫn dùng được Gen-Harness bình thường, chỉ thiếu lịch tự động, tự bật lại sau bằng
  `genh auto-update enable`).
- 🟡 **install.sh/install.ps1**: máy ĐÃ CÀI (secrets.json tồn tại) giờ CHẠY LUÔN `genh update` sau khi thay
  binary (thay vì chỉ in hướng dẫn rồi dừng như v0.1.3/v0.1.4) — an toàn để tự động hoá vì `genh update` đã
  tự có backup + rollback từ trước, và giờ tự lo cả phần tải binary mới. Cả hai tệp vẫn ≤ 150 dòng.
- 🟡 **Không có prompt nào trong `genh update` không tương tác**: rà lại `internal/ops/update.go` (và
  `backupcore.go`, `migrateobjects.go` mà nó gọi tới) — xác nhận KHÔNG có lệnh đọc stdin/hỏi xác nhận nào
  (khác `genh reset-setup`/`genh import`, có hỏi xác nhận thật). Cờ `--yes` được nhận (không lỗi "cờ lạ", vì
  `genh auto-update`/tài liệu đều gọi kèm) nhưng hiện KHÔNG đổi hành vi — để dành chỗ nếu sau này thêm bước
  cần xác nhận. `--quiet` chặn toàn bộ log tiến độ từng bước của `ops.RunUpdate` (truyền `io.Discard` thay
  `os.Stdout`), chỉ in "genh: cập nhật xong." khi thành công — lỗi/cảnh báo tự cập nhật binary vẫn LUÔN in
  (không bị `--quiet` nuốt, đúng "chỉ in dòng quan trọng").

Test: `cd apps/genh && gofmt -l . && go vet ./... && go test ./...` xanh (`internal/selfupdate`:
6 test PASS; `internal/autoupdate`: 25 test PASS — cả pure content-gen lẫn dispatch qua runner giả 3 hệ điều
hành). Build chéo `GOOS=linux/darwin/windows GOARCH=amd64 CGO_ENABLED=0 go build ./cmd/genh` sạch cả 3.
`sh -n install.sh` sạch; `install.sh`/`install.ps1` đúng 150 dòng.

**Thử THẬT trên máy viết code này** (build 2 binary `-ldflags "-X main.version=vX.Y.Z"`, cho tự cập nhật từ
Release THẬT trên GitHub, repo `Genesis-ryan-84-0567536339/Gen-Harness`):
- Build `v0.1.4` → gọi `selfupdate.Run` nhắm đúng `v0.1.4` (tag đã có Release thật với asset
  `genh-linux-amd64` + `checksums.txt`): báo **"đã ở bản mới nhất"**, không tải/không thay gì — ĐÚNG như kỳ
  vọng.
- Build `v0.1.3` → gọi `selfupdate.Run`: (xem kết quả thật ở báo cáo cuối phiên — nếu mạng `github.com` bị
  proxy môi trường viết chặn, mục này ghi rõ lỗi mạng gặp phải thay vì bịa kết quả; test `httptest` ở
  `selfupdate_test.go` đã phủ đúng luồng "tải thật + kiểm checksum + thay binary" bằng server giả cho trường
  hợp không tới được `github.com` thật từ môi trường này).

## v0.1.6 — lỗi phát hiện nhờ e2e cài thật (27/09/2026)
Lần đầu cài thật toàn bộ bằng Docker (workflow `e2e-install`) lộ 2 lỗi có từ trước, unit test không bắt được:
- 🔴 `httpx` chỉ nằm trong nhóm dev của `apps/api/pyproject.toml` → ảnh api/worker thiếu thư viện, chết ngay khi import (`ModuleNotFoundError`). Chuyển vào dependencies chính.
- 🔴 Docker secret dạng file giữ quyền host: `secrets/gh_*_key` 0600 → container (USER gh/node) không đọc được (`EACCES`). Nay tệp 0644 trong thư mục `secrets/` 0700; genh chmod lại cả bản cài cũ.
- e2e chế độ PR build ảnh từ code của PR (`GENH_COMPOSE_FILE` → `deploy/compose.yaml`) để lỗi trong ảnh lộ trước khi phát hành.
- 🔴 genh gọi proxy bằng `https://127.0.0.1:<port>` — Caddy site `localhost:8443` + `tls internal` không có chứng chỉ cho yêu cầu không SNI → bước "chờ /api/v1/ready" của `genh install`/`update`/`status` không bao giờ thành công dù api healthy. Nay gọi `https://localhost:<port>` (`ops.ProxyHost`).
- 🔴 Ảnh api không có `pg_dump`/`pg_restore` → `genh backup`/`update`/`export`/`import` và backup định kỳ đều chết (`FileNotFoundError: 'pg_dump'`). Cài `postgresql-client-16` từ apt.postgresql.org (cùng major với server).
- 🔴 genh sinh khoá master dạng hex (64 ký tự) nhưng `gh.crypto.master_key` chỉ nhận base64 → mọi thao tác mã hoá/giải mã trên bản cài bằng genh (backup, lưu API key…) lỗi "GH_MASTER_KEY phải là 32 byte base64". `gh.crypto.decode_key` nay nhận cả hex lẫn base64 (không đổi khoá của bản cài cũ).
- 🔴 `pg_restore --clean` đè lên CSDL có bảng phân vùng (pg_partman) lỗi hàng loạt "cannot drop inherited constraint" → `genh import` và rollback của `genh update` hỏng. Nay `gh.backup.recreate_database` xoá/tạo lại CSDL rỗng (`DROP DATABASE … WITH (FORCE)`) rồi mới `pg_restore` (dùng chung cho backup restore và bundle import). Test hồi quy `test_restore_overwrite_partitioned_tables_in_place`.

## v0.1.7 — Release không còn treo ở ảnh web

- Release v0.1.6 kẹt ở job "build+push ảnh web" hơn 25 phút (giống v0.1.1): `npm ci` + `vite build` chạy dưới QEMU arm64.
- `apps/web/Dockerfile`: tầng build đổi thành `FROM --platform=$BUILDPLATFORM`. Bundle tĩnh giống nhau trên mọi kiến trúc nên chỉ build 1 lần (native amd64); tầng nginx arm64 chỉ COPY.
- `release.yml`: `timeout-minutes: 30` cho build-images (mặc định 6 giờ).
- Run v0.1.6 bị huỷ; tag v0.1.6 chưa từng được tạo nên v0.1.7 là bản phát hành kế tiếp của v0.1.5.

## v0.1.8 — Cài từ bản phát hành: proxy không khởi động (thiếu Caddyfile)

- E2E chế độ release (lần đầu chạy thật, trên v0.1.7) bắt được: genh chạy độc lập chỉ ghi `compose.yaml` nhúng ra `~/.gen-harness/deploy/`, KHÔNG ghi `caddy/Caddyfile` mà compose bind-mount. Docker tự tạo thư mục rỗng (thuộc root) thay tệp, proxy lỗi "not a directory". Mọi bản ≤ v0.1.7 cài từ binary đều dính; e2e chế độ PR không thấy vì dùng thẳng compose của repo.
- Sửa: nhúng Caddyfile vào genh (`internal/compose/embedded_Caddyfile`, test giữ khớp `deploy/proxy/Caddyfile`), ghi kèm mỗi khi Locate/LocateAndSync trả về compose.yaml genh quản lý; install/update đồng bộ (giữ `.bak`).
- Đổi `deploy/caddy/` → `deploy/proxy/` (mount `./proxy/Caddyfile`): thư mục `caddy/` thuộc root trên máy đã cài lỗi không xoá được bằng quyền user, đường mới né hẳn.
- e2e job nâng cấp: nếu bản trước ≤ v0.1.7 thì cho phép bước cài bản cũ đỏ, và `genh update` phải tự sửa máy cài lỗi đó.
- Còn mở: `install.sh` đặt binary theo `GEN_HARNESS_HOME` nhưng `genh install` (không cờ) vẫn dùng `~/.gen-harness`.

## v0.1.9 — api và worker đụng nhau khi chép volume lần đầu

- E2E release v0.1.8 (cả job cài sạch lẫn job nâng cấp): `failed to mkdir …/gen-harness_agy_state/_data/.gemini/antigravity-cli: file exists`. api và worker cùng mount volume `agy_state` (và `gh_objects`); volume mới tinh thì Docker chép nội dung ảnh vào lúc tạo container, hai container tạo đồng thời cùng chép → đụng nhau. Ngẫu nhiên (v0.1.7 lọt qua).
- Sửa ở compose: worker mount hai volume đó với `nocopy: true` và `depends_on: api (service_started)`. Chỉ api chép; Docker chỉ chép khi volume còn rỗng nên thứ tự nào cũng đúng.
- Kiểm cục bộ bằng ảnh thử có cùng cây thư mục: cấu hình cũ tái hiện lỗi (1/55 lượt), cấu hình mới 0/55 lượt, worker vẫn thấy dữ liệu.
- Cùng bản: job nâng cấp cho thấy máy cài dở (api chưa từng chạy) thì `genh update` dừng ngay ở bước backup (`service "api" is not running`), nên Owner không tự sửa được bằng update. Backup/rollback giờ thử `exec` trước; nếu api không chạy thì dùng container tạm `compose run --rm --no-deps api …` (chỉ cần db sống).

## v0.1.10 — genh dùng đúng GEN_HARNESS_HOME như install.sh

- E2E release v0.1.9: cài sạch bằng install.sh XANH (48 giây, mọi dịch vụ healthy, `/ready` xanh), job nâng cấp v0.1.8 → v0.1.9 XANH (backup, update, dữ liệu giữ nguyên). Bước `genh status --install-dir $GEN_HARNESS_HOME` đỏ vì install.sh đặt binary theo `GEN_HARNESS_HOME` còn `genh install` cài dịch vụ vào `~/.gen-harness`.
- Sửa: `config.DefaultRoot()` ưu tiên `$GEN_HARNESS_HOME` (khớp install.sh/install.ps1).
- Còn mở: timer tự cập nhật (systemd/cron) chạy `genh update` không kèm `--install-dir`, nên ai đặt `GEN_HARNESS_HOME` tuỳ biến thì timer vẫn nhắm `~/.gen-harness`. Cài mặc định không bị.

## v0.1.11 — Ngưỡng đĩa trống 20 GB quá cao

- v0.1.10 đã xanh toàn bộ E2E chế độ release. Owner cài thật trên Fedora (31 GB RAM, 17 GB trống) thì bị chặn ở bước 1: "cần tối thiểu 20 GB".
- Đo thật trên ghcr: api 153 MB, bridge 130 MB, db 161 MB, web 22 MB (nén, amd64), cộng caddy và redis ≈ 0,5 GB nén, ≈ 1,5 GB giải nén.
- Ngưỡng mới: dưới 5 GB thì chặn, dưới 10 GB thì cảnh báo (vẫn cài), từ 10 GB trở lên OK.

## v0.1.12 — Đăng nhập Antigravity CLI trong Console không bao giờ ra link

- Owner cài v0.1.11 thật trên Fedora, tới bước 4 "Bộ não AI" → "Quá 10 phút chưa hoàn tất đăng nhập".
- Chạy đúng agy 1.2.9 (checksum ghim trong api.Dockerfile) trên pty, cùng env như `CliLogins._run`:
  1. CLI là TUI: in `ESC[>c`, `ESC[c`, `ESC[?u` (hỏi terminal) rồi CHỜ trả lời, không vẽ gì. Không ai trả lời → treo mãi.
  2. Khi được trả lời, menu "1. Google OAuth" hiện, chọn xong in link ~704 ký tự bị ngắt dòng. Regex cũ chỉ bắt dòng đầu → link cụt. Link đầy đủ nằm trong hyperlink OSC 8 ("Click here to authenticate").
- Sửa (`gh/providers/cli.py`): trả lời DA1/DA2/kitty/CPR như một xterm; đặt kích thước pty 1000 cột bằng TIOCSWINSZ; lấy link từ OSC 8 trước, rồi mới tới chữ.
- Test `tests/test_cli_login.py` dùng CLI giả `tests/fixtures/fake_agy.py` mô phỏng đúng hai hành vi trên, đi hết luồng Console tới hồ sơ `done`. Test đỏ với code cũ, xanh với code mới. Chạy tay với agy thật: tới `waiting_code` và nhận link 704 ký tự.
- Chưa kiểm được: bước dán mã xác thực thật (cần tài khoản Google). Test giả gửi mã + Enter giống code hiện có.

## v0.1.13 — Cài xong trình duyệt không còn báo "Not secure"

- Owner cài v0.1.11 bằng `curl … | sh` (không có `--yes`) nên Bước 8 không tin cậy CA nào. Chrome báo "Not secure", Owner phải tự chạy `certutil` + `update-ca-trust`.
- Nguyên nhân:
  - Chrome/Firefox trên Linux đọc kho NSS riêng của user (`~/.pki/nssdb`, hồ sơ Firefox), không đọc kho hệ thống.
  - `trustCALinux` chỉ hỗ trợ Debian (`update-ca-certificates`) và chỉ chạy khi có `--yes`.
- Sửa (`internal/install/steps_finalize.go`):
  - `trustBrowserOS` luôn chạy, kể cả không `--yes`, vì chỉ ghi kho NSS của chính user (không cần sudo). Nó ghi vào `~/.pki/nssdb` (tạo mới nếu chưa có) và mọi hồ sơ Firefox, bằng `certutil`.
  - Thiếu `certutil` thì chỉ cảnh báo kèm tên gói cần cài.
  - `trustCALinux` giờ hỗ trợ cả Fedora/RHEL (`update-ca-trust`) và cài tệp với quyền 0644.
- Chưa kiểm được `certutil` thật trong container này (không cài được gói); test `TestAddToNSSDB_RealCertutil` chạy khi máy có certutil.

## v0.1.14 — Trình thiết lập: chỉ bắt buộc bước 1–4, không còn kẹt ở bước 12

- Owner làm tới bước 4 thì hỏi "sao còn nhiều bước vậy". Soát lại:
  - Bước 5–9 bị đánh dấu bắt buộc. Bước 5–7 buộc quét QR Zalo/WhatsApp và bật nhóm ngay khi cài.
  - Bước 8–9 web chưa có form (chỉ "Sắp có") nhưng API vẫn đòi `done` mới cho bước 12 hoàn tất. Hệ quả: **không Owner nào hoàn tất được thiết lập**; test cũ còn khẳng định hành vi này ("8, 9" còn thiếu).
- Sửa:
  - `gh/setup/routes.py` `STEPS`: 5–9 → không bắt buộc (bỏ qua được, làm sau ở Console). Bắt buộc còn 1–4 và 12.
  - Web: `steps.ts` + mock; bước 5–7 có nút "Bỏ qua".
  - Test mới `test_setup_finishes_with_only_steps_1_to_4`.

## v0.1.15 — "Để sau" thay cho "Bỏ qua": các bước chưa làm hiện ở Tổng quan

- Owner góp ý: bước 5–11 phải được chuyển sang "thiết lập sau", không phải bỏ qua cho mất.
- Web:
  - Nút ở trình thiết lập đổi thành **"Để sau"**, dấu ở thanh bước cũng thành "để sau".
  - Màn Tổng quan có thẻ **"Việc thiết lập tiếp"** (`screens/queue/SetupFollowUp.tsx`), liệt kê các bước `skipped`. Mỗi mục có nút "Làm ngay" tới màn Console tương ứng: kênh → `/system?tab=channels`, nhóm → `/directory`, quy tắc → `/rules`, agent/tự trị → `/agents`, đội ngũ → `/system?tab=roles`, sao lưu → `/system?tab=storage`.
  - Nút "Đã xong" ẩn mục (localStorage của trình duyệt).
  - Test `test/unit/setup-followup.test.tsx`.
- Còn mở: trạng thái "đã xong" chưa tự suy từ dữ liệu thật (ví dụ kênh đã có phiên active) mà do Owner bấm. Có thể thêm API sau.
- Cùng bản (Owner: "làm thêm cho hoàn chỉnh hết đi"):
  - **Bước 8–9 có form thật** thay "Sắp có".
    - `Step8Agent.tsx`: chọn mẫu, tên, vai trò, câu thử. Sau khi lưu hiện câu trả lời thử, hoặc lý do chưa thử được.
    - `Step9Autonomy.tsx`: chọn mức 3/4, danh sách ranh giới khoá cứng từ `GET /setup/hard-boundaries`, ô xác nhận đã đọc.
  - API bước 8 giờ chỉ cần bước 4 (trước đòi 4–7, mà 5–7 đã thành tuỳ chọn); bước 9 cần 8.
  - **`GET /setup/follow-up`**: bước tuỳ chọn chưa `done` kèm `done` suy từ dữ liệu thật: phiên kênh active, nhóm đang nghe, quy tắc bật, có agent, có >1 người dùng, có lịch sao lưu. Thẻ "Việc thiết lập tiếp" dùng API này; làm xong ở Console thì mục tự biến mất, bỏ nút "Đã xong" + localStorage.
  - Test: `test_follow_up_lists_deferred_steps_and_detects_real_completion`; web test luồng bước 8→9.

## v0.1.16 — Trang "Hướng dẫn kết nối" từng bước; bước 5–11 làm được sau Hoàn tất

- Owner hỏi: "sao chưa có cái hướng dẫn step by step để hoàn thành các kết nối cần thiết".
- Lỗ hổng tìm thấy khi làm: sau Hoàn tất, API chặn mọi `PUT /setup/steps/*` (`SETUP_FINISHED`), trong khi màn Console chưa có chỗ mời người (Quyền hạn chỉ có ma trận quyền) hay đặt lịch sao lưu (Dữ liệu & lưu trữ chỉ có hạn lưu). Việc 10–11 "Để sau" vì thế không bao giờ làm tiếp được.
- API (`gh/setup/routes.py`):
  - `_owner_step(..., after_finish=True)` cho bước tuỳ chọn 5–11: lưu được cả sau Hoàn tất. Bước 1–4, 12 và `skip` vẫn 409.
  - Bước 9 không còn đòi bước 8 `done` trong trình thiết lập, chỉ cần đã có agent (agent có thể tạo ở Console).
  - `GET /setup/follow-up` trả ĐỦ 5–11, `done` = xong trong trình thiết lập HOẶC có dữ liệu thật.
- Web:
  - `src/guide/guideContent.ts`: mỗi việc có vì sao cần, chuẩn bị gì, các bước bấm theo đúng nhãn nút, dấu hiệu xong, và link màn Console.
  - `/guide` (`GuidePage.tsx`): thanh tiến độ x/7, thẻ gập/mở (mở sẵn việc chưa xong đầu tiên), nhắc "Nên làm việc 08 trước" cho việc 09.
  - `/guide/:n` (`GuideStepPage.tsx`): mở đúng form StepN của trình thiết lập trong Console. Lưu xong thì báo "Đã xong: …" và quay về `/guide`.
  - Thẻ "Việc thiết lập tiếp" ở Tổng quan: "Làm ngay" mở `/guide/:n`, thêm nút "Hướng dẫn từng bước".
- Test:
  - API: sau Hoàn tất lưu được bước 10/11, follow-up tự `done`, skip/12 vẫn 409.
  - Web: `test/unit/guide.test.tsx`; `setup-followup` và `shell` cập nhật (26 route).
- Còn mở: Console chưa co gọn thanh menu ở màn hình điện thoại (có từ trước, không riêng trang này).

## v0.1.17 — Nút "Cập nhật ngay" trong Console

- Owner hỏi: "sao không làm luôn nút update phiên bản trong app để khỏi mất công như vậy".
- Vì sao không để api tự cập nhật: container api không dừng/khởi động lại được cả hệ thống, cũng không thay được binary genh trên máy chủ. Nên dùng "hộp thư" giữa hai bên.
- **Hộp thư** `<gốc cài đặt>/run` (`apps/genh/internal/hostlink`), bind mount vào api tại `/var/lib/gh/host`, quyền 0777 vì api chạy uid 10001:
  - `genh.json`: phiên bản đang chạy + cơ chế nhận yêu cầu.
  - `request/update.json`: api ghi khi Owner bấm nút.
  - `update-status.json`: genh ghi `running` rồi `done`/`failed`.
  - `compose.LocateAndSync` tạo thư mục TRƯỚC `up`, để Docker không tự tạo với chủ root.
- **Watcher trên máy chủ** (`internal/autoupdate/request.go`) chạy `genh update --yes --quiet --if-requested [--port N]`:
  - systemd `--user` dùng `gen-harness-update-request.path` với `PathExists`;
  - fallback crontab mỗi phút (marker riêng);
  - macOS dùng launchd `QueueDirectories`;
  - Windows chưa hỗ trợ: Console hiện lệnh để Owner tự chạy.
- `genh install` / `genh update` gọi `publishHostInfo` để cài watcher (idempotent) và ghi `genh.json`.
- `genh update`:
  - tiến trình ngoài cùng xoá yêu cầu trước khi chạy, để watcher không kích lặp;
  - ghi trạng thái; tiến trình con sau self-update chết thì cha ghi `failed`.
- `genh uninstall` gỡ luôn watcher và lịch hằng đêm.
- **API** `gh/system_api/update.py`, quyền `system.manage`:
  - `GET /system/update`: bản đang chạy, bản mới nhất (GitHub Releases, cache Redis 1 giờ), trạng thái `idle/requested/running/done/failed/stalled`. `stalled` là yêu cầu nằm quá 15 phút.
  - `POST /system/update`: ghi yêu cầu. 409 `UPDATER_UNAVAILABLE` / `UPDATE_IN_PROGRESS`. Có ghi Action Log.
- **Web** `src/update/UpdateCard.tsx` (đầu Tổng quan):
  - "Có bản mới vX" + ghi chú phát hành;
  - bấm "Cập nhật ngay" → hộp xác nhận → tiến trình 3 bước;
  - lúc api khởi động lại thì coi lỗi mạng là "đang khởi động lại";
  - xong thì tự tải lại trang.
- Test:
  - genh: `hostlink_test.go`, `request_test.go`;
  - API: `tests/test_system_update.py`;
  - web: `test/unit/update.test.tsx`;
  - E2E cài thật: container api ghi yêu cầu, watcher phải chạy xong trong 7 phút.
- **Bản cài cũ cần chạy `genh update` tay MỘT lần** để có watcher; từ đó về sau chỉ cần bấm nút.

## v0.1.18 — Đăng nhập lại sau cập nhật

- Owner báo sau khi cập nhật: Chrome lại hiện "Not secure", thẻ đăng nhập lệch trái, bị đăng xuất và quên mật khẩu Owner.
- **Web**: `.login` căn giữa (`justify-content: center`); dưới form có dòng "Quên mật khẩu? Trên máy chủ chạy: `~/.gen-harness/bin/genh reset-password`".
- **`genh reset-password`** (`internal/ops/resetpassword.go`) chạy `python -m gh.auth.reset_owner` trong container api (`exec`, api tắt thì `run --rm --no-deps`):
  - đặt mật khẩu tạm (hoặc `--password-stdin`), băm bằng `hash_secret` như đăng nhập;
  - thu hồi mọi phiên của Owner, gỡ khoá PIN, ghi Action Log `auth.password_reset` (actor `system`);
  - genh in "Email đăng nhập / Mật khẩu tạm". Console chưa có chỗ đổi mật khẩu.
  - Không có cơ chế khoá khi nhập sai mật khẩu (chỉ có khoá PIN).
- **Phiên đăng nhập**: mặc định 7 ngày (`session_ttl_hours = 168`), trượt: còn dưới nửa TTL thì `load_session` gia hạn, middleware `SessionCookieRenewal` đặt lại cookie. Phiên PIN giữ nguyên.
- **Tin cậy lại CA**: `genh update` thành công → `RunTrustCA` im lặng (kho NSS của user; kho hệ thống chỉ qua `sudo -n` trên Linux, không bao giờ hỏi). Lệnh mới `genh trust-ca` làm theo yêu cầu và in kết quả từng kho. `internal/install` xuất `TrustBrowserOS`/`TrustSystemOS`/`ExtractCaddyRootCert`/`CACertPath`.
- Test: `tests/test_session_reset.py`; genh `resetpassword_test.go`, `trustca_test.go`, `TestRunUpdate_Success_ReTrustsCA_FailureDoesNot`; web `test/unit/login.test.tsx`.

## v0.1.19 — Tài khoản của tôi

- Owner báo Console thiếu các chức năng tài khoản cơ bản (đổi tên, email, mật khẩu, PIN, xem/đăng xuất thiết bị).
- **API** `gh/auth/account.py` (mọi vai trò, chỉ tài khoản của chính mình; mọi thay đổi ghi Action Log `account.*`):
  - `GET /account` → hồ sơ + `has_pin` + `must_change_password` + các phiên còn hiệu lực (`ip`, `user_agent`, `last_seen_at`, `current`).
  - `PATCH /account {display_name?, email?, current_password?}` — đổi email cần mật khẩu hiện tại, kiểm định dạng + trùng trong tổ chức.
  - `POST /account/password` — ≥12 ký tự, khác mật khẩu cũ; thu hồi mọi phiên KHÁC; tắt `must_change_password`.
  - `POST /account/pin {current_password, new_pin, new_pin_confirm}` — chỉ tài khoản có PIN (Owner), không thì 409 `NO_PIN`.
  - `POST /account/sessions/revoke-others`, `DELETE /account/sessions/{id}` (phiên đang dùng → 409 `CURRENT_SESSION`).
  - Sai mật khẩu hiện tại → 422 `errors.current_password` (không phải 401, để Console không hiểu là mất phiên) + nhật ký `account.password_check_failed` (result `failed`).
- **Migration 0015** (`db/sql/0015_v0119_account.sql`): `core.users.must_change_password boolean NOT NULL DEFAULT false`.
- **Buộc đổi mật khẩu**: `gh.auth.reset_owner` (genh reset-password) bật cờ; `/auth/me` trả `must_change_password`. Web: AppShell chuyển mọi màn Console về `/change-password` ("Đặt mật khẩu mới": mật khẩu tạm + mới + nhập lại, vẫn Đăng xuất được) tới khi đổi xong. genh in "Console sẽ yêu cầu đặt mật khẩu mới ngay khi đăng nhập".
- **Web** `/account` "Tài khoản của tôi" (mở từ menu khối tài khoản ở chân thanh bên → "Tài khoản của tôi"): Hồ sơ, Đổi mật khẩu, Đổi mã PIN (Owner), Phiên đăng nhập (+ "Đăng xuất các thiết bị khác"). Lỗi theo ô, toast, trạng thái đang tải; lưu tên → invalidate `me` nên thanh bên đổi ngay.
- Hợp đồng `packages/contracts/src/account.ts`; mock `test/mock-api.ts` (Owner có sẵn 2 phiên thiết bị khác; `MOCK_MUST_CHANGE=1` hoặc reset `{mustChangePassword: true}` để xem màn buộc đổi).
- Test: api `tests/test_account.py`; web `test/unit/account.test.tsx`.

## v0.1.20 — Sao lưu & khôi phục trên giao diện

- Owner cần xem/chạy/tải/khôi phục bản sao lưu ngay trong Console (Điều khiển hệ thống › Dữ liệu & lưu trữ), không phải gõ `genh backup`/`genh restore`.
- **Danh mục sao lưu** (`gh/backup.py`, vẫn là `backups/manifest.json` trong ObjectStore — volume `gh_objects`):
  - mỗi bản thêm `trigger`: `manual` / `scheduled` / `pre-update` / `pre-restore` / `pre-import`; bản cũ không có → `null` ("Không rõ");
  - CLI `run` đọc nguồn từ biến môi trường `GH_BACKUP_TRIGGER` (genh truyền `-e`), KHÔNG qua cờ — `genh update` chạy backup trong container api CŨ, cờ lạ sẽ làm bản cũ thoát lỗi;
  - vòng đời GFS giữ thêm **mọi bản trong 24 giờ qua** (`RECENT_KEEP_HOURS`) — trước đây bấm sao lưu lần hai trong ngày (hoặc bản an toàn trước khi khôi phục) xoá bản cùng ngày;
  - lịch tự động tính `time_of_day` theo **múi giờ tổ chức** (trước tính UTC);
  - khoá Redis `gh:backup:lock` để lịch và "Sao lưu ngay" không ghi đè danh mục của nhau.
- **API** `gh/system_api/backups.py`:
  - `GET /system/backups` (`system.manage`): danh sách (mới nhất trước) + lịch + `job` + `restore`;
  - `POST /system/backups` (`system.manage`): xếp hàng job arq `backup_now` (worker), tiến trình ở Redis `gh:backup:job` (queued → running → done/failed; quá 30 phút → stalled). 409 `BACKUP_IN_PROGRESS`;
  - `GET /system/backups/download?key=` — **chỉ Owner + PIN** (`backup.download`): trả bytes ĐÃ MÃ HOÁ (như `genh backup --to`);
  - `POST /system/backups/restore {key, confirm}` — **chỉ Owner + PIN** (`backup.restore`) + `confirm == "KHÔI PHỤC"` (422 nếu sai): ghi `request/restore.json`. 409 `RESTORE_UNAVAILABLE` (watcher cũ) / `RESTORE_IN_PROGRESS` / `UPDATE_IN_PROGRESS`; `POST /system/update` cũng 409 khi đang khôi phục;
  - `PUT /system/backups/schedule {frequency, time_of_day}` (`system.manage`): sửa `settings.backup` (giữ `retention_count`/`destination` của bước 11).
  - Mọi thao tác ghi Action Log `backup.*`.
- **Hộp thư genh** (`internal/hostlink`): thêm `request/restore.json` + `restore-status.json` (running → done/failed, kèm `safety_key`); `genh.json` có `requests: ["update","restore"]` để Console biết watcher nhận khôi phục.
- **Watcher chung** (`internal/autoupdate/request.go`): chạy `genh handle-requests` (update.json → `genh update --if-requested`, restore.json → `genh restore --if-requested`; cập nhật ưu tiên). systemd path unit có 2 dòng `PathExists=`, cron `{ [ -f update ] || [ -f restore ]; }`, launchd vẫn `QueueDirectories`. Tên unit giữ nguyên nên `genh update` cài đè đúng; `genh update --if-requested` cũ vẫn chạy.
- **`genh restore`** (`ops.RunRestore`, dùng cho cả lệnh tay lẫn Console): sao lưu an toàn (`pre-restore`) → `stop api worker` → `run --rm --no-deps api python -m gh.backup restore` → migrate → `up -d` → chờ `/ready`; lỗi giữa chừng → khôi phục lại bản an toàn + `up -d`. Khoá phải đúng dạng `backups/<YYYYMMDDTHHMMSSZ>-<8 hex>.pgcustom.enc`.
- **Web** `screens/system/BackupPanel.tsx` (đầu tab Dữ liệu & lưu trữ): bảng Thời điểm / Nguồn / Dung lượng / Mã hoá; "Sao lưu ngay" (hỏi lại 2 giây/lần tới khi xong); Tải về + Khôi phục chỉ hiện cho Owner (PIN tự hỏi qua client); hộp "Khôi phục" bắt gõ `KHÔI PHỤC`; tiến trình 3 bước như thẻ cập nhật, lỗi mạng lúc api tắt = đang khởi động lại, xong tự tải lại trang; sửa lịch (tần suất + giờ). Watcher cũ → hiện lệnh `genh update` chạy một lần.
- **Sửa từ review v0.1.19**:
  - API chặn `must_change_password`: `current_user` trả 403 `PASSWORD_CHANGE_REQUIRED` cho mọi route trừ `/auth/*`, `GET /account`, `POST /account/password`; client (`onPasswordChangeRequired`) chuyển về `/change-password`;
  - màn "Đặt mật khẩu mới" dùng lời chung (không nhắc `genh reset-password` — thành viên được mời cũng thấy màn này).
- Contracts: `BackupsPage`/`api.backups.*`, `responseType: 'blob'`. Mock: `test/mock-p4-system.ts` (mỗi GET tiến một bước; `MOCK_RESTORE_UNAVAILABLE=1` mô phỏng watcher cũ).
- Test: api `tests/test_system_backups.py`; genh `hostlink_test.go` (`TestRestoreRequestRoundTrip`, `TestPendingDispatch`), `backup_test.go` (`TestRunRestore_*`, `TestRunRestoreRequest_*`), `request_test.go`; web `test/unit/backups.test.tsx`; E2E cài thật thêm bước "Nút Khôi phục".
- **Bản cài cũ**: bấm "Cập nhật ngay" lên v0.1.20 là watcher tự cài lại có nhận khôi phục (không cần chạy tay).

## v0.1.21 — Gen v1 (Đợt A1–A3): khung chat, dẫn đường trên UI, nguồn Jev

Thiết kế: `docs/design/gen-v1.md` (mục 9 = quyết định đã chốt). Cờ `gen.enabled` — mặc định BẬT, chỉ vai trò Owner.

- **Cờ & cấu hình** (`gh/gen/store.py`): `core.organizations.settings->'gen'` = `{enabled, roles, retention_days}`, mặc định
  `{true, ["owner"], 90}`. `/auth/me` thêm `features.gen`. `GET/PATCH /gen/settings` (PATCH chỉ Owner; `retention_days` 7–3650).
  Vai trò khác gọi `/gen/*` → 403 `GEN_DISABLED`.
- **A1 — khung chat + trả lời chỉ đọc**
  - Web `src/gen/`: `GenPanel` (khung phải trong AppShell; nút ✦ ở Header; mở/đóng nhớ **theo id người dùng** ở localStorage
    `gh-gen`; điện thoại ≤ 760px = tấm phủ toàn màn hình), `genClient` (gửi, nhận bước, polling dự phòng), `genStore`.
  - API `gh/gen/`: `routes.py` (`POST /gen/turns` → 202 {turn_id, conversation_id}; `GET /gen/turns/{id}`; `POST /gen/turns/{id}/ack`;
    `GET /gen/conversations`, `GET …/{id}/messages`, `DELETE …/{id}`), `engine.py` (vòng plan → tool → observe, tối đa 6 vòng,
    envelope sai → hỏi lại 1 lần → "Gen chưa hiểu"; hết chuỗi model → câu tĩnh + mở API & Model, làm sáng `api.bindings`),
    `envelope.py` (Pydantic `extra="forbid"` ⇔ `packages/contracts/src/gen.ts`).
  - Model: khoá mới **`core.gen`** trong `CORE_AGENT_KEYS` → Owner gán ở màn API & Model; gọi qua `ModelRouter` (xoay khoá, hạn mức,
    ngắt mạch, chuyển hướng như mọi agent).
  - **Tool đọc** (`tools.py`): overview.summary, queue.list, draft.list/get, profile.search/get, opportunity.list, people.care,
    audit.list, system.health, guide.list, screens.list. Mỗi tool gọi **nội bộ qua ASGI** endpoint GET có sẵn bằng **cookie phiên của
    chính người hỏi** → RBAC/phạm vi/che dữ liệu y như UI; kiểm quyền trước + endpoint tự kiểm lại. Kết quả cắt ≤ 4 KB / 20 dòng;
    id trong kết quả được ghi lại cho validator.
  - **Lưu hội thoại**: migration **0016** (`db/sql/0016_v0121_gen.sql`) `agent.gen_conversations` + `agent.gen_messages` (RLS
    org_isolation, GRANT gh_app). Chỉ CHỦ hội thoại đọc (Owner cũng không đọc chat của người khác — §9.3). Job worker
    `purge_gen_conversations` 03:40 hằng ngày xoá hội thoại quá hạn lưu (mặc định 90 ngày). Nằm trong `pg_dump` sao lưu.
  - **Action Log**: mọi bước `actor_type="agent"`, `actor_id="gen"`, `autonomy_level=1`, `detail.on_behalf_of=<user id>` +
    conversation_id/turn_id/model/provider/decider: `gen.turn`, `gen.query`, `gen.navigate`, `gen.highlight`, `gen.tour`,
    `gen.suggest`, `gen.answer` (lỗi), `gen.decide` (Jev), `gen.tour_step` (ack). Không ghi nội dung hỏi/đáp — chỉ digest.
  - **Truyền kết quả: WS sẵn có, không SSE.** Lý do: Console đã giữ một kết nối `/api/v1/ws` (xác thực cookie, tự nối lại có
    backoff, qua nginx/proxy đã cấu hình); SSE cần thêm một kết nối dài + cấu hình buffering proxy riêng. Hub thêm lọc **`to_user`**
    (`realtime.publish(..., to_user=)`); sự kiện `gen.*` thiếu `to_user` bị bỏ (không bao giờ phát cho cả tổ chức). Chống mất
    bước: web song song hỏi `GET /gen/turns/{id}` mỗi 1,2 s tới khi xong (trạng thái lượt ở Redis `gh:gen:turn:<id>`, 1 giờ), ghép theo
    `seq`, bước `ui` chỉ chạy một lần; khi `gen.done` tới thì đối chiếu lần cuối. Model hiện chưa stream token → "stream" theo bước.
- **A2 — giao thức hành động UI**
  - `navigate(screen, params)`, `highlight(target, message)`, `tour(steps[])` (Tiếp / Quay lại / Xong, bấm thẳng vào phần tử cũng sang
    bước kế, Esc thoát). `director.ts` tự mở đúng màn + tab mục tiêu cần, chờ phần tử 4 s (MutationObserver), không thấy → bong
    bóng "Em không thấy phần này…" + ack `target_missing`. `Spotlight.tsx`: nền mờ + viền phát sáng, theo `prefers-reduced-motion`.
  - Registry: `packages/contracts/src/genTargets.ts` (39 mục tiêu: Tổng quan, Hướng dẫn kết nối, Điều khiển hệ thống — kênh/bộ não/
    lưu trữ/sao lưu, API & Model, Tài khoản, Quy tắc, Agent; mục tiêu dòng `overview.queue.row:<id>`, `guide.item:<n>`).
    API đọc bản xuất `apps/api/gh/gen/registry.json`; `test/unit/gen-targets.test.ts` quét `apps/web/src` (registry ⇔ `data-gen-target`)
    và so JSON — đổi registry/guide thì chạy `GEN_WRITE=1 npx vitest run gen-targets`.
  - **Validator server** (`validator.py`): màn tồn tại + người hỏi xem được (RBAC; `guide` cần `system.manage`, `account` ai cũng được);
    mục tiêu có trong registry và thuộc đúng màn đang mở (navigate trước mới được chỉ màn khác); id dòng / `params.id` phải vừa có trong
    kết quả tool của lượt; tham số URL chỉ `tab,id,q,filter,status`. Sai → bỏ, Action Log `blocked`, báo lý do cho model ở vòng kế.
- **A3 — nguồn Jev (System One)**
  - Kind mới **`system_one`** ở Bộ não AI: `POST /providers {kind:"system_one", keys:[…]}` — địa chỉ mặc định
    `https://openrouter.ai/api/v1`, model mặc định `typesafe/jev-1.13` (hoặc `https://api.typesafe.ai`); khoá lưu mã hoá như khoá
    khác (nhãn `JEV-KEY-01`). **Không** vào chuỗi sinh chữ của ModelRouter. "Kiểm tra" = một lượt quyết định thử.
    Web: thẻ "Jev — quyết định nhanh cho Gen" ở tab Bộ não AI (form Địa chỉ/Model/Khoá → "Lưu & kiểm tra"; đã có → trạng thái + Kiểm tra).
  - `gh/gen/decider.py`: `Decider` protocol; `JevDecider` (ý định câu hỏi + mục tiêu UI kế tiếp từ danh sách hữu hạn, trần **1,5 s**,
    độ tin cậy < 0,5 / lỗi / chậm → None ⇒ đi đường LLM) làm gợi ý trong prompt; `LlmDecider` khi chưa có Jev (không gọi thêm model).
  - **Schema Jev là giả định, gói trong một chỗ** `gh/gen/jev.py` (TODO `jev-schema`), test máy chủ HTTP giả `tests/test_gen_jev.py`:
    - OpenRouter: `POST {base}/chat/completions` `{model, messages, temperature:0, response_format:{type:"json_object"}}`, mong
      `choices[0].message.content` = `{"choice": "<một lựa chọn>", "confidence": 0..1}` (hoặc đúng nguyên văn lựa chọn);
    - TypeSafe trực tiếp: `POST {base}/v1/systemone` `{model, task:"choice", input, context, options:[…]}` → `{choice, confidence}`;
      nhận thêm `label`/`score`/`probability`, bọc `output`/`result`/`data`. Có tài liệu chính thức thì sửa file này + test.
- Mock offline: `test/mock-gen.ts` (kịch bản: "gấp/hôm nay" → tra + làm sáng hàng đợi + đề xuất; "jev/khoá/model" → tour 3 bước;
  "sao lưu" → mở tab lưu trữ + chỉ "Sao lưu ngay"); mock providers nhận `system_one`.
- Test: api `tests/test_gen.py` (lượt đầy đủ, validator chặn mục tiêu/dòng/màn bịa, tool theo RBAC 3 vai trò, riêng tư + hạn lưu,
  Action Log + chuỗi băm, WS `to_user`, provider Jev + Kiểm tra), `tests/test_gen_jev.py`; web `test/unit/gen.test.tsx`
  (khung chat, nút bật/tắt theo người, làm sáng, tour, target_missing), `test/unit/gen-targets.test.ts`.
- Chưa làm (A4/v2): đề xuất thao tác có xác nhận, `prefill`; mở Gen cho vai trò khác (đổi `roles` trong settings khi ổn định).

## v0.1.22 — Đợt B1–B3: Quản lý người dùng, Thông tin công ty, Trợ giúp

- **B1 — Người dùng** (Điều khiển hệ thống › tab **Người dùng**, `?tab=users`). API mới `gh/auth/users.py` (`roles.manage`, mặc định chỉ Owner):
  - `GET /users` → `{items: [{id, display_name, email, role, status: active|inactive, must_change_password, last_login_at, created_at, is_self}], roles}`;
  - `POST /users {display_name, email, role}` (PIN `user.manage`) → `{user, temp_password}` — mật khẩu tạm hiện **một lần**, bật `must_change_password` (như bước 10);
  - `PATCH /users/{id}/role {role}` (PIN `roles.change`), `POST /users/{id}/deactivate|reactivate|reset-password` (PIN `user.manage`);
    khoá và đặt lại mật khẩu **thu hồi mọi phiên** của người đó; đặt lại trả mật khẩu tạm mới + buộc đổi.
  - Bất biến: 409 `SELF_CHANGE` (không đổi vai trò/khoá/đặt lại chính mình — dùng Tài khoản của tôi), 409 `LAST_OWNER` (không bao giờ mất
    Owner cuối cùng còn hoạt động); chỉ mời/gán vai trò dưới Owner (Owner cần PIN riêng → chỉ tạo ở trình thiết lập).
  - Action Log: `user.invited`, `user.role_changed` (from/to), `user.deactivated` (sessions_revoked), `user.reactivated`, `user.password_reset`.
  - Thao tác PIN mới: `user.manage` ("Mời / khoá / đặt lại mật khẩu người dùng").
  - Web `screens/system/UsersTab.tsx`: bảng Người dùng / Vai trò (ô chọn, không cho hàng của mình và Owner) / Trạng thái (Hoạt động · Chưa đăng nhập ·
    Chờ đổi mật khẩu · Đã khoá) / Đăng nhập gần nhất; hộp Mời; hỏi lại trước Khoá / Đặt lại mật khẩu; hộp mật khẩu tạm có nút "Chép email + mật khẩu".
- **B2 — Tổ chức** (tab **Tổ chức**, `?tab=org`). `GET /system/org` (`system.read`) / `PATCH /system/org` (chỉ Owner): tên tổ chức, múi giờ,
  tiền tệ, "Sếp tự xưng là", "Agent gọi Sếp là". Kiểm bằng **đúng hàm của bước 3** (`gh.setup.routes.validate_org`, bước 3 cũng dùng nó);
  không đổi gì thì không ghi; Action Log `org.updated` kèm `changes` (cũ → mới). Web `OrgTab.tsx` dùng lại `step3Errors` + câu xem trước
  `addressingPreview` của bước 3; vai trò khác Owner thấy chỉ đọc.
- **B3 — Trợ giúp** (`/help`, `help/HelpPage.tsx`; mục **Trợ giúp** trong menu tài khoản ở chân thanh bên, cạnh "Tài khoản của tôi").
  `GET /system/about` (mọi người đăng nhập): `{version, org_name, timezone, role}` — `version` đọc `genh.json` (cùng nguồn với "Cập nhật ngay",
  hàm `update.running_version()`; bản phát triển → null). Trang có: Giới thiệu (phiên bản), Hỏi Gen (+ nút Mở Gen khi bật), Hướng dẫn kết nối
  (chỉ vai trò `system.manage`), lệnh genh (update, reset-password, trust-ca, backup, status), **Báo lỗi** = chép thông tin chẩn đoán
  (phiên bản, trang, trình duyệt, màn hình, thời điểm — không cookie/khoá).
- **Gen**: màn mới `help` (ai cũng được — `EXTRA_SCREEN_PERMISSION`), 12 mục tiêu mới `system.tab.users|org`, `system.users.list|invite|temp_password`,
  `system.org.form|save`, `help.version|ask_gen|guide|genh|report`; `registry.json` ghi lại (`GEN_WRITE=1 npx vitest run gen-targets`).
- Contracts `packages/contracts/src/users.ts` (`api.users.*`, `api.org.*`, `api.about`). Icon mới `bug`, `lock-simple-open`.
- Mock: `/users*`, `/system/org`, `/system/about` trong `test/mock-api.ts` (khoá tài khoản chặn đăng nhập, ghi `lastLoginAt`).
- Test: api `tests/test_users.py` (PIN, kiểm dữ liệu, người được mời bị buộc đổi mật khẩu, khoá thu hồi phiên + chặn đăng nhập, đặt lại mật khẩu,
  SELF_CHANGE, LAST_OWNER, 403 cho vai trò khác, org dùng lại kiểm bước 3 + log, about đọc genh.json); web `test/unit/users.test.tsx`.
- **Sửa test cũ**: `e2e/phase2.spec.ts` "setup steps 4–7 and 12" hỏng từ khi bước 8–9 có form thật và 5–11 thành tuỳ chọn (còn chờ "Sắp có" và
  "Còn bước bắt buộc chưa xong: 8, 9"). Nay: kiểm form 8/9, "Để sau", lưu 10–11 mặc định, Hoàn tất vào Tổng quan, state `finished` + 8–9 `skipped`.

## v0.1.23 — Đợt B4–B7: điện thoại, trang lỗi/404, chuông thông báo, sáng/tối

- **B4 — điện thoại** (điểm gãy `max-width: 760px`, `src/lib/useMediaQuery.ts`): thanh bên thành **ngăn kéo** trượt trái (nút ☰ `.hd-menu`
  ở header, luôn hiện đủ tên mục; tự đóng khi đổi trang / Esc / chạm nền), header một dòng (ẩn chip/nhóm breadcrumb; ≤600px ẩn 3 viên
  trạng thái, ≤400px ẩn "Góc nhìn đã lưu"), dải tab cuộn ngang trong dải, nội dung đệm 12px. Khung Gen phủ **toàn màn** (z 860, trên
  ngăn kéo), tạm ẩn khi Gen đang làm sáng một phần tử (`.app[data-spot]`). Máy tính: bố cục không đổi (`.hd-status` là `display: contents`).
- **B5 — trang lỗi / 404** (`src/shell/ErrorPage.tsx`, `styles/errors.css`): `ErrorBoundary` bọc vùng nội dung trong khung (thanh bên/header
  vẫn dùng được, đổi trang là thử vẽ lại) + lưới an toàn ở `main.tsx`; `errorElement` của router → `RouteErrorPage`. Trang lỗi: "Đã có lỗi
  xảy ra", **mã lỗi** `ERR-xxxxx-xxxx` (ghi kèm console — dán khi Báo lỗi), Thử lại / Tải lại trang / Về trang chủ, chi tiết kỹ thuật thu gọn.
  404 (`NotFoundPage`, thay `NotFoundScreen` cũ): nêu đường dẫn, Về trang chủ / Quay lại.
- **B6 — chuông thông báo** (header, `src/shell/NotificationBell.tsx`): bảng mới **`core.notifications`** (migration **0017**, RLS `org_isolation`
  như 0012/0016, GRANT `gh_app`); API `gh/notifications.py` (mọi người đã đăng nhập, chỉ của **chính mình**):
  - `GET /notifications?limit=20` → `{items: [{id, kind, title, body, link, created_at, read}], unread}`;
  - `POST /notifications/read {ids?}` (bỏ trống = đọc hết) → `{unread}` — không ghi Action Log (`actionlog.exempt()`, thao tác riêng tư);
  - `notify(db, org, user_ids, kind=…, title=…, body=…, link=…, redis=…)` ghi trong cùng transaction + đẩy WS **`notification.new`** chỉ tới
    người nhận (`to_user`; `realtime.PRIVATE_PREFIXES` = `gen.`, `notification.` — thiếu người nhận thì bỏ, không phát cả tổ chức).
  - Nguồn hiện có: đổi vai trò / đặt lại mật khẩu / mở khoá tài khoản (báo người bị đổi), sao lưu xong/lỗi (báo các Owner; cả lỗi sao lưu
    theo lịch). Thêm nguồn mới = gọi `notifications.notify(...)`.
  - Web: huy hiệu số chưa đọc (9+), danh sách 20 gần nhất, bấm → đánh dấu đã đọc + mở `link`, "Đánh dấu đã đọc hết"; WS chèn thẳng vào
    bộ đệm (`applyEvent`), hỏi lại mỗi 2 phút phòng rớt socket. Contracts `packages/contracts/src/notifications.ts` (`api.notifications.*`).
- **B7 — sáng/tối**: bảng màu sáng ghi đè đúng các biến token trong `styles/theme.css` (`:root[data-theme="light"]`; tối = Nocturne gốc, không
  đổi điểm ảnh). Mặc định **theo hệ thống** (`prefers-color-scheme`, đổi máy là đổi ngay); nút ở header vòng Theo hệ thống → Sáng → Tối,
  lưu localStorage `gh-ui` theo **từng người dùng** (`themeByUser`) + lựa chọn gần nhất (`theme`) cho trang đăng nhập;
  `public/theme-init.js` (tệp riêng vì CSP) đặt `data-theme` trước khi React chạy để không nháy.
- Icon mới: `sun`, `circle-half`, `house`.
- Mock: `/notifications*`, thông báo khi đổi vai trò/đặt lại mật khẩu/mở khoá, hook `POST /api/v1/__mock/notify` (WS chỉ tới người nhận).
- Test: api `tests/test_notifications.py` (chỉ người nhận thấy, đọc từng cái/đọc hết, không ghi Nhật ký, 401, cắt độ dài, WS `to_user`);
  web `test/unit/basics-b4-b7.test.tsx`; e2e mới `e2e/basics.spec.ts` (10 màn chính ở 375px không cuộn ngang, ngăn kéo, Gen toàn màn,
  chuông cập nhật qua WS, 404, sáng/tối nhớ sau tải lại).
- **Sửa `e2e/visual.spec.ts`** (header lệch vì nút Gen ✦ — thiết kế gốc không có): các nút thêm sau thiết kế (`.hd-gen`, chuông, sáng/tối)
  được **kiểm trước** (hiện, nằm gọn trong header, header vẫn cao 58px) rồi mới ẩn khi so điểm ảnh với thiết kế — ngưỡng giữ nguyên 1,5%.

## v0.1.24 — Đợt A4: Gen v2 bước 1 — đề xuất thao tác có xác nhận

Thiết kế: `docs/design/gen-v1.md` §10. Gen **không tự ghi**; chỉ đề xuất, người dùng bấm Xác nhận mới làm.

- **Envelope** (`gh/gen/envelope.py` ↔ `packages/contracts/src/gen.ts`): model trả `propose` (`draft_message` | `reminder` |
  `assign`); server phát bước **`proposal`** `{id, type, fields, summary, labels, target, requires_pin, status, result?}`.
  Tool đọc mới: `task.list` (`GET /tasks`, `queue.read`), `staff.list` (`GET /gen/assignees`, `queue.act` — tên + vai trò, không email).
  Prompt hệ thống có giờ hiện tại theo múi giờ tổ chức; giờ không kèm múi → hiểu theo múi giờ tổ chức.
- **Kiểm đề xuất** (`gh/gen/proposals.py`): quyền loại (`action.draft` / `queue.act`) + mục tiêu registry mới
  (`workbench.drafts` **nhạy cảm** → cần PIN, `tasks.new` cần `queue.act`, `tasks.row:<id>`, `inbox.row:<id>` — đã gắn
  `data-gen-target` trên màn Bàn làm việc / Việc & Nhắc hẹn / Hộp thư); id phải vừa thấy trong kết quả tool của lượt; người
  được giao phải còn hoạt động; nhắc việc mặc định giao chính người hỏi; tóm tắt do hệ thống viết; ≤3 đề xuất/lượt; lưu Redis
  `gh:gen:proposal:{id}` 24 giờ. Bị chặn → Action Log `gen.propose` `blocked` + báo model lý do ở vòng sau.
- **API mới** (cờ Gen + vai trò như v1 — `gen_user`):
  - `GET /gen/assignees` → `{items: [{id, name, role, me}]}`;
  - `POST /gen/proposals/{id}/confirm {fields}` → đề xuất đã cập nhật (`status: confirmed`, `result {type, id, code, screen}`).
    Chỉ sửa được trường trong `GEN_PROPOSAL_EDITABLE` (trường khoá khác giá trị → 422). Kiểm lại quyền (403 + log `blocked`),
    PIN nếu nhạy cảm (423), chống bấm trùng (khoá Redis 60 s; 409 `GEN_PROPOSAL_BUSY`; đã xử lý → 409 `GEN_PROPOSAL_DECIDED`;
    của người khác / hết hạn → 404). Thực hiện bằng **gọi nội bộ (ASGI) endpoint sẵn có** với phiên + CSRF của người bấm:
    `POST /drafts` (kind `message`, nhóm → đích gửi theo kênh của nhóm; luôn **chờ duyệt**), `POST /tasks`, `PATCH /tasks/{id}`,
    `POST /inbox/{id}/assign`. Endpoint lỗi → trả nguyên mã lỗi, đề xuất vẫn chờ (thử lại được). Trước lời gọi nội bộ,
    request ngoài **commit** (không giữ khoá dòng `core.sessions` khi gia hạn phiên/trượt phiên PIN — tránh hai request chờ
    nhau) rồi đặt lại `app.org_id` cho phần ghi còn lại; IP người bấm chuyển qua `x-forwarded-for`. Huỷ khi đang thực hiện → 409.
    Thẻ giao mục Hộp thư ghi rõ mã + tiêu đề mục (theo phạm vi `queue.read`).
  - `POST /gen/proposals/{id}/cancel`.
  - Trạng thái đề xuất ghi lại vào tin trả lời đã lưu (`store.update_proposal_step`) — mở lại hội thoại không hiện lại nút.
- **Action Log**: `gen.proposal_confirmed` / `gen.proposal_cancelled` — `actor_type="user"`, `detail.via="gen"`, `proposal_id`,
  `type`, `endpoint`, `edited`, `fields_digest` (không lưu nội dung); endpoint gốc vẫn ghi dòng của nó (`task.created`, …).
- **Nhắc việc đến giờ**: migration **0018** `biz.tasks.reminded_at` + chỉ mục một phần; job worker `task_reminder_scan` (mỗi phút,
  `gh/biz/queue/jobs.py`, `FOR UPDATE SKIP LOCKED`) → thông báo chuông `task.reminder` cho người phụ trách (chưa giao → các Owner),
  mỗi mốc nhắc một lần; `PATCH /tasks/{id}` đổi `remind_at` → đặt lại `reminded_at` để nhắc theo mốc mới; việc xong/huỷ không nhắc.
- **Web**: `src/gen/ProposalCard.tsx` (+ `proposalModel.ts`) — thẻ "Đề xuất · …", tóm tắt, trường điền sẵn, huy hiệu "Cần mã PIN",
  **Xác nhận / Sửa / Huỷ** (Sửa: form tiêu đề/nội dung, giờ nhắc/hạn `datetime-local`, ưu tiên, người được giao từ `/gen/assignees`;
  chỉ gửi trường đã đổi), sau xác nhận hiện mã kết quả + nút mở màn. Mock: kịch bản "nhắc" + `/gen/proposals/*`, `/gen/assignees`.
- **Test**: api `tests/test_gen_proposals.py` (xác nhận có sửa + Action Log via=gen, không xác nhận hai lần, nhắc việc → chuông một
  lần + nhắc lại khi đổi mốc, nháp tin cần PIN + vẫn chờ duyệt, gán việc chặn id bịa + trường khoá, huỷ, đề xuất người khác,
  **từ chối quyền**: vai trò chưa bật Gen, Kiểm toán thiếu `queue.act`/`action.draft` bị chặn cả lúc đề xuất lẫn lúc xác nhận,
  tắt Gen chặn cả Owner, lỗi endpoint trả nguyên); web `test/unit/gen-proposals.test.tsx`.
- Chưa làm (bước sau của v2): duyệt/gửi bản nháp thay người dùng, đề xuất cho Deal/Vụ việc, e2e Playwright cho thẻ đề xuất.

## v0.1.25 — Đợt C1: Lọc đầu Hộp thư (trùng, rác, điểm) — dùng Jev khi có

Lớp lọc đầu chạy **sau** khi đơn vị ý nghĩa vào kho sạch — không chặn đường nhập, không sửa dữ liệu gốc.

- **Migration 0019** `refinery.item_marks` (PK `item_type, item_id`; hiện chỉ `unit`): `text_hash` (sha256 văn bản chuẩn hoá),
  `simhash` (64 bit, lọc thô), `norm_text` (≤600 ký tự), `duplicate_of/duplicate_kind (exact|near)`, `is_spam/spam_reason`,
  `quality 0–100` + `reason`, `source (heuristic|jev)`, `heuristic_quality/heuristic_spam` (luôn tính — đo độ khớp Jev ↔ quy tắc),
  `latency_ms`, `version`. RLS `org_isolation` + GRANT `gh_app` như 0016/0017.
- **Logic** `gh/refinery/triage.py`: văn bản = tin thô làm chứng cứ (không có → kết luận), chuẩn hoá (thường, bỏ dấu, bỏ link).
  Trùng: sha256 bằng nhau = `exact`; Jaccard 3-gram ≥ 0.75 (lọc trước bằng độ dài + simhash) = `near`; tin ngắn < 40 ký tự chỉ
  tính trùng khi cùng người/nhóm; mục gốc = mục xuất hiện trước; cửa sổ 14 ngày. Rác + điểm: quy tắc tất định (link, từ quảng cáo,
  nhiều SĐT, viết hoa, ký tự lặp, không có chữ; điểm từ độ tin, thực thể, loại sự kiện). Có Jev và `use_jev` → `Decider.classify`
  (mới, trên `JevDecider`/`LlmDecider`; trần 1,5 s, ≤4 lượt song song, 3 lỗi liên tiếp thì thôi gọi) chọn 1 trong 4 mức
  (rác/ít/trung bình/cao); điểm = 60% Jev + 40% quy tắc. Jev lỗi/chậm/độ tin thấp → quy tắc (KHÔNG gọi model lớn từng mục — chi phí).
- **Worker**: hook `triage` trên `gh.clean.ready` (consumer group riêng) + cron `triage_sweep` mỗi 5 phút (vét mục sót). Idempotent:
  khoá tư vấn theo tổ chức, `ON CONFLICT` chỉ ghi đè khi `version` mới hơn; commit theo phần 50 mục, ≤1000 mục/lượt.
- **Cấu hình** `core.organizations.settings->'triage'` `{enabled: true, min_score: 30, use_jev: true}`:
  `GET /refinery/triage/settings` (mọi người), `PATCH` **chỉ Owner** → Action Log `refinery.triage_settings_changed`
  (`detail.before/after`). `GET /refinery/triage/summary?days=7` (`queue.read`): tổng, giữ lại, trùng (exact/near), rác, điểm thấp,
  chờ lọc, điểm TB, Jev (số lượt, độ trễ TB, tỉ lệ khớp rác với quy tắc).
- **Hộp thư**: `GET /inbox` thêm `hide_junk=true` (ẩn trùng/rác/điểm < ngưỡng; đếm tab theo bộ lọc) + `triage {enabled, min_score,
  hidden}`; mỗi mục có `triage {duplicate_of, duplicate_kind, spam, spam_reason, score, low_score, reason, source}` (null khi tắt
  lọc hoặc chưa lọc). Web: huy hiệu **Trùng / Rác / Điểm N** (lý do ở tooltip), công tắc **"Ẩn rác & trùng"** (`?hide=1`).
- **Điều khiển hệ thống › Bộ não AI**: thẻ **"Lọc đầu Hộp thư"** (`TriageCard`) — bật/tắt, dùng Jev, ngưỡng điểm (chỉ Owner sửa),
  số liệu 7 ngày.
- **Gen**: tool đọc `refinery.summary` (`queue.read`); mục tiêu mới `inbox.hide_junk`, `system.brain.triage` (registry.json đã xuất lại).
- **Test**: api `tests/test_triage.py` (chuẩn hoá/băm, quy tắc, luật trùng, job idempotent + hook + tắt, Jev giả + rơi về quy tắc,
  API Owner-only + Action Log, Hộp thư + ẩn + tắt, summary, RLS); web `test/unit/triage.test.tsx`.
- Chưa làm: đo độ chính xác có nhãn người (nút "Không phải rác"), lọc cho cảnh báo/bản nháp, gộp mục trùng thành một thẻ.

## v0.1.26 — Đợt D1 (lát đầu): Gen đọc Kho Ryan qua Gen-hub — chỉ đọc, chỉ Owner

Thiết kế: `docs/design/gen-hub-link.md` §3. Boss đã chốt (29/09/2026): (1) bật "Gen đọc Kho" — **chỉ Owner, chỉ đọc**;
(2) cho gửi nội dung Kho sang model đám mây **có che dữ liệu nhạy cảm** (gen-v1 §9.2); (3) Jules: 1 tài khoản, tối đa 5
việc/ngày — **chưa làm** ở bản này (chỉ giữ ghi chú trong thiết kế). Tính năng **TẮT** tới khi Owner cấu hình và bấm Kiểm tra xanh.

- **Migration 0020** `agent.hub_links` (một dòng/tổ chức): `server_id → agent.mcp_servers` (ON DELETE SET NULL), `enabled`
  (mặc định false), `token_expires_at`, `expiry_notified_at`, `last_ok_at`, `last_error`, `updated_by/at`. RLS `org_isolation` +
  GRANT `gh_app`. **Token không nằm ở bảng này**: mã hoá phong bì (`gh.crypto`, AAD `mcp_server_auth`) trong
  `agent.mcp_servers.auth_enc` như mọi máy chủ MCP — không lưu rõ, không log, không trả qua API (chỉ `has_token`).
  Không có bảng chứa dữ liệu Kho (không chép Kho vào Postgres).
- **Tách lõi (không đổi hành vi)** `gh/mcp_api/invoke.py`: `invoke_tool(db, redis, client, *, org_id, tool, agent_key, args,
  actor, summarize)` + `discover(...)` — route `POST /mcp/tools/{id}/call` và `/discover` gọi lại; hub link dùng chung, **không có
  đường gọi MCP thứ hai**. Lỗi máy chủ → `McpCallFailed` (409 `MCP_CALL_FAILED`, như cũ).
- **Module** `gh/hub_link/{routes,service}.py`, gắn `/api/v1/hub`:
  - `GET /hub/link` (`system.read`) — `{configured, enabled, status: off|ok|expiring|expired|error, endpoint, has_token,
    allow_public_network, token_expires_at, days_left, last_ok_at, last_error, health}`.
  - `PATCH /hub/link {endpoint?, token?, token_expires_at?, allow_public_network?, enabled?: false}` — **Owner + PIN `hub.link`**
    (thao tác PIN mới). Lần đầu tạo máy chủ MCP "Gen-hub" (`streamable_http`). Đổi địa chỉ/token/mạng → tắt liên kết + xoá đệm,
    phải Kiểm tra lại. `enabled: true` → 422 (bật = bấm Kiểm tra). Action Log `hub.link_updated` (`detail.token="(đã đổi)"`) /
    `hub.link_disabled`.
  - `POST /hub/link/test` — **Owner + PIN**: khám phá tool → **mở + cấp `core.gen` đúng các tool có hậu tố** `kho_tom_tat,
    kho_search, kho_get, kho_find_by_id, kho_list` và loại `read` (Action Log `mcp.tool_exposed`/`mcp.grant_added` `via=hub_link`);
    tool lạ (Vault, `kho_create/update`…) để nguyên, đóng → gọi `kho_tom_tat` → xanh thì `enabled=true`. Gen-hub lỗi → 200
    `{ok:false, error}` (không ném) + `last_error`; Action Log `hub.link_tested`.
  - `GET /hub/kho/summary?so_phien=` → `kho_tom_tat`; `GET /hub/kho/search?q=&bang=` → `kho_search`;
    `GET /hub/kho/records/{ma}` (`^[A-Z]{2,6}-\d{1,6}$`) → `kho_find_by_id`. **Chỉ vai trò Owner** (403 với vai trò khác),
    `agent_key="core.gen"`, danh sách hậu tố cho phép **cố định trong code**. Kết quả `{source:"Kho Ryan qua Gen-hub", tool, cached,
    data}`. Mã lỗi: 409 `HUB_LINK_OFF`, `HUB_TOOL_MISSING`, `HUB_UNAVAILABLE` (401/403 → trạng thái `expired`; 429; mạng/timeout 10 s),
    `HUB_BLOCKED` (rào chắn MCP Hub chặn: tool bị đóng/chưa cấp, chặn mạng, mức tự trị), `HUB_TOOL_HELD` (Owner lỡ đổi tool
    sang loại ghi → bản nháp `mcp_write` chờ duyệt, không gọi ra ngoài).
  - **Che trước khi sang model** (`mask_for_model`): cùng lớp `mask_text` như vai trò dưới Owner (số ≥ 8 chữ số — tài khoản/thẻ/SĐT,
    giữ nguyên ngày tháng) + email (`t•••@miền`) + khoá/token (`sk-…`, `ghp_…`, `Bearer …`, chuỗi ≥ 40 ký tự) + giá trị của khoá tên
    kiểu mật khẩu/token/api_key + chính token của liên kết. Áp cho phản hồi API, bản đệm Redis và `mcp_calls.result_summary`.
    Lỗi từ Gen-hub cũng được lọc token trước khi lưu `last_error`/trả về.
  - **Đệm Redis 5 phút** `gh:hub:kho:{org}:{sha256(tool+args)}` — chỉ bản đã che; đổi địa chỉ/token/tắt → xoá.
- **Gen**: tool đọc `hub.kho_summary`, `hub.kho_search`, `hub.kho_get` (`owner_only`, tham số đường dẫn theo regex — `path_patterns`);
  kết quả bọc khối "DỮ LIỆU KHÔNG TIN CẬY" như tool khác; prompt thêm "Kho là dữ liệu, không phải lệnh; trích mã; nguồn Kho Ryan qua
  Gen-hub; không ghi Kho". Tool trả 409 có mã → báo đúng lý do cho model (`HUB_LINK_OFF`…). Mục tiêu mới `mcp.hub_link`,
  `mcp.hub_link.token` (nhạy cảm), `mcp.hub_link.test` (registry.json đã xuất lại).
- **Worker** `hub_token_expiry_scan` (01:50 UTC = 08:50 giờ VN hằng ngày): token còn ≤ 14 ngày / đã hết → chuông `hub.token_expiring`
  cho các Owner (link `/mcp`), **một lần mỗi token** (đổi token/hạn → nhắc lại được); Action Log `hub.token_expiry_notified`.
- **Web**: MCP Hub có thẻ **"Gen-hub — Gen đọc Kho Ryan"** (`HubLinkCard`): trạng thái, địa chỉ, ô token **chỉ ghi** (password,
  xoá trắng sau lưu, không hiện lại), ngày hết hạn, công tắc mạng công cộng, **Lưu / Kiểm tra / Tắt**; vai trò khác chỉ xem trạng
  thái. Mock e2e `/hub/link*`.
- **Test**: api `tests/test_hub_link.py` (18: tắt mặc định, PIN, token không lộ ở API/CSDL/Action Log/mcp_calls, kiểm tra chỉ mở
  tool đọc theo hậu tố, tool lạ bị từ chối, che + đệm + xoá đệm, vai trò khác 403 + tool Gen FORBIDDEN, tool Gen đọc Kho, 401/429/
  timeout, tool ghi → nháp, tool bị đóng → HUB_BLOCKED, tắt, nhắc hạn token, RLS); chạy cả `GH_TEST_APP_ROLE=1`. Web `test/unit/hub-link.test.tsx`.

**Việc Boss làm trên Gen-hub (~3 phút, không sửa mã Gen-hub):**
1. Gen-hub › **Agent & quyền** › tạo agent **`gen-harness-<tên công ty>`**, mô tả "Gen trong Gen-Harness — chỉ đọc Kho".
2. Tạo **token thủ công 90 ngày**; **chỉ tick** tool đọc Kho: `kho_tom_tat`, `kho_search`, `kho_get`, `kho_find_by_id`, `kho_list`.
   **Không** tick Vault, `kho_create`, `kho_update` hay tool khác.
3. Chép token (chỉ hiện 1 lần) → Gen-Harness › **MCP Hub › thẻ Gen-hub**: địa chỉ `https://hub.genos.top/mcp`, dán token, ngày hết
   hạn token, bật "Gen-hub ở mạng công cộng" → **Lưu** (PIN) → **Kiểm tra** (PIN). Xanh = Gen đọc được Kho.
4. Trước hạn 14 ngày chuông sẽ nhắc: tạo token mới trong Gen-hub → dán vào thẻ → Kiểm tra → thu hồi token cũ bên Gen-hub.

- Chưa làm: ngắt mạch 60 s riêng cho Gen-hub (đang dùng `health=error` + đệm), Gen đề xuất ghi Gen-hub (kanban/warroom — v0.1.27),
  phương án B (Gen-hub đọc số liệu Gen-Harness), Jules/Playwright worker; Playwright e2e cho thẻ Gen-hub.

## v0.1.27 — Gia cố & phủ test (không thêm tích hợp ngoài)

Gom các ghi chú bảo mật còn lại từ review v0.1.24–v0.1.26 + phủ e2e cho các tính năng mới. Không có migration mới,
không thêm tích hợp ngoài (Jules / Playwright cho agent vẫn ngoài phạm vi — ROADMAP D2/D3).

- **Gen-hub — ghim DNS (chống DNS rebinding)**: `gh/chassis/mcp_client.pin_endpoint()` phân giải host **một lần**,
  kiểm **mọi** IP (cấm link-local 169.254.x/fe80::, 0.0.0.0, multicast — kể cả IPv4-mapped; IP công cộng khi công tắc
  mạng công cộng tắt) rồi kết nối thẳng IP đã kiểm (URL = IP, header `Host` + TLS SNI/kiểm chứng chỉ theo tên gốc qua
  extension `sni_hostname` của httpx). `McpClient(pin_dns=True)` — `hub_link.client_for()` luôn bật; bỏ proxy môi trường
  (`trust_env=False`) để proxy không phân giải lại. Máy chủ MCP khác giữ hành vi cũ (`check_network_guard`).
- **`GET /hub/link`**: `last_error` (lỗi thô từ Gen-hub, đã lọc token) **chỉ Owner** thấy; vai trò `system.read` khác
  (Kiểm toán) nhận câu chung "Gen-hub đang lỗi — Owner xem chi tiết ở thẻ Gen-hub" (`status` vẫn đúng). Mock web làm y hệt.
- **`POST /mcp/tools/{id}/call` với tool của máy chủ Gen-hub** (`hub_link.generic_call`): vai trò khác Owner (kể cả
  vai trò tuỳ biến có `system.manage`) → **403 `HUB_OWNER_ONLY`** + `mcp_calls` `blocked` + Action Log
  `mcp.call_blocked`, không gọi ra ngoài; Owner đi đúng đường của liên kết — ghim DNS, `result_summary` chỉ siêu dữ liệu,
  kết quả đã che (`mask_for_model`), lỗi lọc token. Máy chủ MCP khác không đổi.
- **`GET /refinery/triage/summary`** đếm **theo phạm vi `queue.read`** của người gọi: `all` = cả tổ chức; `team`/`assigned`
  (Quản lý / Nhân viên) chỉ đếm mục mình thấy trong Hộp thư (`biz.queue.service.item_scope_sql` trên `biz.inbox_items`,
  cả số "chờ lọc"). Phản hồi thêm `scope` (contracts `TriageSummary.scope?`). Tool Gen `refinery.summary` tự theo phạm vi.
- **Lọc đầu — rà soát trần 3000 mục so trùng** (`gh/refinery/triage._candidates`, docstring "Trần 3000"):
  - cửa sổ ứng viên nay có **cận trên** = mục muộn nhất của phần đang xét (mục sau đó không bao giờ là bản gốc) → quét vét
    mục cũ đến muộn không phí chỗ trong trần; truy vấn đi chỉ mục `item_marks_observed_idx (org_id, observed_at DESC)`
    (0019) và dừng ở 3000 dòng — chi phí cố định; so gần trùng là vòng Python 50 × 3000 đã lọc thô (độ dài + simhash);
  - **chạm trần** → nạp thêm ứng viên **trùng y hệt** theo `text_hash` qua `item_marks_hash_idx (org_id, text_hash)`
    (tối đa `EXACT_LIMIT` = 500) + log info: trùng y hệt không bao giờ bị trần bỏ sót; trùng *gần* với mục cũ hơn 3000
    mục gần nhất có thể sót (chấp nhận, ghi rõ). Không cần chỉ mục mới. Dò lại trùng khi mục sớm hơn đến muộn: ngoài phạm vi.
- **Chuông — hạn lưu**: `notifications.purge_old()` xoá thông báo **đã đọc > 30 ngày** và **mọi thông báo > 90 ngày**, theo
  lô 5000; job worker `purge_notifications` 03:45 hằng ngày (cạnh `purge_gen_conversations` 03:40).
- **Nhắc việc chịu lỗi từng dòng**: `due_reminders` bọc mỗi việc trong **savepoint** (`begin_nested`): một dòng lỗi (dữ liệu
  hỏng…) chỉ bị bỏ qua + log, các nhắc khác vẫn gửi; dòng lỗi giữ `reminded_at` (không lặp lỗi mỗi phút); sự kiện WS của
  thông báo bị hoàn tác cũng bị bỏ (`notifications.pending_mark/pending_reset`). Hàm trả số nhắc gửi được.
- **Web**: chuông có icon cho `task.reminder` (đồng hồ báo thức) và `hub.token_expiring` (chìa khoá).
- **Mock**: kịch bản Gen "nháp" (thẻ nháp tin **cần PIN** — xác nhận trả 423 khi chưa có phiên PIN); xác nhận nhắc việc
  sinh mã `TSK-0999`…, hook e2e `POST /api/v1/__mock/p3/gen/fireReminders` (= worker nhắc việc tới giờ → chuông Owner, một lần).
- **Test**: api `tests/test_hardening_v0127.py` (8: quy tắc ghim DNS + IPv6/IPv4-mapped, rebinding — kết nối đúng IP đã kiểm
  và lần sau bị chặn trước khi ra ngoài, `last_error` chỉ Owner, route MCP chung Owner che / vai trò khác 403 không gọi ra
  ngoài, summary theo phạm vi, trùng y hệt vượt trần, hạn lưu chuông theo lô, nhắc việc lỗi một dòng không chặn lô);
  e2e mới **`apps/web/e2e/coverage.spec.ts`** (7, mock, tất định — chạy `--repeat-each=3` xanh): thẻ đề xuất Sửa → Xác nhận
  → mã việc → tới giờ nhắc → chuông WS + mở `/tasks`; Huỷ; nháp tin cần PIN (hỏi PIN → tự gửi lại) + bỏ hộp PIN thì vẫn chờ;
  Hộp thư huy hiệu Trùng/Rác/Điểm + tooltip + "Ẩn rác & trùng" (`?hide=1`, nhớ sau tải lại); thẻ Gen-hub (token ô password,
  Lưu cần PIN, không hiện lại, token không có trong DOM/phản hồi `/hub/*`, Kiểm tra → Đang nối, Tắt) + Kiểm toán chỉ xem.
- **Rà soát trước merge (PR #30)**:
  - route chung `PATCH/DELETE /mcp/servers/{id}` + `POST …/discover` trên máy chủ Gen-hub: vai trò khác Owner (kể cả tuỳ
    biến có `system.manage`) → 403 `HUB_OWNER_ONLY` + Action Log `mcp.server_blocked` (trước đây đổi được `endpoint` rồi
    khám phá = gửi token Kho tới nơi khác); Owner khám phá máy chủ Gen-hub qua client ghim DNS (`hub_link.guard_server_admin`).
  - ghim DNS: IPv4-mapped (`::ffff:a.b.c.d`) chuẩn hoá về IPv4 trước khi xét công cộng (Python 3.11 coi là "private");
    IP đầu không kết nối được (vd AAAA trên máy không IPv6) → thử lần lượt các IP còn lại đã kiểm; không theo chuyển hướng;
    cổng sai → chặn.
  - chuông: SQLAlchemy 2 bắn `after_commit`/`after_rollback` cả khi RELEASE/ROLLBACK savepoint → sự kiện WS bị đẩy trước
    khi transaction ngoài commit và một dòng lỗi xoá sự kiện của các dòng trước; nay bỏ qua khi còn trong transaction lồng,
    `pending_mark/reset` dùng ảnh chụp. `purge_notifications` commit sau mỗi lô.
- Chưa làm: ngắt mạch 60 s riêng cho Gen-hub, Gen đề xuất ghi Gen-hub (kanban/warroom), phương án B, Jules/Playwright worker.


## v0.1.28 — Sửa theo rà soát UX (Chặn 1/1, Nặng 7/7, Vừa 13/16)

Nguồn: rà soát UX/logic người dùng 30/09 (hệ thống thật + mock, 1440px & 375px). Không có migration mới.

- **C1 — thiết lập xong nhưng không agent nào có model**: `PUT /setup/steps/4` tự dùng model đầu tiên (bỏ model embedding)
  lấy từ lần gọi thử OK (`providers.last_test.models`) khi Owner chưa bấm "Dùng model này", rồi gán model đó cho các agent lõi
  còn trống (`core.refinery`, `core.reply`, `core.intent`, `core.scoring`, `core.gen`; bỏ `core.indexing`) — Owner đổi lại
  ở API & Model. Không nguồn nào có model → 409 `STEP_INCOMPLETE` "Chưa có model nào để dùng…". Web: "Tiếp tục" chỉ bật khi
  một nguồn sẵn sàng CÓ model; nút "Dùng model này" đọc `last_test` từ máy chủ nên còn sau khi tải lại, kèm "Chưa chọn thì
  hệ thống dùng …"; sau khi lưu đọc lại danh sách nguồn. Bước 12 nói thật việc còn thiếu (V10): "Đã lưu — còn N việc…"
  (model, kênh, nhóm, quy tắc, sao lưu — mỗi việc có liên kết về bước), chỉ ghi "Mọi thứ đã sẵn sàng" khi đủ. Gen phân biệt
  "chưa có model" (chuỗi rỗng → dẫn tới gán model) với "model đang lỗi" (`ModelUnavailable.no_chain=False` → "chưa gọi được
  model lúc này", không dẫn đi gán lại).
- **N1 — nguồn gọi thử lỗi**: bước 4 xếp nguồn lỗi/chưa kiểm tra CUỐI (không số thứ tự, không đưa lên được); máy chủ ghi lại
  `failover_rank`: nguồn Owner chọn trước, còn lại sau. `DELETE /providers/{id}` (Quản lý hệ thống; gỡ gán model trỏ vào
  nguồn; Antigravity CLI → 409 `CLI_PROVIDER`; Action Log `provider.deleted`) + nút Xoá ở bước 4 và thẻ nguồn ở API & Model.
  Một nhãn trạng thái chung `providerStatus()` (web) cho bước 4, API & Model (thẻ + chuỗi), Bộ não AI (chuỗi), Jev; thẻ
  "Khoá & phiên" (`/providers/credentials`) cùng nhãn ("Lỗi kết nối", "Hết hạn", "Chưa kiểm tra"). Sau Kiểm tra đọc lại nguồn.
- **N2 — lỗi thô**: `lib/friendlyError.ts` dịch lỗi mạng/CLI thiếu/401/429/404/TLS/5xx sang câu tiếng Việt có việc cần làm;
  `FriendlyErrorText` hiện câu đó + "Chi tiết kỹ thuật" (thu gọn) — dùng ở bước 4, API & Model, Jev, Gen-hub. Đăng nhập CLI
  thiếu tệp `agy` → "Máy chủ chưa cài công cụ đăng nhập Google (Antigravity CLI) — dùng khoá API…" (lỗi gốc vẫn vào Action Log).
- **N3/N4 — "Để sau" = mặc định**: bỏ qua bước 7 nạp bộ quy tắc khởi đầu R-01…R-06 nếu tổ chức chưa có quy tắc
  (`setup.routes.seed_default_rules`); bỏ qua bước 11 đặt lịch sao lưu hằng ngày 02:00, giữ 7 bản (nếu chưa có lịch). Mô tả
  bước 7/11 nói rõ điều này. Khôi phục bằng nút khi máy chủ chưa bật trình khôi phục: lời thường (sao lưu vẫn chạy; nhờ người
  cài đặt chạy `genh update` một lần), nút Khôi phục có chú thích.
- **N5/N6 — tiếng Anh & chữ lập trình viên**: phụ đề tiếng Anh mặc định TẮT (`gh-ui` persist version 1 — trình duyệt đã lưu bản
  cũ được tắt một lần; bật lại ở menu tài khoản thì giữ). Việt hoá tiêu đề phụ (Hôm nay, Tăng nhanh trong 24 giờ, Mức dùng
  trong ngày…, Tin chờ sàng lọc, Độ trễ xử lý của hệ thống, Hồ sơ hoạt động, Tài liệu, Người trong công ty…), bỏ "spec I",
  "ARCHITECTURE §…", "khoá cứng #n", "(core.gen)", "agent_key core.refinery", "core agent", "bridge", "SMTP"; mẫu agent "Khách
  hàng lớn/Tuyển dụng"; quy tắc khởi đầu viết lời thường ("ý định: hỏi giá", "phía mua (cầu)", "nguy cơ mất khách +40",
  "đánh dấu là tin nhiễu"…; quy tắc đã tạo trước đó giữ nhãn cũ); mô tả bước 4/7/8/9/11/12 viết cho người dùng; "Endpoint" →
  "Địa chỉ gọi (Endpoint)".
- **N7 — ma trận quyền**: ô nói phạm vi dữ liệu "Tất cả / Theo team / Khách được phân / Không" (không còn "Toàn quyền"), chú
  giải tương ứng, nhãn ngắn không bị cắt, cột vai trò rộng hơn; tên vai trò tiếng Việt trên giao diện (Quản lý, Vận hành, Nhân
  viên phụ trách, Kiểm soát — "chỉ xem, không làm thao tác nào"; mã/tên lưu ở máy chủ giữ nguyên); ngưỡng tiền hiện
  "= 50.000.000 ₫".
- **N9 — ngõ cụt của vai trò khác Owner**: thẻ số liệu Tổng quan chỉ là liên kết khi vai trò mở được màn đích; Trợ giúp theo
  vai trò (lệnh genh chỉ Owner, thẻ Gen chỉ khi có Gen, vai trò khác thấy "Cần giúp về tài khoản" — nhờ Owner đặt lại mật khẩu /
  mở quyền); `/guide` với vai trò khác: "Việc kết nối do Owner làm" (không gọi API, không "Thử lại" vô ích); trang đăng nhập:
  "Nhân viên: nhờ Owner bấm Đặt lại mật khẩu…", "Owner: nhờ người cài đặt chạy …" (lệnh không bị ngắt giữa chữ — V15).
- **Vừa**: V1 lý do nút Tiếp tục bị khoá (bước 2/3/4: "Còn thiếu: …", PIN nhập lại không khớp báo ngay khi đủ 6 số, khoá API
  quá ngắn / địa chỉ không phải http(s)); V3 ẩn lựa chọn English ở bước 1 (luôn gửi `vi`); V4 hộp mật khẩu tạm chỉ đóng bằng
  "Đã gửi, đóng" (`Dialog dismissable={false}` nay chặn cả Esc và nút ×), mật khẩu tạm `xxxx-xxxx-xxxx` không ký tự dễ nhầm
  (`crypto.temp_password`), "Chép lời nhắn gửi nhân viên" gồm địa chỉ đăng nhập; V5 điện thoại: bảng Người dùng + ma trận quyền
  thành thẻ, dải tab tự cuộn tab đang mở vào giữa (`Tabs`); V6/V9 chữ phụ tab Điều khiển hệ thống ngắn, bỏ "6 model"/"spec I"
  (7 tab vừa 1440px); V7 bấm chữ "Ẩn rác & trùng" cũng bật/tắt; V8 Hộp thư: "Lọc đầu N" (điểm chất lượng) tách khỏi "ưu tiên
  N/100 · độ tin cậy …", mục nghi rác không còn nhãn "Cơ hội"; V11 ghi chú phát hành bỏ phần tự sinh tiếng Anh của GitHub
  (`readableNotes`), sau khi tự tải lại báo "Đã cập nhật lên vX"; V12 hỏi Gen câu mới thì đóng lượt khoanh sáng cũ; V13 tiền tệ
  bước 3 và tab Tổ chức dùng chung 8 loại có tên tiếng Việt; V14 thẻ Gen-hub: "Kho tri thức", hướng dẫn 3 bước lời thường.
  Nhẹ làm kèm: L4 chuông sao lưu "Đã sao lưu (x MB)…" thay đường dẫn tệp; L7 PIN "báo qua kênh chat khi đã kết nối".
- **Để lại (lý do)**: V2 "Để sau" cho bước 4 — bước 4 là bắt buộc theo thiết kế (không có bộ não AI thì sàng lọc/Gen không chạy;
  C1 vừa siết đúng điều này), cần Boss quyết; V8 phần số đếm thanh bên (28) ≠ tab (9) — hai nguồn đếm khác nhau (cả hàng đợi vs
  Hộp thư), cần thiết kế lại huy hiệu; V11 phần ghi chú phát hành viết tiếng Việt riêng cho Boss — cần đổi quy trình phát hành
  (release.yml lấy từ HANDOFF), web hiện đã lọc phần tiếng Anh tự sinh; V14 phần "có ảnh" — cần ảnh chụp Gen-hub thật; Nhẹ còn
  lại (L1–L3, L5, L6, L8–L16) chưa làm (một số gắn với ảnh thiết kế so sánh ở e2e visual).
- **Test**: api `tests/test_ux_v0128.py` (6: bước 4 tự chọn model + gán agent lõi + nguồn lỗi xuống cuối, 409 khi không có model,
  xoá nguồn + nhãn thẻ khoá, Để sau 7/11 = mặc định, không đè quy tắc có sẵn, mật khẩu tạm) + `test_gen.py` (model lỗi ≠ chưa
  có model); cập nhật `test_phase2_api.py` (follow-up 7/11 xong sau Để sau). web `test/unit/ux-v0128.test.tsx` (10) + HelpPage
  Vận hành, ma trận quyền tiếng Việt, bước 1 không có English. e2e mới `e2e/ux.spec.ts` (2, mock tất định: bước 4 → 12 với nguồn
  lỗi/xoá/tải lại/việc còn thiếu; Vận hành: Trợ giúp + Hướng dẫn). Mock: gọi thử lưu `last_test` và KHÔNG tự thêm model (như
  máy chủ thật), bước 4 tự chọn model, `DELETE /providers/{id}`, Để sau 7/11 dùng mặc định. Ảnh "sau" (`*-after.png`) chụp lại
  bằng đúng script rà soát trên hệ thống thật (+ mock cho Hộp thư).


## v0.1.29 — Bước 4 "Để sau" có cảnh báo + Đợt D3 lát đầu: Gen đọc Facebook cá nhân (chỉ đọc)

Quyết định Boss 30/09: "có công cụ và tính năng; dùng hay không do Owner quyết, kèm cảnh báo rủi ro rõ". Thiết kế:
`docs/design/gen-browser-agent.md` §5.1 (đã cập nhật chỗ khác bản nháp); giao thức: `docs/api/browser-protocol.md`.

### Boss cần làm gì để nối Facebook (5 phút, làm một lần)
1. Chờ bản v0.1.29 tự cập nhật (hoặc bấm **Cập nhật ngay**). Lần đầu tải thêm ảnh trình duyệt (~1,5 GB).
2. Bấm tên tài khoản ở góc dưới trái → **Tài khoản mạng xã hội** → **Thêm tài khoản** → chọn *Facebook cá nhân*, đặt tên
   (vd "Facebook của Sếp") → **Tiếp**.
3. Đọc cảnh báo, tích **cả hai ô** (chấp nhận rủi ro + đây là tài khoản thật của chính Sếp) → **Tôi chấp nhận, thêm tài
   khoản** → nhập PIN.
4. Bấm **Đăng nhập** → cửa sổ trình duyệt từ xa hiện trang Facebook: bấm vào ô, **tự gõ** email/mật khẩu, mã 2FA (nếu
   Facebook hỏi xác minh/CAPTCHA thì Sếp tự làm trong khung) → khi vào tới trang chủ, hệ thống tự lưu phiên (hoặc bấm
   **Tôi đã đăng nhập xong**). Thẻ chuyển **Đang kết nối**.
5. Dùng: hỏi Gen "Facebook có gì mới?" hoặc bấm **Đọc ngay**. Muốn tự đọc 08:00/17:00 thì bật **Đọc tự động**.
   Muốn dừng hết ngay: **Dừng tất cả** (bật lại cần PIN). Muốn gỡ: **Gỡ tài khoản** (xoá phiên đã lưu).
Rủi ro còn lại (Boss đã chấp nhận): Facebook có thể hỏi xác minh / hạn chế / khoá tài khoản vì điều khoản cấm tự động
hoá — hệ thống chỉ giảm (đọc ít, dừng ngay khi có cảnh báo), không loại bỏ được.

### A — Bước 4 "Để sau" (V2)
- API: bước 4 hết bắt buộc (`STEPS`, chỉ 1–3 + 12); `POST /setup/steps/4/skip` ghi `setup.step_skipped` và **vẫn tự gán**
  model của nguồn đã gọi thử OK (nếu có) cho agent lõi còn trống (`auto_assign_tested_model`); `PUT /setup/steps/4` lưu được
  cả sau Hoàn tất; `GET /setup/follow-up` có mục 4 — "xong" chỉ theo dữ liệu thật (Gen hoặc Sàng lọc có model; xoá nguồn
  → lại "chưa").
- Web: "Để sau" ở bước 4 mở hộp cảnh báo ("Gen sẽ không trả lời và sàng lọc sẽ không chạy tới khi chọn model"; có nguồn OK
  thì nói sẽ tự dùng); bước 12 + đầu Tổng quan hiện dải đỏ **Chưa có model** + nút **Chọn model** (bước 12 → `/setup?step=4`,
  Tổng quan → `/guide/4` = form bước 4 trong Console). Thẻ "Việc thiết lập tiếp" không lặp mục 4.

### B — Tài khoản mạng xã hội + browser-worker (chỉ đọc)
- **Dịch vụ mới** (`deploy/compose.yaml`): `browser` (ảnh `deploy/images/browser.Dockerfile`, gốc
  `mcr.microsoft.com/playwright/python:v1.56.0-noble@sha256:a7f6cf3a…` ghim digest; chạy Chromium CÓ giao diện trong Xvfb,
  user không root, rootfs chỉ-đọc + tmpfs, `cap_drop: ALL`, `no-new-privileges`, `init`, RAM 1,5 GB, 1,5 CPU) và
  `browser-egress` (cùng ảnh, `python -m ghb.egress`). `browser` chỉ ở mạng `browser` (`internal: true`, không ra Internet;
  thấy redis + egress); egress chỉ nhận `CONNECT :443` tới `facebook.com, fbcdn.net, facebook.net, fbsbx.com, messenger.com`,
  phân giải một lần, chặn mọi IP nội bộ. Đã kiểm bằng docker thật ở máy build: ra Internet trực tiếp hỏng, example.com /
  cổng 80 / redis qua proxy → 403, trình duyệt mở example.com bị chặn, worker lên + nhịp tim.
- **Khoá** `secrets/gh_browser_key` (api, worker, browser — KHÔNG phải khoá master): `genh install` sinh; máy cài cũ →
  `ops.ensureAuxSecrets` tự sinh khi bất kỳ lệnh genh nào tìm compose.yaml (kể cả `genh update` trước `up`). `make secrets`
  cũng sinh. Phát hành: `release.yml` build+push ảnh `gen-harness-browser`, `pin-compose-images.sh --browser` ghim digest cho
  cả `browser` và `browser-egress`; genh kéo/khởi động thêm `browser`, `browser-egress`.
- **Worker** `apps/browser/ghb` (gói Python riêng, không có mã `gh`, không DB): nhận việc đã ký HMAC qua Redis Stream (kiểm
  chữ ký/hạn/nonce một lần), khoá 1 việc/tài khoản, ≤ 2 việc song song, mỗi việc một ngữ cảnh trình duyệt mới (phiên nạp từ
  payload mã hoá khi truyền, xong là đóng), `guard` chặn mọi yêu cầu ngoài https tên miền nền tảng, kiểm "Dừng tất cả" trước
  mỗi bước và đóng trình duyệt ngay khi bị huỷ; nghỉ 2–6 giây giữa thao tác; không stealth/không đổi UA/không giải CAPTCHA.
  Adapter Facebook: trạng thái trang (cookie `c_user`, `/checkpoint`, form checkpoint, iframe/ô CAPTCHA), đọc thông báo
  (`notif_id=`) + danh sách hội thoại (`/messages/t/`, dòng xem trước) → văn bản có cấu trúc. Đăng nhập: CDP screencast →
  WS; chuột/phím của Owner → `Input`; thấy đã đăng nhập → gửi phiên. `Adapter.write` = chỗ cắm v0.1.30 (ném lỗi).
- **API** `gh/social/` (migration **0021**: `core.social_accounts`, `agent.browser_jobs`, RLS + GRANT gh_app): mọi route CHỈ
  Owner (`require_owner`; vai trò tuỳ biến có `system.manage` vẫn 403); PIN `social.manage` khi thêm / đăng nhập / gỡ / bật
  lại; thêm tài khoản bắt buộc `accept_risk` + `accept_rules` + đúng `risk_version`; phiên lưu `state_enc` =
  `crypto.encrypt(…, AAD social:<org>:<acc>)`; gỡ = xoá phiên + xoá `result` mọi việc cũ + huỷ việc đang chạy (dòng giữ
  `revoked` cho Nhật ký). Giới hạn cứng: đọc ≤ 6 lượt/24 giờ (Owner chỉ hạ), cách nhau ≥ 10 phút, 1 việc/tài khoản (409
  `SOCIAL_BUSY`), lịch không chạy 23:00–06:00, việc treo > 15 phút tự đóng `WORKER_TIMEOUT`. `POST /social/halt` (không cần
  PIN để dừng được ngay) → khoá Redis + lệnh halt đã ký + đóng mọi việc; `DELETE /social/halt` (PIN). Checkpoint/CAPTCHA →
  tài khoản `paused` + chuông Owner; đăng xuất → `needs_login`; 3 lỗi liên tiếp → `paused`. Consumer kết quả chạy trong
  api; kết quả sai chữ ký / việc đã đóng bị bỏ. Action Log: `social.account_created|login_started|login_ok|login_failed|
  login_cancelled|read_requested|read|health_ok|check|job_failed|auto_paused|paused|resumed|account_updated|revoked|halt|
  halt_released`. Lịch đọc: cron worker mỗi phút (`social_schedule`, tắt mặc định) → chuông "N thông báo, M hội thoại".
- **Gen**: tool `social.accounts`, `social.read` (Owner; dùng lại lượt đọc < 10 phút, không thì xếp việc `via=gen` rồi chờ
  ≤ 40 s, lâu hơn → "đang đọc, xong báo chuông"). Nội dung đã làm sạch (bỏ ký tự điều khiển/đảo chiều, cắt 500 ký tự,
  link ngoài tên miền bỏ) + cờ `suspicious`; luôn nằm trong khối DỮ LIỆU KHÔNG TIN CẬY; prompt nói rõ Gen chỉ đọc.
- **Web** `/social` (menu tài khoản → "Tài khoản mạng xã hội", chỉ Owner): thẻ tài khoản (trạng thái + việc cần làm, Đăng
  nhập/Đăng nhập lại, Đọc ngay, Kiểm tra phiên, Tạm dừng/Tiếp tục, Gỡ, Đọc tự động + giờ, lần đọc gần nhất có nhãn "đáng
  ngờ"), hộp thêm tài khoản 2 bước (rủi ro / SẼ làm / KHÔNG làm, 2 ô bắt buộc), cửa sổ đăng nhập từ xa (canvas, phím/chuột,
  dán), công tắc Dừng tất cả, thẻ **Luật cứng — luôn tắt**. Sự kiện WS `social.update`; chuông có icon `social.read|paused`.
- **Test**: api `tests/test_social.py` (13: vectơ giao thức, lọc sự kiện nhập, stub ghi, chỉ Owner kể cả vai trò tuỳ biến,
  PIN + chấp nhận rủi ro, phiên mã hoá không lộ ở CSDL/API/Action Log + đúng AAD, kết quả giả mạo bị bỏ, làm sạch + bọc
  untrusted cho Gen, Gen xếp việc + chuông, giới hạn tốc độ + 1 việc, Dừng tất cả, checkpoint → dừng + chuông, gỡ xoá phiên
  + nội dung, lịch) + `tests/test_setup_v0129.py` (3); worker `apps/browser/tests` (13: Chromium thật trên TRANG MẪU tự viết —
  đọc có cấu trúc + chặn tên miền lạ, checkpoint/CAPTCHA/đăng xuất, dừng giữa chừng, huỷ đóng ngay, đăng nhập qua khung hình
  + phím, huỷ/URL bị chặn; chữ ký/hạn/nonce, khoá 1 việc + halt, vòng đọc hàng đợi, proxy ra ngoài); genh
  `ops/secrets_test.go`; web `test/unit/social.test.tsx` (7), `setup-v0129.test.tsx` (3); e2e mock `e2e/social.spec.ts` (3).
  CI: job mới `browser` (cài Chromium `--with-deps`, `GH_BROWSER_TESTS_REQUIRED=1`), `images` build thêm ảnh browser.
- **Cách ly (sửa bảo mật trước merge)**: container `browser` (Chromium, sandbox tắt) KHÔNG còn đường mạng tới Redis chính
  (hàng đợi arq — worker giữ khoá master). Kênh giao thức `gh:browser:*` chuyển sang Redis RIÊNG `browser-redis`
  (`GH_BROWSER_REDIS_URL`; không lưu đĩa, 64 MB, ACL `-@dangerous -@scripting`, rootfs chỉ đọc) nối hai mạng internal:
  `browser` (browser, browser-egress) và `browser-bus` (api, worker). browser-egress chuyển từ `default` sang mạng riêng
  `browser-out`. Cờ Dừng tất cả gốc ở Redis chính, api chép sang browser-redis. arq chuyển pickle → JSON
  (`gh/jobcodec.py`; việc pickle cũ còn trong hàng lúc nâng cấp bị arq bỏ, không chạy). e2e nâng cấp kiểm browser/egress
  không tới `redis`/`db`/`api`, browser tới được `browser-redis`. Sandbox Chromium vẫn tắt (cần seccomp + AppArmor riêng —
  để bản sau, xem docs/api/browser-protocol.md). Không cần bí mật mới → nâng cấp từ v0.1.28 không đổi gì với genh.
- **Chưa kiểm được**: Facebook THẬT (bộ chọn dựa trên dấu hiệu tương đối bền + trang mẫu; giao diện đổi → lỗi `SELECTOR`
  rõ ràng). Nghiệm thu thật = Boss đăng nhập + đọc một lần. Ảnh arm64 build qua QEMU ở release (chưa chạy thử trên máy arm).
- **Để lại**: ghi có xác nhận (v0.1.30 — đề xuất Gen + PIN + permit, `gh/social/permit.py`); Trang FB / IG chuyên nghiệp qua
  API; nền tảng khác; ảnh chụp/trace mỗi việc (thiết kế §3.3); Jev phân loại từng tin.

## v0.1.30 — hotfix: màn sập "React error #31 {reasons}" khi chưa có model + lối vào Hướng dẫn thiết lập (30/09/2026)

- **Lỗi Boss gặp** (v0.1.28/29): "Minified React error #31 … object with keys {reasons}" → khung lỗi. Gốc: `PUT
  /setup/steps/8` (màn **/guide/8 "Agent đầu tiên"**, thử trò chuyện) gán `try_error = e.detail` với `detail =
  {"reasons": [...]}` khi `ModelUnavailable` (`gh/biz/people/routes.py:try_chat`) → web vẽ thẳng đối tượng làm React child
  (`Step8Agent`). Cùng khuôn `detail={"reasons"}` ở `/drafts/{id}/translate|regenerate` (`gh/biz/core/routes.py`).
  (`gh/biz/core/drafts.py:158` chỉ là `detail` của Action Log, không phải lỗi HTTP — giữ nguyên.)
- **API**: `gh.errors.model_unavailable(title, reasons)` → 503 `MODEL_UNAVAILABLE`, `detail` = câu chữ ("Chưa có model AI
  nào hoạt động — vào Agent & Model …"), `reasons` (danh sách chuỗi) ở **cấp ngoài cùng** của problem+json. Bước 8:
  `try_error` luôn là chuỗi, thêm `try_error_code` + `try_reasons`. Tương thích: web mới đọc được cả khuôn cũ
  (`detail.reasons`) lẫn mới; trong repo không client nào đọc `detail.reasons` (genh/bridge không dùng).
- **Contracts**: `ApiError.message` luôn là chuỗi (`detail` đối tượng/mảng → `message|msg|detail` chuỗi, mảng lỗi FastAPI
  nối `msg`, không thì `title`); getter `ApiError.reasons` (khuôn mới + cũ). `Problem.reasons`, `Step8Agent.try_error_code/
  try_reasons`.
- **Web**: `detailToText` / `reasonsOf` (lib/friendlyError) — mọi `detail` không phải chuỗi thành chữ; `friendlyError`
  nhận `unknown`; `errorText`/`describeError` qua helper, `MODEL_UNAVAILABLE` → câu cố định; `ModelUnavailableNotice`
  (screens/common) có nút **Chọn model** → `/guide/4` + "Chi tiết kỹ thuật"; `CardError` tự dùng khi lỗi là
  MODEL_UNAVAILABLE; truy vấn không thử lại khi MODEL_UNAVAILABLE; `ScreenPage` dùng `errorText`.
- **Hướng dẫn thiết lập "biến mất"**: /guide chỉ vào được qua Trợ giúp + thẻ "Việc thiết lập tiếp" — thẻ ẩn khi số liệu
  Tổng quan lỗi (return sớm) và khi mọi bước 5–11 đã "xong theo dữ liệu thật" (từ v0.1.28 "Để sau" ở bước 7/11 tự nạp quy tắc
  / lịch sao lưu mặc định → tính là xong). Sửa: mục cố định **Hướng dẫn thiết lập** ở thanh bên (ngay dưới Điều khiển hệ
  thống) + menu tài khoản (cạnh Trợ giúp), chỉ Owner; thẻ vẫn hiện cả khi số liệu Tổng quan lỗi; nút **Ẩn** chỉ ẩn cho đúng
  người bấm (localStorage theo user id), có bước dở MỚI thì hiện lại; thẻ chỉ gọi API khi là Owner.
- **"Mất nút update"** (Boss ở v0.1.28, v0.1.29 đã phát hành nhưng Tổng quan không có thẻ): `gh/system_api/update.py`
  đệm bản mới nhất 3600 s và thẻ Tổng quan chỉ hiện khi biết có bản mới. Sửa: đệm còn **600 s** (`checked_at` kèm theo);
  `POST /system/update/check` (system.manage) hỏi GitHub ngay, bỏ qua bộ đệm, tối đa 1 lần / 30 giây (bấm dồn → trả bản
  đệm + `throttled: true`), GitHub lỗi thì giữ bản đệm cũ. Web: mục **Cập nhật phần mềm** cố định (đang dùng, bản mới nhất,
  kiểm tra lúc, nút **Kiểm tra bản mới**, **Cập nhật ngay** khi có bản mới) ở Điều khiển hệ thống › Dữ liệu & lưu trữ và
  trang Trợ giúp (`UpdateCard always`); thẻ Tổng quan giữ nguyên hành vi.
- **Test**: api `tests/test_hotfix_v0130.py` (4 — thêm kiểm tra cập nhật: bỏ đệm, giới hạn, giữ bản đệm, 403); web
  `test/unit/hotfix-v0130.test.tsx` (7 — tái hiện /guide/8 với `try_error={reasons}`), `setup-followup.test.tsx` (+2),
  `nav.test.tsx` (+3), `update.test.tsx` (+1); e2e mock `e2e/hotfix-v0130.spec.ts` (4: /guide/8 khuôn cũ, Đánh giá con
  người 503 MODEL_UNAVAILABLE, Cập nhật phần mềm ở Trợ giúp/Hệ thống, lối vào Hướng dẫn thiết lập); `visual.spec.ts` ẩn
  mục `guide` (ngoài thiết kế gốc) khi so ảnh.

## v0.1.30 — Sửa nóng (hiển thị lỗi web; đổi tài khoản Google của Antigravity CLI)

### Đổi tài khoản Google (Antigravity CLI) không hoạt động

- **Nguyên nhân gốc**: (1) "Thêm tài khoản" khi đang đăng nhập: `agy` thấy tệp phiên nên vào thẳng chat, KHÔNG in link
  đăng nhập; khi làm mới token nó ghi lại tệp → Console tưởng "đăng nhập xong" và lưu lại CHÍNH tài khoản cũ (hoặc treo
  10 phút) → không bao giờ thêm được tài khoản thứ hai để đổi. (2) Link/trạng thái đăng nhập chỉ đi qua WebSocket — mất
  WS là UI kẹt "Đang mở phiên…". (3) Hồ sơ không có phiên đã lưu vẫn "đổi" được (chỉ đổi cờ CSDL, AI vẫn chạy tài khoản
  cũ). (4) `email` null (tệp phiên thiếu id_token, userinfo lỗi) làm vỡ thẻ CLI (`emailInitials(null)`). (5) Có hồ sơ đã
  lưu nhưng không hồ sơ nào hoạt động → thẻ chỉ có nút "Đăng nhập", không chọn lại được.
- **Sửa** (`gh/providers/cli.py`, `system_api/routes.py`, `clients.py`): gửi tạm tệp phiên sang
  `antigravity-oauth-token.before-login` trước khi chạy CLI; xong → bỏ bản gửi tạm, lỗi/huỷ/quá giờ → trả về; api/worker
  khởi động thấy bản gửi tạm thì trả về trước. `GET /cli/login/{id}` (UI hỏi 2 s/lần). Đổi/xoá khi đang đăng nhập →
  `409 CLI_LOGIN_IN_PROGRESS`; hồ sơ không có phiên → `409 CLI_PROFILE_NO_SESSION`. Lưu ngược tệp phiên chỉ khi email trong
  tệp khớp hồ sơ đang dùng. Lượt gọi AI lúc đang đăng nhập → chuyển nhà cung cấp kế tiếp, không đánh dấu CLI hết hạn.
  Web (`CliCard.tsx`, `useCliLogin.ts`, `systemModel.ts`): tài khoản đang dùng + số tài khoản đã lưu, hộp "Đổi tài khoản
  Google cho AI" (Đang dùng / "Dùng tài khoản này" / xoá / "Thêm tài khoản Google"), nút "Chép link", thông báo tiếng Việt
  (PIN huỷ, đang đăng nhập, không có phiên), đóng hộp + làm mới nhà cung cấp sau khi đổi.
- **Test**: api `tests/test_cli_switch.py` (6, CLI giả nhiều tài khoản `tests/fixtures/fake_agy_multi.py`: thêm tài khoản
  thứ hai, đổi qua lại có PIN, `agy -p` sau khi đổi trả đúng email; huỷ giữ tài khoản cũ; tái hiện lỗi cũ khi tắt gửi
  tạm); web `test/unit/cli-switch.test.tsx` (5, không WS); e2e mock `phase2.spec.ts` thêm "CLI switch account".
- **Chưa kiểm được**: `agy` + Google THẬT (tên/định dạng tệp phiên, việc CLI có giữ trạng thái đăng nhập ở tệp khác ngoài
  `antigravity-oauth-token` hay không). Nghiệm thu thật = Boss thêm tài khoản thứ hai rồi đổi qua lại một lần.
- **Review trước merge**: `MODEL_UNAVAILABLE.reasons` (tên nguồn, nhãn khoá, lỗi gốc) ở `/drafts/{id}/translate|regenerate`
  chỉ trả cho Owner, vai trò khác nhận `reasons: []` (test `test_model_unavailable_reasons_are_hidden_from_non_owner`).
  api khởi động còn bản gửi tạm ⇒ luôn trả bản gửi tạm về (đè tệp phiên của lượt đăng nhập dở), tránh bản gửi tạm nằm lại
  rồi bị lượt đăng nhập sau ghi đè (test `test_api_restart_prefers_parked_token_over_half_finished_login`).

## v0.1.31 — Model CLI theo nhóm, một sự thật cho trạng thái phiên, nguồn Claude Code CLI (01/10/2026)

### Boss cần làm gì (sau khi cập nhật)

1. **Chọn model cho Antigravity**: Agent & Model (hoặc Hướng dẫn thiết lập › bước 4) → dòng **Antigravity CLI** → bấm
   **Kiểm tra** → ô chọn model giờ chia nhóm (**Gemini**, **Claude (qua Antigravity)**…) kèm gợi ý "nhanh, rẻ" / "cân bằng" /
   "mạnh". Chọn model → **Dùng model này** (hệ thống gọi thử thật, CLI không nhận thì báo lỗi và không lưu).
2. **(Tuỳ chọn) Claude Code CLI — gói Claude Pro/Max**: đọc khung cảnh báo (Sếp tự quyết, QD-12) → **Đăng nhập Claude** →
   **Mở trang đăng nhập Claude** (đăng nhập đúng tài khoản Claude, bấm cho phép) → chép mã trang hiện ra → dán vào ô **Mã
   xác thực** → **Xác nhận**. Dòng nguồn **Claude Code CLI** xuất hiện → **Kiểm tra** → chọn **Haiku / Sonnet / Opus /
   Fable** → **Dùng model này**. Thêm tài khoản Claude khác: **Thêm tài khoản Claude**; đổi tài khoản cần PIN như Google.
3. Thẻ tài khoản báo **Hết hạn** → bấm **Đăng nhập lại** (giờ chỉ báo Hết hạn khi thật sự không gọi được).

### Nguyên nhân gốc

- **Chỉ 1 model**: `AgyClient.list_models` chỉ lấy TỪ ĐẦU mỗi dòng của `agy models` và chỉ khi từ đó có dấu "-" → mọi dòng
  dạng "Tên hiển thị (Mức)   mã-model" bị bỏ, còn đúng 1 mã; không có nhóm, không có danh mục dự phòng. Bước 4 chỉ hiện ô
  chọn khi nguồn CHƯA có model (chọn xong không đổi được).
- **"Hết hạn" cạnh "Gọi thử OK"**: thẻ tài khoản tính theo hạn của access token ngắn hạn (Google ~1 giờ) dù CLI tự làm mới
  bằng refresh token; còn "Gọi thử" của nguồn CLI chỉ chạy `agy models`, không gọi model thật. Hai nguồn sự thật khác nhau.

### Đã làm

- **API** (`gh/providers/catalog.py` mới, `clients.py`, `cli.py`, `router.py`, `system_api/routes.py`, `setup/routes.py`):
  bộ đọc `agy models` nhận mã model ở bất kỳ vị trí nào + dòng chỉ có tên hiển thị, đánh dấu "(current)"; chưa đăng nhập →
  AuthFailed (không còn "OK"). Danh mục dự phòng theo nhóm (Gemini 3.8 Flash Low/Medium/High, 3.1 Pro Low/High — mã có trong
  tệp chạy agy 1.2.9; Claude Sonnet/Opus 4.6 qua Antigravity — **chưa xác nhận mã**, luôn gọi thử trước khi lưu).
  `POST /providers/{id}/test` với nguồn CLI = liệt kê + **một lượt gọi thật ngắn** (model mặc định → model "current" → model
  đầu danh sách; bị từ chối thì thử model kế, tối đa 3); kết quả có `model_groups`, `models_source` (cli|catalog),
  `probe_model`; lỗi xác thực → `auth_state=expired` + câu "Đăng nhập lại"; gọi được thì lưu ngược tệp phiên đã làm mới.
  `POST /providers/{id}/models`: nguồn CLI gọi thử model MỚI trước khi lưu (422 `model_name` "CLI không nhận model …"),
  `make_default` → `agent.models.is_default` (migration **0022**, một model mặc định/nguồn; chuỗi chuyển hướng và bước 4 ưu tiên
  model mặc định). Bước 4 tự chọn model ĐÃ gọi thật được (`last_test.probe_model`) khi Owner chưa chọn.
  Trạng thái hồ sơ (`profile_state`): lượt gọi thật gần nhất lỗi xác thực → expired; quá hạn mà còn refresh token → ok
  (`refreshable: true`); không làm mới được → expired/expiring như cũ. Router: CLI gọi được thì xoá nhãn expired cũ.
- **Claude Code CLI** (`claude_code_cli`): cùng cơ chế với agy (`CliSpec`): đăng nhập trong api bằng
  `claude auth login --claudeai` trong pty (link OSC 8 + "Paste code here if prompted >", đo thật trên 2.1.285), gửi tạm
  `.credentials.json` khi thêm tài khoản, hồ sơ = gói {credentials, oauthAccount} mã hoá trong `agent.cli_profiles` (tách theo
  provider), đổi/xoá cần PIN, email/gói qua `oauthAccount` hoặc `claude auth status --json` (`email`, `subscriptionType`).
  Gọi model: `claude -p --model <bí danh> --output-format json --no-session-persistence --strict-mcp-config
  --disable-slash-commands --safe-mode [--system-prompt-file <tệp tạm 0600>] --tools ""` (prompt qua stdin, **tắt mọi công cụ** — model chỉ trả lời chữ,
  không chạy lệnh trong container), môi trường sạch (`CLAUDE_CONFIG_DIR`, không truyền ANTHROPIC_API_KEY), quá giờ 300 s,
  token không bao giờ nằm trên dòng lệnh/log. Lỗi: 404/"issue with the selected model" → ModelRejected, 401/login →
  AuthFailed, 429/usage limit → RateLimited. Danh sách model = bí danh `haiku`, `sonnet`, `opus`, `fable` (Claude Code không
  có lệnh liệt kê model). Chưa đăng nhập ⇒ không có nguồn ⇒ không vào chuỗi (TẮT mặc định).
- **Ảnh api/worker**: cài Claude Code **2.1.285** (kênh stable) từ gói npm theo nền tảng
  `@anthropic-ai/claude-code-linux-{x64,arm64}` (bản native, không cần Node), SHA-256 ghim (đối chiếu dist.integrity sha512
  của npm), `DISABLE_AUTOUPDATER=1`; phiên ở `/var/lib/gh/agy/claude/.claude` — CÙNG volume `agy_state` (không thêm volume,
  genh không phải đổi).
- **Web**: `ModelPicker` (ô chọn `<optgroup>` theo nhóm, chữ "Tên · gợi ý", "Đang dùng X", câu lỗi khi CLI từ chối) ở bước 4
  (luôn hiện cho nguồn sẵn sàng, đổi model được) và thẻ nguồn ở Agent & Model; gán model riêng từng agent giữ nguyên (Gán
  model). Chip tài khoản: "Đang hoạt động" / "Hết hạn" + nút **Đăng nhập lại**; meta "tự gia hạn". Thẻ **Tài khoản Claude Code
  CLI** (Agent & Model, bước 4) với khung cảnh báo + link điều khoản; `CliCard`/`useCliLogin`/`useCliProfiles` nhận `kind`.
- **Test**: api `tests/test_cli_models_v0131.py` (9; CLI giả `fake_agy_multi.py` + `agy models`, `fake_claude.py` mới:
  đăng nhập/đổi tài khoản/gọi/từ chối model/chưa cài), cũng chạy với `GH_TEST_APP_ROLE=1`; web
  `test/unit/cli-models-v0131.test.tsx` (5); e2e mock `e2e/cli-models-v0131.spec.ts` (3).

### Đã kiểm vs chưa kiểm

- **Đã kiểm thật trong máy dựng**: `agy` 1.2.9 (`agy models` chưa đăng nhập → "Please sign in to view available models",
  thoát 1; không có cờ `--json`; `-p`, `--model`, `--effort`, `--output-format json`); chuỗi `gemini-3.8-flash-{low,medium,high}`,
  `gemini-3.1-pro-{low,high}`, "Gemini 3.8 Flash (High)"… có trong tệp chạy. `claude` 2.1.285/2.1.286: cờ ở trên, `auth
  login --claudeai` in link + chờ dán mã, `auth status --json` có `email`/`subscriptionType`, `-p` đọc prompt từ stdin với
  `--tools ""`, model lạ → `is_error` + `api_error_status: 404`.
- **Review trước merge (đo thật claude 2.1.285)**: `--tools ""` tắt mọi công cụ (model chỉ "giả vờ" gọi công cụ bằng chữ,
  không có gì chạy) nhưng **hook trong `settings.json` và CLAUDE.md của CLAUDE_CONFIG_DIR vẫn chạy/nạp** → thêm `--safe-mode`
  (đo: hook không chạy, CLAUDE.md không nạp, lượt gọi vẫn OK). Lời nhắn hệ thống chuyển sang `--system-prompt-file` (không lộ
  trên /proc/*/cmdline, không vỡ khi > 128 KiB). `--model=<tên>`; tên model CLI chỉ gồm `[A-Za-z0-9._:/[]-]`, không bắt đầu
  bằng `-`. Gọi thử model CLI (thêm model mới, "Gọi thử") giới hạn 12 lượt / 10 phút / tổ chức (429 `PROBE_RATE_LIMITED`).
- **Chưa kiểm**: định dạng `agy models` KHI ĐÃ đăng nhập (bộ đọc chịu được nhiều dạng); mã model Claude trong Antigravity;
  đăng nhập Claude thật tới cuối (cần tài khoản Boss) và tệp `.credentials.json` sau đăng nhập; build Docker thật của ảnh mới
  (CI/e2e cài thật sẽ kiểm). Điều khoản: Anthropic (trang Legal and compliance của Claude Code, 02/2026) nói đăng nhập gói
  Free/Pro/Max chỉ dành cho dùng cá nhân thông thường Claude Code và ứng dụng gốc của Anthropic — dùng qua app tự động có rủi ro
  bị hạn chế; Boss đã quyết "Owner tự quyết" (QD-12), UI cảnh báo + gợi ý khoá API.

## v0.1.32 — Model và MỨC SUY NGHĨ (effort) tách riêng, Chẩn đoán CLI (01/10/2026)

### Boss cần làm gì (sau khi cập nhật)

1. Hướng dẫn thiết lập › bước 4 (hoặc Agent & Model) → dòng **Antigravity CLI** → **Kiểm tra** → ô model giờ chỉ có tên
   model gốc (vd **Gemini 3.8 Flash**, **Gemini 3.1 Pro**), ô bên cạnh **Mức suy nghĩ**: Thấp (nhanh, rẻ) / Vừa / Cao (kỹ,
   chậm hơn). Chọn → **Dùng model này**.
2. Nếu vẫn báo lỗi: bấm **Chẩn đoán** (chỉ Owner) trên dòng nguồn → **Chép** → gửi nội dung đã chép (token, email đã che).

### Nguyên nhân gốc

- "high" là mức suy nghĩ chứ không phải tên model (Boss 01/10). agy 1.2.9 nhận `--model <model gốc> --effort low|medium|high`;
  bản ≤ v0.1.31 lưu/gửi tên biến thể `gemini-3.8-flash-high` làm `--model` (kèm `--effort medium` cố định) → agy từ chối
  ("invalid model selection (--model … --effort …)") → "CLI không nhận model". Bộ nhận diện "không nhận model" cũ còn bắt
  nhầm mọi câu có "model" + "invalid".

### Đã làm

- **API**: `agent.models.effort` (migration **0023**, CHECK low|medium|high|xhigh|max; chuyển dữ liệu cũ: `…-high` → model
  gốc + `effort=high`, dòng trùng tên gốc chỉ ghi effort — lúc gọi vẫn tách hậu tố, chạy lại an toàn). `catalog.py`: bộ đọc
  `agy models` gộp biến thể về model gốc + danh sách mức (`efforts`, `default_effort` từ dòng "(current)"); danh sách không bao
  giờ thu gọn còn model đã lưu (CLI liệt kê ≤ 1 model → thêm mục dự phòng "chưa xác minh"; model đã lưu mà CLI không liệt kê
  vẫn hiện); mỗi mục có `verified` + `source_ref`. `claude-sonnet-4-6`/`claude-opus-4-6` (qua Antigravity): tệp chạy có chuỗi
  này nhưng chưa xác minh khi đăng nhập; bỏ khỏi danh sách cho đến khi xác minh. `gemini-3.5-flash-extra-low` (tên riêng trong
  tệp chạy) không bị tách thành `-extra` + low (Python lẫn migration).
  `AgyClient`: `--model <gốc> [--effort <mức>]` (không mức → không gửi `--effort`, CLI tự chọn); `ClaudeCodeClient`:
  `--effort=<mức>` (low…max). Nhận diện từ chối CHÍNH XÁC theo chuỗi lỗi có trong agy 1.2.9 / Claude Code ("invalid model
  selection", `Invalid model "…"`, `unknown model "…"`/"unknown model name", "invalid --effort", "--effort is not supported for
  the current model / for model %q"); KHÔNG khớp "unknown model tier/key" (nội bộ agy) và "The model is not available right
  now (503)" (lỗi tạm thời — chuyển nguồn/thử lại); phân biệt model sai / mức sai; đọc danh sách CLI tự nêu ("available: …")
  đưa vào câu lỗi; 422 kèm `technical` (lỗi gốc đã che) cho "Chi tiết kỹ thuật". `POST /providers/{id}/models` nhận `effort`
  (không gửi = giữ mức đã lưu; đổi mức = gọi thử lại; kiểm theo TỪNG model khi đã biết — haiku + effort → 422). Bước 4 / tự
  gán: `last_test.probe_model` cũ dạng biến thể được tách thành model gốc + mức.
  `POST /providers/{id}/test`: thêm `at`, `probe_effort`, `error_detail`, `models_raw`. Mới: `POST /providers/{id}/diagnose`
  (chỉ Owner — Quản lý bị 403; chung giới hạn 12 lượt/10 phút): `--version`, `agy models` / `claude auth status --json`,
  với agy đã đăng nhập thêm `agy -p "/model"` và `agy -p "/effort" --model <gốc>` (changelog agy 1.1.11: ở chế độ in các lệnh
  này "emit one tab-separated record per line … without starting an agent turn, spending quota" → danh sách model/mức THẬT
  của tài khoản, không tốn lượt), rồi 1 lượt gọi rất ngắn đúng model + mức; trả stdout/stderr/mã thoát đã che (token, link
  OAuth, email → `a***@miền`).
- **Web**: `ModelPicker` = ô model gốc (nhóm, "chưa xác minh" khi cần) + ô **Mức suy nghĩ** (chỉ mức model nhận; model không
  chỉnh mức → ghi "CLI tự chọn"); lỗi có "Chi tiết kỹ thuật". "Gọi thử OK · 4,63 s · gemini-3.8-flash · Cao · lúc 01/10 10:21"
  (luôn kèm giờ lần gọi thật). Nút **Chẩn đoán** + **Chép** (chỉ Owner) trên dòng nguồn CLI ở bước 4 và Agent & Model.
- **Test**: api `tests/test_cli_effort_v0132.py` (14; CLI giả `fake_agy_multi.py` mô phỏng đúng cờ/lỗi agy 1.2.9,
  `fake_claude.py` thêm `--effort`, `--version`); web `test/unit/cli-effort-v0132.test.tsx` (5); e2e mock
  `e2e/cli-effort-v0132.spec.ts` (2).

### Nguồn dữ liệu model (thứ tự tin cậy — Boss 01/10)

1. **CLI đã đăng nhập, lúc chạy**: `agy models` (đọc trung thực), `agy -p "/model"` / `"/effort"` (Chẩn đoán), lỗi
   `Invalid model %q (available: %s)` của chính CLI, `--help`. Claude Code không có lệnh liệt kê model.
2. **Tài liệu chính thức**: https://code.claude.com/docs/en/model-config (đọc 01/10/2026): bí danh `fable/sonnet/opus/haiku…`;
   effort low…max cho Fable/Opus/Sonnet (Haiku không có trong bảng → không gửi `--effort`). Chưa đọc được tài liệu chính thức
   của Antigravity CLI (codelabs.developers.google.com bị chặn mạng trong máy dựng).
3. **Dự phòng tối thiểu, "chưa xác minh"** (chỉ khi không có 1): `gemini-3.8-flash` (low/medium/high), `gemini-3.1-pro`
   (low/high) — biến thể có trong tệp chạy agy 1.2.9.
- Đo thật 01/10/2026 (agy 1.2.9 chưa đăng nhập): `agy --help` → `--effort  Reasoning effort for the current CLI session
  (low|medium|high)`, `--model  Model for the current CLI session`; changelog trong tệp chạy: "Added an `--effort` flag to select
  a model's reasoning-effort variant", "/model picker … group models by their base model and choose reasoning effort"; hàm
  `SlugParts`, `EffortsForBase`, `ModelForBaseEffort`. `claude --help` 2.1.285: `--effort <level> (low, medium, high, xhigh,
  max)`; mức lạ → "Warning: Unknown --effort value … ignoring it" (không lỗi).

### Đã kiểm vs chưa kiểm

- Đã kiểm: cờ/lỗi ở trên trên tệp chạy thật; ruff, mypy, pytest đủ + `GH_TEST_APP_ROLE=1` phần chạm, web
  typecheck/lint/vitest, e2e mock.
- **Chưa kiểm (cần đầu ra thật của Boss)**: định dạng `agy models` KHI ĐÃ đăng nhập và `--model gemini-3.8-flash --effort high`
  được nhận thật (máy dựng không đăng nhập được) → Boss bấm **Chẩn đoán** → **Chép** gửi lại nếu còn lỗi.

## v0.1.33 — Cổng phát hành & CI đủ test (01/10/2026)

### Boss cần làm gì

1. Máy Boss: **không cần làm gì.** Bản mới chỉ tới máy sau khi qua E2E cài thật; lịch tự cập nhật đêm đợi bản đã là bản
   chính thức đủ 24 giờ (thẻ "Có bản mới" ghi lúc nào tự cài). Muốn lấy sớm: Console → **Cập nhật ngay**.
2. **Chỉ khi Claude báo token không có quyền admin repo**: mở https://github.com/Genesis-ryan-84-0567536339/Gen-Harness/settings/rules,
   **bật bảo vệ nhánh `main` + tag `v*`** theo mục "Bật bảo vệ nhánh main + tag v*" ngay dưới "Đã làm" (~2 phút, chỉ bấm chọn,
   không gõ lệnh). Ngoài ra không cần làm gì.
   Chưa bật cũng không hỏng gì (mã không phụ thuộc vào nó), chỉ là PR đỏ vẫn còn đường merge tay.

### Nguyên nhân gốc

- **F-9**: `release.yml` chạy song song với CI (các job chỉ `needs: meta`), Release tạo xong là thành **latest** ngay; E2E cài
  thật chỉ chạy SAU đó (`workflow_run`) nên đỏ cũng không chặn được gì. v0.1.24 từng phát hành xanh trong khi CI trên đúng
  commit đó đỏ. Timer đêm 03:00 cài luôn bản vừa ra. Chữ ký cosign có đính kèm nhưng không nơi nào kiểm, trong khi
  `docs/ROADMAP.md:3` và `docs/handoff/05-installer.md:30` ghi như đã kiểm. `main` không được bảo vệ.
- **F-13**: CI bỏ sót bộ test đã có — `go test` của genh (45 tệp `_test.go`) không chạy ở đâu; Playwright mock của web không
  chạy; pytest chạy bằng superuser (thiếu GRANT/RLS cho `gh_app` chỉ lộ sau phát hành); E2E chế độ pr không kích hoạt khi đổi
  `apps/api/**`, `apps/web/Dockerfile`, `VERSION`; không kiểm `alembic heads` = 1 (`alembic upgrade heads` che nhánh migration kép).

### Đã làm

- **F-9 — cổng phát hành (7 bước, tự động, không cần người duyệt)**:
  1. `ci.yml` thêm `on: workflow_call` (input `from_release`, mặc định false); `release.yml` gọi nó thành job `ci`
     (`uses: ./.github/workflows/ci.yml`, `from_release: true`) và đưa `ci` vào `needs` của job `release` — CI đỏ thì không
     có Release. Khi `from_release`, nhóm concurrency của `ci.yml` là duy nhất theo `run_id`, `cancel-in-progress: false`.
  2. Job `release` tạo **bản thử (prerelease)** (`make_latest: false`). `/releases/latest` bỏ qua prerelease nên genh,
     `install.sh`, Console (`apps/api/gh/system_api/update.py`) chưa thấy bản này.
  3. `e2e-install.yml` (chế độ release) tìm **đúng tag** từ `workflow_run.head_sha`, cài bằng `install.sh` với biến mới
     `GEN_HARNESS_RELEASE_TAG` (tuỳ chọn, chỉ CI/E2E); `e2e-upgrade` cài **bản chính thức (latest)** hiện tại rồi nâng cấp LÊN
     đúng tag đó (đặt binary mới bằng tay vì bản thử bị ẩn khỏi tự cập nhật).
  4. Job `promote`: E2E xanh → **một** lệnh `gh release edit <tag> --prerelease=false --latest --notes-file …` vừa nâng latest
     vừa ghi dấu `<!-- genh:promoted_at=<UTC> -->` vào ghi chú Release; in `releases/latest` trước/sau, `exit 1` nếu sai
     hoặc thiếu dấu; rồi gắn ảnh GHCR `:latest` (build-images chỉ đẩy `:<version>`). Bản có hậu tố `-` không bao giờ được
     promote. **Promote tay** (chỉ khi E2E lỗi vì lý do ngoài mã): Actions → **E2E cài đặt thật** → **Run workflow** với
     `tag` + `promote=true` + `skip_e2e=true`.
  5. **Thời gian chín 24 giờ** (chỉ lịch đêm): `selfupdate.NightlyMinAge = 24h` qua `Options.MinAge`; `genh update --yes`
     KHÔNG kèm `--if-requested` bỏ qua bản chưa là bản chính thức đủ 24 giờ (`Result.Deferred`), để đêm sau. Mốc = dấu
     `promoted_at` (không có thì `published_at`, lấy mốc muộn hơn) — `published_at` là lúc tạo bản thử, promote không đổi.
     "Cập nhật ngay" (`--yes --if-requested`) và `genh update` gõ tay không bị chặn.
  6. Tài liệu đúng thực tế: genh/`install.sh`/`install.ps1` chỉ kiểm SHA-256 theo `checksums.txt`, **CHƯA kiểm cosign** (để
     sau); khối "Cổng phát hành" trong `docs/handoff/05-installer.md`. Script bất biến `.github/scripts/check_release_gate.py`
     chạy trong job `version` của CI — PR lỡ gỡ cổng sẽ đỏ ngay. Bảo vệ nhánh: hướng dẫn bên dưới (cần admin, ngoài mã).
  7. Sau promote, job **`e2e-selfupdate`** đi đúng đường máy Owner: cài bản chính thức trước, `genh update --yes --quiet` phải
     hoãn (genh cũ ≥ v0.1.33), `genh update` → genh cũ tự tải genh mới, re-exec, nâng dịch vụ bằng compose nhúng mới; đỏ ⇒
     `::error` + cách lùi bản (còn trong 24 giờ chín).
- **F-13 — CI chạy đủ bộ test đã có**: `installer-matrix.yml` thêm `go vet ./...` + `go test ./...` trên 4 hệ điều hành
  (ubuntu-22.04/24.04, macos-14, windows-2022); pytest api thêm một lượt `GH_TEST_APP_ROLE=1` (dưới vai `gh_app`); job web chạy
  Playwright mock; kiểm `alembic heads` chỉ có đúng 1 head; bộ lọc E2E chế độ pr thêm `apps/api/**`, `apps/web/Dockerfile`,
  `deploy/images/**`, `VERSION`; **job tổng `ci-ok`** (ci.yml) và **`installer-ok`** (installer-matrix.yml) luôn chạy, không lọc
  đường dẫn, đỏ khi bất kỳ job con nào đỏ/bị huỷ — đây là 2 required check DUY NHẤT.
- `VERSION` → `v0.1.33`. `docs/ROADMAP.md` dòng 3 + mục Đã xong.

### Bật bảo vệ nhánh `main` + tag `v*` (~2 phút, cần quyền admin repo)

Mở https://github.com/Genesis-ryan-84-0567536339/Gen-Harness/settings/rules (Settings → Rules → Rulesets).

**A. Nhánh `main`** — bấm **New ruleset** → **New branch ruleset**:
1. **Ruleset Name**: `main`. **Enforcement status**: **Active**. Bypass list: để trống.
2. **Target branches** → **Add target** → **Include default branch**.
3. Bật **Require status checks to pass** → **Add checks** → gõ và chọn đúng 2 check: `ci-ok` và `installer-ok`.
   - CHỈ 2 job tổng này (luôn chạy). **KHÔNG** thêm job E2E hay job con nào khác: E2E có lọc đường dẫn, PR chỉ sửa docs sẽ
     kẹt "Expected — waiting for status to be reported" mãi.
   - Ô tìm không ra tên → mở 1 PR bất kỳ đã chạy CI xong (GitHub chỉ gợi ý tên check đã từng chạy) rồi thử lại.
   - **Không** bật "Require branches to be up to date before merging" (mỗi PR phải cập nhật lại nhánh mới merge được, chậm
     vô ích với quy trình tự merge).
4. Giữ bật **Block force pushes** và **Restrict deletions** (thường đã bật sẵn).
5. **KHÔNG** bật "Require a pull request before merging" / approvals — quy trình tự merge khi CI xanh giữ nguyên.
6. Bấm **Create**.

**B. Tag `v*`** — **New ruleset** → **New tag ruleset**:
1. **Ruleset Name**: `tag v*`. **Enforcement status**: **Active**.
2. **Target tags** → **Add target** → **Include by pattern** → `v*`.
3. Bật **Restrict updates**, **Restrict deletions**, **Block force pushes**.
4. **KHÔNG** bật **Restrict creations**. Nếu vẫn muốn bật thì **PHẢI** thêm **GitHub Actions** vào **Bypass list** — nếu không,
   `release.yml` (`github-actions[bot]`) không tạo được tag và **phát hành bị chặn**.
5. Bấm **Create**.

Hệ quả cần biết: tag `v*` không xoá/dời được nữa — bản thử hỏng cứ để nguyên (máy nào cũng không thấy), sửa mã rồi tăng
`VERSION`. Gỡ tạm: mở ruleset → **Enforcement status: Disabled** → Save.

Kiểm sau khi bật (người điều phối): 1 PR thử cố ý làm đỏ CI → nút merge bị chặn; 1 PR thử chỉ sửa `docs/` → merge được. Đóng,
xoá nhánh cả hai sau khi kiểm.

### Bẫy đã tránh

- **Concurrency `ci.yml` khi `workflow_call`**: trong workflow được gọi, `github.*` là ngữ cảnh của workflow gọi (push, ref
  `main`), nên nhóm cũ `ci-${{ github.ref }}` + `cancel-in-progress: true` trùng với lượt CI do chính push vào `main` → hai bên
  huỷ nhau, job `ci` "cancelled" → không phát hành. Sửa: khi `from_release`, nhóm duy nhất theo `run_id`, không huỷ.
- **Concurrency `e2e-install` theo `head_sha`**: nhóm cũ theo `github.ref` (= `main` với `workflow_run`) + huỷ lượt cũ → một lượt
  Release sau đó không tạo tag (PR không đổi `VERSION`) sẽ huỷ E2E đang chạy của bản có tag → bản thử không bao giờ được
  promote. Nay mỗi commit một nhóm; lượt không có tag ứng với `head_sha` thì bỏ qua, không promote.
- **E2E chế độ pr dùng `releases/latest`** thay `gh release list` (danh sách đó gồm cả prerelease → ghim nhầm compose của bản
  thử chưa qua E2E). `e2e-upgrade` cũng nâng cấp TỪ bản chính thức thay vì "tag thứ 2 trong danh sách".
- Required check chỉ là job tổng luôn chạy (xem trên) — tránh PR chỉ sửa docs kẹt mãi.

### Sửa sau review (trước merge)

- 24 giờ tính từ **lúc promote** (dấu `promoted_at` trong ghi chú Release), không từ `published_at` — bản thử promote muộn
  (vd promote tay `skip_e2e` sau vài ngày) trước đây lọt cổng ngay đêm đó. Console (`GET /system/update`) trả `published_at` =
  mốc đó, thẻ "Có bản mới" ghi "Tự cài lúc ~03:00 sau <ngày giờ> — hoặc bấm Cập nhật ngay"; dấu không hiện trong ghi chú.
- Job `e2e-selfupdate` (trên). Rủi ro cũ "không E2E nào đi đường genh cũ tự tải binary mới" đã đóng.
- `--yes` vẫn là cờ kích hoạt cổng (unit lịch đêm không được ghi lại khi `genh update` — đổi sang cờ mới thì máy đã cài mất
  cổng); dòng lý do nói rõ "chế độ --yes (lịch đêm)" và cách cài ngay (`genh update` không `--yes` / nút). Bị hoãn thì dòng kết
  `--quiet` là "dịch vụ đã kiểm/khởi động lại xong — bản genh mới đang đợi đủ 24 giờ", không còn "cập nhật xong.".
- `install.sh`: `GEN_HARNESS_RELEASE_TAG` kiểm bằng regex thật; tag không tồn tại → lỗi dễ hiểu; máy đã cài + ghim tag →
  `genh update --no-self-update` (trước đó selfupdate âm thầm thay bản ghim bằng latest).
- `resolve` ưu tiên tag không hậu tố khi `v0.1.33` và `v0.1.33-rc.1` cùng trỏ một commit (trước đó chọn nhầm bản `-rc`).
- Ảnh GHCR `:latest` chỉ gắn ở `promote`. `ci-ok`: sửa dấu nháy lồng trong `::error` (SC2140).
- `check_release_gate.py` giữ thêm: dấu promote cùng lệnh nâng latest, có `e2e-selfupdate`, build-images không gắn `:latest`;
  có test riêng (`.github/scripts/test_check_release_gate.py`, chạy trong job `version`).

### Rủi ro đã biết

1. `go test` trên windows-2022/macos-14 lần đầu chạy có thể đỏ — chỉ CI mới kiểm được (máy dựng là Linux).
2. `e2e-selfupdate` chỉ chạy SAU promote (bản thử bị ẩn khỏi `releases/latest`) — đỏ thì bản đã là latest, phải lùi tay theo
   `::error` của job (còn 24 giờ trước khi lịch đêm tự cài). Bước kiểm hoãn chỉ chạy khi bản trước ≥ v0.1.33 (bản cũ hơn
   chưa có cổng); lần phát hành v0.1.33 (bản trước v0.1.32) chỉ kiểm phần tự tải + nâng cấp.
3. Promote **ngoài** workflow (sửa Release bằng tay) không ghi dấu `promoted_at` → 24 giờ tính từ `published_at`. Promote tay
   luôn đi qua Actions → E2E cài đặt thật (`skip_e2e`) để có dấu.
4. Bảo vệ nhánh là việc của người có quyền admin — mã không phụ thuộc vào nó; chưa bật thì PR đỏ vẫn merge tay được.

### Test

- genh: `go test` của `internal/selfupdate` (bỏ qua bản < 24 giờ khi `--yes` không `--if-requested`; "Cập nhật ngay" không bị
  chặn) — nay chạy trong CI trên 4 hệ điều hành cùng toàn bộ `go test ./...`.
- CI: `check_release_gate.py` trong job `version`; `tr -d '[:space:]' < VERSION` = `v0.1.33` khớp regex job `version`.
- Tệp test mới: `apps/genh/internal/selfupdate/selfupdate_test.go` (`TestRun_MinAge_*`, `TestRun_KhongMinAge_CapNhatNgay`,
  `TestRun_Prerelease_BoQua`, `TestRun_MinAge_PromoteMuon_TinhTuLucPromote` — published_at 5 ngày, promote 2 giờ ⇒ hoãn,
  `TestPromotedMarker_DinhDangVaDocLai`), `apps/genh/cmd/genh/main_test.go` (`--yes` → 24 giờ, `--yes --if-requested` → 0,
  không `--yes` → 0; đường nút "Cập nhật ngay"; dòng kết khi bị hoãn), `apps/genh/cmd/genh/installsh_unix_test.go`
  (`install.sh` thật với curl/genh giả: tag sai dạng, tag không tồn tại, máy đã cài + ghim tag → `update --no-self-update`),
  `apps/api/tests/test_system_update.py` (`official_since`, ẩn dấu, payload `published_at`), `apps/web/test/unit/update.test.tsx`
  (câu "Tự cài lúc ~03:00 sau …"), `.github/scripts/test_check_release_gate.py`, `apps/api/tests/test_migrations_heads.py`;
  test genh phụ thuộc POSIX tách sang `*_unix_test.go` / `steps_finalize_linux_test.go` để chạy được trên Windows/macOS.
- Chạy trên nhánh tích hợp (máy dựng Linux, 01/10/2026): genh `go vet ./...` sạch (cả GOOS=windows/darwin), `go test -count=1
  ./...` 305 pass / 1 skip (máy không có certutil); api ruff + mypy sạch (127 tệp), `alembic heads` = `0023 (head)`, pytest
  1106 pass (lượt thường) + 1106 pass (`GH_TEST_APP_ROLE=1`); web lint/typecheck sạch, vitest 280/280, build OK, bridge 50
  pass, Playwright mock 134/134 (10 spec); browser ruff + mypy sạch, pytest 14 pass; `check_release_gate.py` OK; actionlint
  sạch cho ci/release/e2e-install/installer-matrix; `install.sh` `bash -n` OK, `GEN_HARNESS_RELEASE_TAG` sai dạng bị từ chối.

### Đã kiểm vs chưa kiểm

- Đã kiểm: _(người điều phối điền sau merge — link + kết quả thật, KHÔNG ghi trước)_
  - CI trên PR (`ci-ok`, `installer-ok`, go test 4 hệ điều hành): _…_
  - Release v0.1.33 tạo ra **bản thử**, `gh api repos/Genesis-ryan-84-0567536339/Gen-Harness/releases/latest` lúc đó vẫn
    v0.1.32: _…_
  - Không có job `ci` bị "cancelled" trong lượt Release trên `main`: _…_
  - E2E (`e2e-install` + `e2e-upgrade`) đúng tag v0.1.33 xanh; job `promote` in latest trước v0.1.32 → sau v0.1.33 (kèm dấu
    `promoted_at`): _…_
  - `e2e-selfupdate` v0.1.32 → v0.1.33 xanh (genh cũ tự tải genh mới): _…_
  - genh tải về (checksum/version) đúng v0.1.33: _…_
- Chưa kiểm: _(điền)_ — bảo vệ nhánh (chờ admin bật, rồi 2 PR thử ở trên); timer đêm thật bỏ qua bản < 24 giờ trên máy Boss.
