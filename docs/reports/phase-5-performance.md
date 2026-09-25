# Báo cáo giai đoạn 5.5 — Row-Level Security + hiệu năng

Nhánh `claude/zen-lovelace-ph1qa2` · 25/09/2026 · môi trường sandbox: Postgres 16 + pgvector + pg_partman và
Redis chạy **local** (không Docker, không phải máy production thật), 15 GB RAM / 4 CPU / 29 GB đĩa trống. Số đo
dưới đây là số đo THẬT trong môi trường sandbox này — dùng để tham khảo tương đối (có tối ưu hay không, cải
thiện bao nhiêu lần), KHÔNG phải cam kết hiệu năng cho máy chủ production.

## 1. Row-Level Security — quyết định: LÀM, phạm vi vừa phải (lớp phòng thủ thứ hai, không phải cách ly SaaS)

Đọc `docs/ARCHITECTURE.md` §8.3 và `docs/handoff/03-database.md` trước khi viết migration:

- `docs/handoff/03-database.md`: *"Đa tổ chức từ ngày đầu — mọi bảng nghiệp vụ có `org_id`; Row-Level Security
  bật ở giai đoạn 6."*
- `docs/ARCHITECTURE.md` §8.3: *"Row-Level Security Postgres bật ở giai đoạn hoàn thiện như lớp phòng thủ thứ
  hai (handoff 03)."* — "giai đoạn hoàn thiện" là tên của **Giai đoạn 5** trong `docs/PLAN.md` (mục 5 có tiêu đề
  "Giai đoạn 5 — Hoàn thiện"), không phải Giai đoạn 6. Hai tài liệu lệch số giai đoạn với nhau (handoff/03 có
  thể viết trước khi các giai đoạn được đánh số lại) — theo `docs/ARCHITECTURE.md` §0 (bảng thứ tự ưu tiên),
  `ARCHITECTURE.md` là nơi "chốt các quyết định kiến trúc" cho repo này, nên làm RLS ở giai đoạn 5 là đúng.
- `gh/bootstrap.py` xác nhận thực tế vận hành: **"Một bản cài = một tổ chức"** — mỗi triển khai Gen-Harness
  (`docker compose up`, GĐ 5.7/6) chỉ có ĐÚNG MỘT dòng `core.organizations`. Đây KHÔNG phải mô hình SaaS nhiều
  khách thuê dùng chung một CSDL.

