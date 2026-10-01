# Gen-Harness

Gen-Harness là một hệ thống tự trị có kiểm soát cho một tổ chức bán hàng/dịch vụ nhỏ: lắng nghe các kênh nhắn
tin (Zalo, WhatsApp…), sàng lọc thành dữ liệu sạch có nguồn gốc rõ ràng, và để agent AI soạn — nhưng không tự
ý gửi — phản hồi, cập nhật cơ hội bán hàng, cảnh báo sớm. Mọi việc "ra ngoài", vượt ngưỡng tiền, hoặc liên quan
nhân sự luôn dừng lại chờ người duyệt ở Bàn làm việc. Chi tiết kiến trúc và mục tiêu: `docs/ARCHITECTURE.md`;
kế hoạch thi công theo giai đoạn: `docs/PLAN.md`.

## Yêu cầu hệ thống

- Docker Engine + Docker Compose v2 (`docker compose`, không phải `docker-compose` cũ).
- ~4 GB RAM rảnh, vài GB đĩa trống (Postgres, Redis, ảnh container).
- Một máy Linux/macOS (hoặc WSL2 trên Windows) có thể mở cổng ra ngoài để chạy `caddy` (mặc định `:8443`).
- Để đăng nhập kênh thật (giai đoạn thiết lập): điện thoại đã cài Zalo/WhatsApp, quét được mã QR.

## Cài đặt

Gen-Harness chạy bằng **`docker compose`** — không cần cài Python/Node/Postgres lên máy. (Giai đoạn 6 của kế
hoạch dự kiến thêm một trình cài một lệnh `genh` bọc quanh đúng các bước dưới đây; đến lúc đó, cách cài chuẩn
là `docker compose`.)

```bash
git clone <repo-này> Gen-Harness && cd Gen-Harness

# 1) Sinh khoá bí mật (secrets/gh_master_key, secrets/gh_bridge_key — KHÔNG commit) + tạo .env từ .env.example
make secrets
# → mở .env, đổi POSTGRES_PASSWORD và GH_APP_DB_PASSWORD (mặc định chỉ dùng được cho máy cá nhân/dev)

# 2) Dựng và khởi động toàn bộ hệ thống
make up
# tương đương: docker compose -f deploy/compose.yaml --env-file .env up -d --build
```

`make up` kéo lên 8 dịch vụ (`deploy/compose.yaml`):

| Dịch vụ | Vai trò |
|---|---|
| `proxy` (Caddy) | Cổng vào duy nhất mở ra ngoài, HTTPS tự ký, mặc định `:8443` |
| `web` | Console (giao diện) |
| `migrate` | Chạy migration Postgres một lần rồi thoát, trước khi `api`/`worker` khởi động |
| `api` | FastAPI — mọi nghiệp vụ, xác thực, WebSocket realtime |
| `worker` | Tiến trình nền (arq): sàng lọc, hook nghiệp vụ, việc định kỳ (kể cả backup — xem bên dưới) |
| `bridge` | Kết nối kênh nhắn tin thật (Zalo/WhatsApp qua QR), chỉ giữ khoá bridge, không bao giờ có khoá master |
| `db` | Postgres 16 (pgvector, pg_partman) |
| `redis` | Redis Streams (hàng đợi sự kiện) + cache |

Tài liệu và bản sao lưu lưu trên đĩa qua volume Docker `gh_objects` (`GH_OBJECTS_DIR`, gắn vào `api` + `worker`
— xem `docs/reports/HANDOFF-v0.1.1.md`), không còn dịch vụ MinIO riêng như bản trước v0.1.1.

Xem tiến trình dựng và log:

```bash
make ps            # trạng thái từng dịch vụ (đợi tới khi tất cả "healthy")
make logs           # log trực tiếp mọi dịch vụ
make logs-token      # in mã thiết lập một lần (nếu GH_SETUP_TOKEN để trống trong .env, api tự sinh)
```

Khi `api` và `web` đã "healthy", mở **`https://localhost:8443/setup`** (trình duyệt sẽ cảnh báo chứng chỉ tự
ký ở môi trường dev — chấp nhận tiếp tục) và nhập mã thiết lập từ `make logs-token`.

