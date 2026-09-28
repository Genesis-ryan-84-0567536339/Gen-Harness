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