**Kết luận**: RLS **có làm**, nhưng vai trò của nó là **lớp phòng thủ bổ sung** (đúng nghĩa đen "lớp phòng thủ
thứ hai" mà ARCHITECTURE nói) chống lỗi lập trình quên lọc `org_id` ở tầng service/`ScopeFilter`, không phải cơ
chế cách ly nhiều khách thuê chính (vì thực tế chỉ có 1 `org_id`/CSDL). Không "làm liều" bật RLS diện rộng: chỉ
bật trên các bảng nghiệp vụ nhạy cảm/nhiều nhất theo đúng yêu cầu (`core.persons`, `core.groups`, `raw.events`,
`clean.meaning_units`, `clean.score_snapshots`, `clean.relationships`, `biz.*`) — KHÔNG bật trên `core.users` /
`core.roles` / `core.sessions` vì luồng đăng nhập cần tra theo email/token TRƯỚC KHI biết `org_id`.

### Cách hoạt động

- Migration `db/sql/0012_p5_rls.sql`: `ENABLE ROW LEVEL SECURITY` + policy `org_isolation` trên từng bảng, điều
  kiện `org_id = current_setting('app.org_id', true)::uuid OR current_setting('app.org_id', true) IS NULL`.
- `gh/auth/deps.py::optional_user`: ngay sau khi phiên đăng nhập được xác thực, chạy
  `SELECT set_config('app.org_id', :org, true)` (tương đương `SET LOCAL`, chỉ sống trong transaction của
  request hiện tại — không rò sang connection khác khi trả về pool) — **một lần mỗi request**, không phải mỗi
  câu lệnh, nên chi phí không đáng kể (đo bên dưới).
- Nhánh `OR ... IS NULL`: để worker nền / job lịch (refinery, partman, action-log verifier…) vốn không đi qua
  request HTTP và không đặt biến này vẫn chạy bình thường — các luồng đó đã tự lọc `org_id` đúng ở tầng service
  từ trước.

### Giới hạn thật — GHI RÕ, không tô hồng

Vai trò Postgres ứng dụng dùng trong môi trường này (`postgres`, mặc định `gh/config.py`) là **SUPERUSER**.
Theo định nghĩa của Postgres, **RLS không áp dụng cho superuser** dù bảng có `ENABLE`/`FORCE ROW LEVEL
SECURITY`. Nghĩa là: các policy ở trên **được tạo đúng và đã kiểm chứng hoạt động đúng** (xem
`apps/api/tests/test_rls.py`, dùng `SET LOCAL ROLE` sang một vai trò không phải superuser/chủ bảng để mô phỏng
đúng vai trò ứng dụng phi-superuser mà một triển khai thật nên dùng), nhưng **CHƯA được vai trò kết nối thật
hiện tại của ứng dụng tôn trọng**. Khuyến nghị rõ ràng: trình cài (giai đoạn 6) cần tạo một role `gh_app`
(`LOGIN`, `NOSUPERUSER`, không phải chủ bảng, không `BYPASSRLS`) cho container `api`/`worker` dùng thay
`postgres` — khi đó các policy đã có sẵn sẽ có hiệu lực ngay, không cần sửa gì thêm ở tầng ứng dụng.

### Đo tác động hiệu năng của SET LOCAL app.org_id mỗi request

<!-- điền bằng scripts/bench_phase5.py -->

## 2. Benchmark 10 triệu `raw.events` — Tổng quan (`GET /overview`)

<!-- điền bằng scripts/bench_phase5.py -->

### Tối ưu đã áp dụng (dựa trên phân tích/EXPLAIN ANALYZE, không đoán)

`GET /overview` (`gh/biz/queue/routes.py`) có 3 câu truy vấn lọc `raw.events` theo thời gian
(`events_today`, `_data_quality`, `_hourly`) — TRƯỚC KHI sửa, cả 3 đều `JOIN core.channels c ON c.id =
e.channel_id WHERE c.org_id = :o` chỉ để lấy `org_id`, dù `raw.events` đã có sẵn cột `org_id` (ghi trực tiếp lúc
ingest, `gh/data/ingest.py`). Đã sửa cả 3 để lọc thẳng `e.org_id = :o` (bỏ JOIN), và thêm chỉ mục
`raw.events (org_id, occurred_at DESC)` (`db/sql/0013_p5_perf.sql`) — chỉ mục cũ `(org_id, received_at DESC)`
không phục vụ được lọc theo `occurred_at` (thời điểm nghiệp vụ, khác `received_at` là thời điểm ingest).

## 3. Refinery — tốc độ xử lý thật

<!-- điền bằng scripts/bench_phase5.py -->

Lưu ý: sandbox này không có khoá API nhà cung cấp LLM thật nào được cấu hình — số đo dưới đo thông lượng tầng
DB + business logic của `Refinery.run()` (nhận lô `FOR UPDATE SKIP LOCKED`, quy tắc tất định, ghi
`clean.meaning_units`/`evidence`, chấm điểm, sổ tay, cảnh báo) với bộ định tuyến quyết định tất định (không gọi
mạng), giống cách toàn bộ 860 test hiện có của repo này đo refinery — KHÔNG đo độ trễ mạng của một nhà cung cấp
LLM cụ thể.

## 4. RAM rảnh khi tải nặng

<!-- điền bằng scripts/bench_phase5.py -->

## 5. Dọn dẹp sau benchmark

`scripts/bench_phase5.py` tự tạo CSDL riêng `gh_bench_phase5` (không đụng CSDL dev/test khác), migrate, đo, rồi
**tự xoá `DROP DATABASE gh_bench_phase5`** ở khối `finally` (kể cả khi lỗi giữa chừng) — không truncate CSDL
test/dev dùng chung. Xác nhận `pytest -q` (bộ mặc định, không gồm test `slow`) vẫn xanh sau khi chạy benchmark:
xem cuối báo cáo.

## Giới hạn của môi trường này

- 15 GB RAM / 4 CPU / 29 GB đĩa — không phải máy chủ production thật; số đo chỉ có giá trị tham khảo tương đối
  trong sandbox này (có đạt < 150ms p95 hay không, cải thiện bao nhiêu lần sau tối ưu).
- Postgres/Redis chạy local (không container hoá), không có disk I/O contention như môi trường production nhiều
  container chia sẻ một máy — số đo trong sandbox có thể LẠC QUAN hơn production thật.
- Không có khoá API nhà cung cấp LLM thật → benchmark refinery không đo được độ trễ mạng thật của bước gọi model
  (chỉ đo phần DB/business logic tự chủ của hệ thống).