## Các bước thiết lập chính (trình thiết lập Owner, 12 bước)

Trình thiết lập ở `/setup` dẫn người dùng qua đủ các bước để hệ thống dùng được ngay, theo thứ tự:

1. **Chào mừng** — nhập mã thiết lập một lần.
2. **Tài khoản Owner** — tên, email, mật khẩu, **PIN 6 số** (PIN xác nhận mọi thao tác nhạy cảm sau này).
3. **Tổ chức & xưng hô** — tên tổ chức, múi giờ, đơn vị tiền tệ, cách agent xưng hô.
4. **Bộ não AI** — chọn nhà cung cấp model (API key), chuỗi ưu tiên có failover.
5. **Kết nối kênh** — đăng nhập Zalo/WhatsApp bằng **mã QR** (xem cảnh báo rủi ro bắt buộc ở mục kế tiếp).
6. **Chọn nhóm lắng nghe** — mặc định MỌI nhóm mới ở chế độ "Không nghe"; Owner tự bật từng nhóm muốn theo dõi.
7. **Sàng lọc dữ liệu** — chu kỳ thời gian hoặc ngưỡng số lượng tin để đẩy vào sàng lọc.
8. **Agent đầu tiên** — tạo agent, thử trò chuyện ngay trong trình thiết lập.
9. **Tự trị & ranh giới** — mức tự trị (0–6) của agent; xác nhận đã đọc các ranh giới cứng (không tắt được:
   agent không tự ra quyết định nhân sự, tin gửi ra ngoài luôn chờ duyệt, v.v. — `docs/ARCHITECTURE.md` §1).
10. **Mời đội ngũ** *(tuỳ chọn)* — tạo tài khoản + mật khẩu tạm cho nhân viên (chưa có SMTP thật để tự gửi mời
    qua email — mật khẩu tạm hiện ngay trên màn để Owner tự gửi).
11. **Sao lưu** *(tuỳ chọn)* — chọn lịch (hằng ngày/hằng tuần/hằng tháng) và giờ chạy sao lưu tự động; cơ chế
    backup thật (mô tả ở mục "Sao lưu/khôi phục" bên dưới) đọc đúng cấu hình này.
12. **Hoàn tất** — vào thẳng Console.

Mỗi bước (trừ các bước bắt buộc) có thể bỏ qua và cấu hình lại sau trong Console (Điều khiển hệ thống).

## Rủi ro khi đăng nhập kênh bằng tài khoản cá nhân (Zalo/WhatsApp)

Gen-Harness kết nối Zalo/WhatsApp **như một thiết bị đăng nhập thêm của chính tài khoản cá nhân**, không qua
cổng API chính thức dành cho doanh nghiệp (những nền tảng này chưa cấp API mở tương đương). Trước khi hiện mã
QR ở bước 5, Console luôn bắt xác nhận đã đọc cảnh báo này (không có đường tắt bỏ qua):

> Gen-Harness kết nối [kênh] như một thiết bị đăng nhập của chính Sếp, không qua cổng chính thức cho doanh
> nghiệp. [Kênh] có thể tạm khoá hoặc hạn chế tài khoản nếu thấy hoạt động bất thường.

Khuyến nghị đi kèm, cũng hiện ngay trên màn xác nhận:

- Dùng tài khoản **do chính Owner/người phụ trách sở hữu**, không dùng tài khoản của nhân viên hay khách.
- Bridge chỉ lắng nghe các nhóm đã được bật rõ ràng — mọi nhóm mới mặc định "Không nghe".
- Tin gửi đi luôn qua hàng đợi và ranh giới tự trị đã cấu hình — không gửi hàng loạt, không spam.
- Có thể đăng xuất kênh bất cứ lúc nào, từ Console hoặc ngay trên ứng dụng điện thoại.

Vì đây là rủi ro thật (không phải hình thức), **cân nhắc kỹ trước khi kết nối tài khoản chính đang dùng cho
công việc khác** — nên dùng một số/tài khoản riêng cho việc này nếu có thể.

