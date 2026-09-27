# Bàn giao v0.1.1 — sửa lưu trữ, hồ sơ Owner, CSDL, RLS

Trạng thái: **đang làm** trên nhánh `claude/admiring-goodall-6dmk8k` (khởi từ `main` sau PR #3 / tag v0.1.0).
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