## Sao lưu / khôi phục

Hệ thống tự sao lưu định kỳ theo lịch cấu hình ở bước 11 (worker quét cấu hình mỗi 15 phút): `pg_dump` toàn bộ
CSDL, **mã hoá** bằng đúng cơ chế mã hoá bí mật của hệ thống, lưu vào kho đối tượng đĩa cục bộ (volume
`gh_objects`, `GH_OBJECTS_DIR`). Vòng đời: giữ **7 bản hằng ngày + 4 bản hằng tuần + 12 bản hằng tháng gần
nhất**, tự dọn bản thừa sau mỗi lần chạy.

Lệnh thủ công (chạy trong container `api`/`worker`, hoặc từ máy dev qua `make`):

```bash
make backup                       # sao lưu ngay
make backup-list                  # liệt kê các bản đang giữ
make restore BACKUP=<khoá-bản-backup>   # khôi phục một bản (mặc định vào CSDL đang cấu hình)
```

Chi tiết cơ chế, thuật toán vòng đời, và kết quả kiểm round-trip thật (sao lưu dữ liệu thật → khôi phục vào
CSDL trống → đối chiếu từng dòng): `docs/reports/phase-5-backup.md`.

Để **chuyển toàn bộ hồ sơ Owner sang máy khác** (CSDL + object + bí mật, mã hoá lại bằng khoá master của máy
đích): `genh export --to <file>` / `genh import <file> [--yes]` — xem `docs/handoff/05-installer.md` và
`docs/reports/HANDOFF-v0.1.1.md`.

**⚠️ Cảnh báo — khoá chỉ nằm trên máy này**: `GH_MASTER_KEY` (mã hoá bí mật ứng dụng) và, nếu có cấu hình,
`GH_BACKUP_KEY` (mã hoá riêng cho backup — xem `docs/reports/HANDOFF-v0.1.2.md`) chỉ tồn tại trên máy đang
chạy, không tự sao lưu ra ngoài. Máy hỏng/ổ đĩa hỏng **mà không có bản sao khoá ở nơi khác** → mọi bản backup
tại chỗ (kể cả trong `gh_objects`) đều **không giải mã lại được**, coi như mất hoàn toàn.

Tự bảo vệ: định kỳ chạy `genh export --to <file>` ra một ổ đĩa/máy KHÁC (USB, máy khác, kho lưu trữ ngoài) —
gói `.ghbundle` mang theo cả khoá master (và khoá bridge nếu có), tự bảo vệ bằng mật khẩu riêng (`GH_BUNDLE_
PASSWORD`, argon2id + AES-256-GCM), không phụ thuộc khoá đang cấu hình trên máy nguồn. Giữ mật khẩu gói này
một nơi khác, an toàn (không cùng chỗ với gói) — mất mật khẩu gói cũng coi như mất gói.

## Nâng cấp

**Từ v0.1.5: tự động mỗi đêm — không phải làm gì.** `genh install` tự bật lịch "tự cập nhật" (systemd
timer/crontab trên Linux, LaunchAgent trên macOS, Task Scheduler trên Windows), chạy `genh update --yes
--quiet` lúc ~03:00 giờ máy: tự hỏi bản `genh` chính thức mới nhất trên GitHub Releases, kiểm SHA-256, thay
binary, RỒI mới backup + migrate + khởi động lại dịch vụ — tự rollback nếu bất kỳ bước nào lỗi.

**Từ v0.1.33, lịch đêm chỉ cài bản đã là bản chính thức đủ 24 giờ** (bản mới ra chưa đủ thì đợi đêm sau — có
thể tới 2 đêm), để bản lỗi vừa phát hành không tự lan sang mọi máy ngay đêm đầu. Thẻ "Có bản mới" trong Console
ghi rõ lúc nào sẽ tự cài. Muốn cài **ngay**: Console → **Cập nhật ngay**, hoặc chạy tay (không kèm `--yes`):

```bash
genh update
```

Kiểm/tắt lịch tự động: `genh auto-update status` / `genh auto-update disable` (bật lại: `genh auto-update
enable`, hoặc thêm `--no-auto-update` lúc `genh install` để không bật ngay từ đầu). Chi tiết cơ chế từng hệ
điều hành: `docs/handoff/05-installer.md` mục "Lệnh vận hành".

Máy cài từ trước v0.1.3 (chưa có `genh update` tự thay binary) vẫn chạy lại được **đúng một dòng lệnh cài**
đã dùng lần đầu — từ v0.1.5, script này (`install.sh`/`install.ps1`) tự phát hiện máy **đã cài** rồi CHẠY LUÔN
`genh update` (không chỉ in hướng dẫn như trước), an toàn vì `genh update` đã tự có backup + rollback:

```bash
curl -fsSL https://github.com/Genesis-ryan-84-0567536339/Gen-Harness/releases/latest/download/install.sh | sh
```

(Windows: `irm .../install.ps1 | iex`.) `genh install` chỉ dùng cho máy **chưa cài lần nào**, hoặc lần cài
trước **thật sự chưa xong** (thêm cờ `--force` nếu cần cố tình cài lại một máy đã cài).

## Phát hành

Phát hành = tăng `VERSION` (ở gốc repo) trong PR, merge vào main — GitHub Actions (`release.yml`) tự build, tự
tạo GitHub Release và tag tương ứng, không cần ai tạo tag/release tay. Chi tiết: `docs/handoff/05-installer.md`
mục "Phát hành".

## Phát triển

Monorepo npm workspaces + một app Python riêng:

```
apps/
  api/       FastAPI + arq worker (Python, .venv riêng — apps/api/gh/)
  web/       Console (React/Vite — apps/web/src/)
  bridge/    Kết nối kênh nhắn tin thật (Node)
packages/
  contracts/ Kiểu dữ liệu dùng chung giữa api/web
db/          Migration SQL (Alembic)
deploy/      Dockerfile từng dịch vụ + deploy/compose.yaml
docs/        ARCHITECTURE.md, PLAN.md, thiết kế gốc (docs/design/), đặc tả bàn giao (docs/handoff/), báo cáo
             từng giai đoạn (docs/reports/)
```

Chạy test (không cần Docker — dùng Postgres/Redis local, xem `apps/api/tests/conftest.py`):

```bash
make api-lint                     # ruff + mypy (apps/api)
make api-test                     # pytest (apps/api) — hiện 860+ test
make web-test                     # test unit Console
make bridge-test                  # test bridge
make test                         # cả bốn lệnh trên
```

Dữ liệu mẫu để phát triển/demo (đi đúng luồng raw → sàng lọc → sạch, không chèn thẳng vào bảng):

```bash
make seed-demo                    # nạp 115 sự kiện mẫu theo docs/design/seed-data.json
make seed-demo-clean              # xoá kết luận đã sinh (giữ nguyên bản ghi thô bất biến)
```

Chạy API không cần Docker để phát triển nhanh: `make api-dev` (cần `GH_DATABASE_URL`/`GH_REDIS_URL` trỏ tới
Postgres/Redis local, hoặc export các biến tương ứng trước khi chạy).

## Tài liệu chi tiết hơn

- `docs/ARCHITECTURE.md` — kiến trúc hệ thống, ràng buộc bắt buộc (R1–R10), luồng dữ liệu.
- `docs/PLAN.md` — kế hoạch thi công theo giai đoạn, quyết định thiết kế (Q1–Q7).
- `docs/reports/` — báo cáo từng giai đoạn đã hoàn thành: `phase-1.md` … `phase-4.md` (nền tảng → các cụm màn
  Console), `phase-5-visual.md` (so ảnh pixel 21 màn), `phase-5-e2e-live.md` (luồng 2–8 trên hệ thống thật),
  `phase-5-resilience.md` (chịu lỗi Postgres/Redis/bridge/provider), `phase-5-performance.md` (benchmark 10
  triệu bản ghi), `phase-5-backup.md` (sao lưu/khôi phục — mục này).
