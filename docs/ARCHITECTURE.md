# Gen-Harness — Kiến trúc hệ thống

**Tài liệu:** ARCHITECTURE.md · **Phiên bản:** 1.0 (duyệt 23/09/2026, kèm quyết định Q1–Q7 trong PLAN.md) · **Ngày:** 23/09/2026

## 0. Nguồn sự thật và thứ tự ưu tiên

| Ưu tiên | Tài liệu | Phạm vi |
|---|---|---|
| 1 | `docs/Gen-Harness-Product-Spec-LOCKED.md` (v2.2) | Mục đích, nghiệp vụ, thực thể, quyền, nguyên tắc có trách nhiệm. Thắng mọi mâu thuẫn. |
| 2 | `docs/design/Gen-Harness Console.dc.html` (+ `screens.json`, `seed-data.json`, `tokens.json`, `_ds/…/styles.css`) | Giao diện 21 màn, dữ liệu mẫu. Dựng lại pixel-perfect ở 1440px/1280px, không "cải tiến". |
| 3 | `docs/handoff/` (01–07, `schema.sql`) | Đặc tả kỹ thuật đi kèm thiết kế: màn hình, token, database, kiến trúc, trình cài, thiết lập Owner, nghiệm thu. |
| 4 | `docs/github.md` | Ánh xạ màn ↔ mục spec ↔ mã repo cũ `heo-harness` (chỉ tham khảo bridge Zalo/WhatsApp và chassis plugin). |

Trong repo, gói bàn giao được xếp lại: `spec/` → `docs/`, `design/` → `docs/design/`, `docs/01–07` và `db/schema.sql` → `docs/handoff/` (đường dẫn trong `docs/handoff/README.md` là đường dẫn gốc của gói).

Tài liệu này **không chép lại** `docs/handoff/`; nó chốt các quyết định kiến trúc, lấp chỗ trống, và ghi rõ **chỗ lệch** so với handoff kèm lý do (§14). Quyết định của chủ dự án nằm ở `docs/PLAN.md` §Quyết định.

Tên cũ Heo-Harness và persona "Bé Heo" không được dùng ở bất kỳ đâu trong mã, cấu hình hay dữ liệu, trừ mẫu agent hoài niệm "Bé Heo" **tắt mặc định** mà spec E13 và thiết kế (`agentTemplates`) giữ lại như một template tuỳ chọn.

---

## 1. Mục tiêu kiến trúc

Theo spec J: **(1) không sập → (2) dữ liệu không vỡ → (3) Console đủ để nghĩ → (4) plugin thêm được → (5) model thay được.** Kỹ thuật "đủ dùng".

Ràng buộc bắt buộc và nơi hiện thực:

| # | Ràng buộc | § |
|---|---|---|
| R1 | Luồng một chiều: Bridge → Kho thô (nguyên trạng) → Core agent sàng lọc → Kho sạch SSOT gắn ID nhóm + ID người + thời gian | 4 |
| R2 | Sàng lọc theo chu kỳ thời gian **HOẶC** ngưỡng số lượng, cả hai cấu hình được | 4.3 |
| R3 | Agent trực kênh quyết định từ ID nhóm, ID người, dữ liệu sạch liên quan, lịch sử tương quan, Sổ tay nhận thức | 5 |
| R4 | Mọi thành phần là plugin cắm rút nóng, cách ly lỗi, circuit breaker; plugin nền không gỡ được | 6 |
| R5 | Thang tự trị 0–6; ghi ra ngoài / vượt ngưỡng tiền / liên quan nhân sự → dừng ở Bàn làm việc | 7 |
| R6 | 5 vai trò theo ma trận quyền của thiết kế; dữ liệu đánh giá nhân sự khoá mức Owner | 8.3 |
| R7 | Mọi điểm số truy về bản ghi thô; không bịa; không tự quyết nhân sự | 9 |
| R8 | Mọi hành động của người và agent vào Action Log bất biến | 8.4 |
| R9 | MCP: agent chỉ gọi tool Owner đã mở; tool ghi phải qua duyệt | 10 |
| R10 | PIN 6 số; đăng nhập kênh bằng QR; đổi tài khoản Antigravity CLI; xoay vòng nhiều khoá API có failover | 8.2, 11 |

---

## 2. Stack

| Lớp | Lựa chọn | Lý do |
|---|---|---|
| Web | React 18 + TypeScript + Vite; React Router; TanStack Query (dữ liệu server); Zustand (trạng thái UI, đồng bộ vào URL); `@phosphor-icons/react` 2.1.1; font Inter tự host | Theo gợi ý + handoff 04. Token Nocturne xuất thành CSS custom properties trong **một** tệp (`packages/tokens`, sinh từ `tokens.json`), component chỉ tham chiếu biến. Không dùng thư viện UI có sẵn để tránh lệch thiết kế. |
| Hợp đồng API | OpenAPI tự sinh từ FastAPI → client TS (`openapi-typescript`) | Không viết tay kiểu dữ liệu ở frontend; đổi API là lỗi biên dịch, không phải lỗi runtime. |
| API | Python 3.12, FastAPI, Pydantic v2, SQLAlchemy 2 (async), Alembic | Theo gợi ý; tái dùng tư duy chassis Python repo cũ. |
| Worker | Cùng mã với api, tiến trình riêng; lịch + job bằng **arq** (Redis) | Tách tải nặng (sàng lọc, LLM, chấm điểm, nén sổ tay, làm mới MV, partman, backup) khỏi API. arq nhẹ, async-native, có cron. |
| CSDL | PostgreSQL 16 + pgvector + pg_partman + pg_trgm | SSOT duy nhất (spec G4). Khởi điểm là `docs/handoff/schema.sql`. |
| Bus & realtime | Redis 7: **Streams** cho event bus (consumer group, ack, phát lại), **pub/sub** cho đẩy realtime tới WebSocket, khoá phân tán, rate-limit, bộ đếm hạn mức | Streams bền: consumer chết không mất sự kiện (ưu tiên 2). |
| Bridge | Node 20 + TypeScript; Zalo `zca-js`, WhatsApp `@whiskeysockets/baileys`; mỗi kênh một adapter | Theo gợi ý; hai thư viện đã chạy trong `heo-harness/bridge`. Viết lại gọn, không mang persona/tên cũ. |
| Tệp | MinIO (S3-compatible) | Tài liệu, tệp đính kèm, lưu trữ lạnh Parquet, backup (handoff 03/04). |
| Proxy | Caddy 2 | TLS nội bộ tự ký `https://localhost:8443`, định tuyến `/` web, `/api` + `/ws` api. Chỉ proxy mở cổng ra host. |
| MCP | SDK MCP chính thức cho Python; máy chủ stdio chạy như sidecar khi Owner bật | §10 |
| Trình cài | Bootstrap `install.sh`/`install.ps1` + binary Go `genh` (Bubble Tea) | Handoff 05. Phát triển hằng ngày vẫn dùng `docker compose up`. |
| Test | pytest (+ testcontainers PG/Redis), Vitest + Testing Library, Playwright (luồng + so ảnh 1440/1280) | Định nghĩa "xong". |

---

## 3. Monorepo và dịch vụ

```
Gen-Harness/
├─ apps/
│  ├─ web/          React · Console + trình thiết lập Owner (/setup)
│  ├─ api/          FastAPI · REST /api/v1 + WebSocket /ws · auth, RBAC, policy, plugin manager
│  ├─ worker/       entrypoint worker (dùng lại package của api)
│  └─ bridge/       Node · adapters/zalo, adapters/whatsapp, streams, health
├─ packages/
│  ├─ ui/           component React theo Nocturne (Button, Tabs, Segmented, Table, KPI, Heatmap, GraphCanvas, PinDialog, EmptyState, ErrorState, Skeleton…)
│  ├─ tokens/       tokens.json → CSS variables + TS
│  └─ contracts/    OpenAPI → client TS
├─ plugins/         plugin nền và plugin mẫu (@gen/*), mỗi plugin một manifest.json
├─ db/              Alembic migrations + seed (từ design/seed-data.json)
├─ installer/       bootstrap/ + genh/ (Go)
├─ deploy/          compose.yaml · caddy/ · images/ (Dockerfile multi-stage)
└─ docs/            ARCHITECTURE.md · PLAN.md · spec · design/ · handoff/ · github.md
```

Dịch vụ compose (mạng `internal`, healthcheck từng dịch vụ, `api` chờ `db` + `redis` healthy):

| Dịch vụ | Vai trò |
|---|---|
| `proxy` | Caddy, cổng 8443 duy nhất ra host |
| `web` | bundle tĩnh (nginx-unprivileged) |
| `api` | REST + WS, auth, RBAC, policy, plugin manager, ingest consumer |
| `worker` | refinery, chấm điểm, agent trực kênh, compaction, MV, partman, backup |
| `bridge` | phiên kênh, QR, nhận/gửi |
| `db` | postgres:16 + pgvector + pg_partman |
| `redis` | streams, pub/sub, khoá, bộ đếm |
| `objects` | MinIO |
| `mcp-*` | sidecar máy chủ MCP stdio, chỉ khi Owner bật |

```
                 Console (web) ──HTTPS / WS──▶ proxy ──▶ api ◀──────────────┐
                                                        │  ▲                │
  Zalo/WhatsApp ⇄ bridge ──gh.bridge.inbound──▶ ingest ─┘  │ gh.* streams   │
                    ▲                              │ INSERT                  │
                    │                              ▼                         │
                    │      raw.events + refinery.event_state(pending) ─NOTIFY─▶ worker.refinery
                    │                                                        │
                    │               clean.* · memory.* · biz.* · analytics ◀─┘
                    │                                │
                    └── gh.bridge.outbound (permit) ◀── agent trực kênh ──▶ policy ──▶ biz.action_drafts (Bàn làm việc)
```

---

## 4. Luồng dữ liệu một chiều (R1, R2)

Luật cứng:
- Mỗi tầng chỉ **đọc** tầng trước và chỉ **ghi** tầng mình. Không tầng nào ghi ngược.
- `raw.events` và `ops.action_log` **chỉ INSERT** (trigger `core.forbid_mutation`). Trạng thái xử lý nằm ở `refinery.event_state`, tách khỏi `raw` để `raw` bất biến tuyệt đối.
- Mọi kết luận sạch có `clean.evidence` trỏ về `raw.events` → drill-down tới nguyên văn luôn được.
- Chạy lại quy tắc không xoá kết luận cũ: bản mới trỏ qua `superseded_by`.

### 4.1 Bridge
- Zalo (quyết định Q7): Owner quét QR do hệ thống sinh bằng **tài khoản Zalo thật**; bridge giữ phiên đăng nhập (mã hoá, `core.channel_sessions.credential_enc`), tự đăng nhập lại bằng phiên đã lưu khi khởi động, hết hạn mới xin QR mới, rồi bắt tin như `heo-harness/bridge/bot.js` (`zca-js` `loginQR`, `listener.on('message')`). WhatsApp tương tự với Baileys. Cảnh báo rủi ro khoá tài khoản cá nhân hiện trước QR.
- Mỗi tài khoản kênh là một phiên (`core.channel_sessions`: `pending_qr → active → expired | logged_out | error`). QR sinh trong bridge, đẩy qua `gh.bridge.status` → api → WebSocket → Console (khối QR 88px ở Điều khiển hệ thống, 240px ở trình thiết lập), đếm ngược 60s tự làm mới. Không in QR ra terminal hay ghi file như repo cũ.
- Tin vào/ra được đóng gói *envelope* `{channel, session_id, external_msg_id, external_group_id|null, sender_external_id, occurred_at, kind, body_text, payload (nguyên văn từ thư viện)}` rồi `XADD gh.bridge.inbound`. Bridge **không** gọi LLM, **không** quyết định trả lời (khác `bot.js` cũ tự gọi `/api/chat`).
- Gửi đi chỉ nhận từ `gh.bridge.outbound` và chỉ thực hiện khi lệnh mang **permit** hợp lệ (§7.3). Tin đã gửi quay lại `gh.bridge.inbound` như tin `outbound` → cũng vào kho thô và được sàng lọc (handoff 03).
- Đồng bộ danh sách nhóm/thành viên định kỳ → `gh.bridge.directory`.
- Heartbeat mỗi 15s → `core.channel_sessions.last_heartbeat_at`; mất heartbeat → plugin kênh `degraded`.
- Ranh giới `listen_authorized_only` (khoá, không tắt được): nhóm mới mặc định **Không nghe**. Tin của nhóm chưa bật bị bridge bỏ ngay, chỉ metadata nhóm được đồng bộ để Owner quyết định.

### 4.2 Ingest → Kho thô
Consumer `ingest` (trong api) đọc `gh.bridge.inbound`, trong **một transaction**: ánh xạ nhóm/người gửi (`core.groups`, `core.person_identities`, tạo mới nếu chưa có), `INSERT raw.events` (khử trùng `(channel_id, external_msg_id)` + `content_hash`), `INSERT refinery.event_state(state='pending')`, `NOTIFY raw_ingested`; rồi `XACK`. Đẩy dòng mới tới màn Kho dữ liệu thô qua WebSocket (mục tiêu ≤ 2 giây từ lúc tin đến — handoff 07).

### 4.3 Core agent sàng lọc (refinery) — chu kỳ HOẶC ngưỡng
- Cấu hình `refinery.schedule`: `interval_seconds` (mặc định 900), `count_threshold` (500), `batch_size` (250), `min_confidence` (0,60) — khớp `triggerConfig` của thiết kế. Chạy khi **điều kiện nào tới trước**.
- **Đường nhanh** (quyết định Q3): tin tag agent và tin 1-1 được sàng lọc ngay khi tới, một lô 1 bản ghi, cùng quy tắc, cùng `SKIP LOCKED` → agent trực kênh trả lời không phải chờ chu kỳ.
- Kích hoạt: cron arq kiểm chu kỳ; listener `LISTEN raw_ingested` đếm `pending` và enqueue khi đạt ngưỡng; nút "Chạy ngay" (manual); "Thử quy tắc" (test, không ghi).
- Lấy lô: `SELECT … FROM refinery.event_state WHERE state='pending' … FOR UPDATE SKIP LOCKED LIMIT batch_size` → nhiều worker song song an toàn, không trùng, không sót. Mỗi lượt ghi `refinery.runs`.
- Pipeline một lô:
  1. **Quy tắc tất định** theo `refinery.rules` + `rule_versions` (Khi → Thì). Nhiễu → `discarded` kèm rule id (giải thích được).
  2. **Trích xuất bằng LLM** (provider theo vai trò "tách ý định, phân loại"): ý định, thực thể, sự kiện có nghĩa (spec G3), phía cung/cầu, kết luận 1–2 câu, độ tin. Mỗi kết luận **bắt buộc** trích `raw_event_id` làm chứng cứ; bộ kiểm tra loại mọi kết luận trỏ tới ID không có trong lô (chống bịa, R7).
  3. `confidence ≥ min_confidence` → `clean.meaning_units` + `clean.evidence`, state `clean`; dưới ngưỡng → `lowconf` (chờ Sếp xem, thiết kế: "Tin cậy thấp").
  4. Embedding `vector(768)`; chấm điểm theo `refinery.scoring_weights` → `clean.score_snapshots` → `clean.current_scores`; cập nhật `clean.relationships`, `biz.market_signals`, `biz.opportunities`; ghi `memory.entries` cho sổ tay các ID liên quan.
  5. Phát `gh.clean.ready` cho agent trực kênh và plugin trí tuệ.
- Model chết: bước 1 vẫn chạy; tin còn `pending`, lượt sau thử lại; hệ thống không sập (spec M7).

### 4.4 Kho sạch SSOT
`clean.meaning_units` luôn có `group_id` (NULL = tin riêng), `person_id` (sau hợp nhất danh tính), `observed_at`. Mọi màn kinh doanh đọc từ `clean.*`, `biz.*`, `memory.*`, `analytics.*` — không màn nào quét `raw` lúc tải trang ngoài màn Kho dữ liệu thô. Plugin không giữ "sự thật riêng" (spec G4).

---

## 5. Agent trực kênh (R3)

Một **Agent Identity** (`agent.identities` + `agent.channel_scopes`) được gán vào kênh/nhóm với chế độ nghe (Chỉ khi được tag · Nghe im lặng · Chủ động bắt tín hiệu). Khi `gh.clean.ready` có đơn vị ý nghĩa trong phạm vi:

1. **Dựng ngữ cảnh** (tất định, có ghi lại):
   - danh tính agent: tên, vai trò, xưng hô, giọng, được nói khi, cấm, mức tự trị;
   - **ID nhóm** → hồ sơ nhóm, chế độ nghe, mức tự trị nhóm;
   - **ID người** → hồ sơ sống, `clean.current_scores` + lý do, người phụ trách;
   - **dữ liệu sạch liên quan**: tối đa N `meaning_units` theo cửa sổ thời gian + độ tương đồng pgvector, trong phạm vi được phép;
   - **lịch sử tương quan**: tương tác trước giữa người ↔ nhóm ↔ agent ↔ nhân viên, cơ hội/việc/lời hứa đang mở;
   - **Sổ tay nhận thức** của ID người và ID nhóm (gồm mục ghim).
2. **Quyết định** (LLM): `silent` · `note` (ghi sổ tay) · `suggest` · `draft` · `send`. Im lặng đúng lúc là năng lực (spec C3.3).
3. **Qua policy** (§7): `send`/`draft` thành hành động có cờ; chỉ tới bridge khi có permit.
4. **Ghi vết**: bảng bổ sung `agent.decisions` lưu quyết định + danh sách ID ngữ cảnh đã dùng → màn "Agent đã nói gì, nhân danh gì" và khối "Dữ liệu agent đã dùng — không có chỗ nào bịa" ở Bàn làm việc đọc từ đây. Action Log ghi mọi quyết định.

### 5.1 Sổ tay nhận thức
- `memory.notebooks` theo `(subject_type person|group, subject_id)`, `token_budget` (mặc định 4000), `token_used`, `compaction_no`.
- `memory.entries` theo mục thiết kế: Cần chú ý ngay · Ngữ cảnh lũy tiến · Giới hạn cho agent · Sở thích · Việc dở · Đã nén; mỗi mục có `refs` (ID bấm được), tác giả (agent/Sếp), `is_pinned`.
- **Lũy tiến**: refinery và agent thêm mục sau mỗi lượt.
- **Nén** khi `token_used ≥ 90% token_budget` hoặc mỗi 24 giờ: gộp mục không ghim thành tóm tắt, ghi `memory.compactions`, mục cũ đánh `archived_at` (vẫn truy được trong kho sạch — khối "Đã nén khỏi ngữ cảnh").
- **Owner**: ghim, sửa, xoá mục, nén ngay, đặt lại. Mọi thao tác vào Action Log; sửa giữ bản cũ.
- Redis giữ bản đệm sổ tay đang nóng để dựng ngữ cảnh nhanh; Postgres là nguồn thật.

---

## 6. Chassis và plugin (R4)

### 6.1 Manifest
`manifest.json`: `package` (`@gen/<tên>`), `version`, `layer` (chassis · channel · intelligence · provider · action · ui · extension), `entry`, `permissions[]`, `events.subscribe[]`, `events.publish[]`, `settings_schema` (JSON Schema → Console tự sinh form), `sandbox` (`memory_mb`, `timeout_s`, `net`), `dependencies` (package + version range), `removable`.

### 6.2 Plugin nền (origin=core, không gỡ được)
Khớp `plugRows`/`loadOrder` của thiết kế: `@gen/chassis-kernel` (Kernel & Plugin Manager) → `@gen/chassis-bus` → `@gen/chassis-store` → `@gen/chassis-policy` + `@gen/chassis-auth` → `@gen/intel-core` (Core Agent) → kênh Zalo/WhatsApp → plugin cài thêm. Nạp theo `load_order`, kiểm phụ thuộc trước khi nạp. API từ chối gỡ (409) và từ chối tắt nếu manifest không cho phép.

### 6.3 Vòng đời và cắm rút nóng
`installed → enabled ⇄ disabled → uninstalled`, sức khoẻ `healthy · degraded · isolated`. Bật/tắt/cài/gỡ không cần khởi động lại: lệnh qua `gh.plugin.control`, Plugin Manager ở api và worker gọi `on_enable/on_disable`, đăng ký/huỷ consumer của plugin. Trạng thái trong `ops.plugins` (không lưu JSON file như repo cũ).

### 6.4 Cách ly
- **Plugin nền** chạy trong tiến trình api/worker; mỗi handler chạy trong task riêng có timeout, bắt ngoại lệ (tư duy `safe_execute` của repo cũ).
- **Plugin cài thêm** (`marketplace | local_file`) chạy trong **tiến trình con** (hoặc container riêng theo `sandbox.mode`), giới hạn RAM/timeout/mạng, chỉ giao tiếp qua Redis Streams. Cài: kiểm chữ ký, hiện danh sách quyền xin, yêu cầu PIN.
- **Circuit breaker** mỗi plugin (và mỗi provider/khoá API): mở khi tỉ lệ lỗi vượt ngưỡng trong cửa sổ → `isolated`, sự kiện của nó dồn trong stream, không mất; hết thời gian nghỉ → nửa mở thử 1 sự kiện → đóng nếu thành công. Ghi `ops.breaker_events`, phát `gh.plugin.health`, hiện "lỗi đã cách ly" ở Tổng quan.

### 6.5 Stream chính
| Stream | Hướng | Nội dung |
|---|---|---|
| `gh.bridge.inbound` | bridge → ingest | envelope tin vào/ra |
| `gh.bridge.outbound` | api/worker → bridge | lệnh gửi + permit |
| `gh.bridge.status` / `gh.bridge.directory` | bridge → api/worker | QR, phiên, heartbeat / nhóm, thành viên |
| `gh.clean.ready` | refinery → agent, plugin | ID đơn vị ý nghĩa mới |
| `gh.action.requested` / `gh.action.decided` | agent/người ↔ policy → executor | hành động và quyết định |
| `gh.plugin.control` / `gh.plugin.health` | api ↔ plugin manager | điều khiển, sức khoẻ |

Mọi message có `event_id` (UUIDv7), `org_id`, `correlation_id`, `actor`, `occurred_at`, `schema_version`.

---

## 7. Tự trị, chính sách, Bàn làm việc (R5)

### 7.1 Thang 0–6 (spec H1, `autonomySteps`)
0 Chỉ ghi nhận · 1 Tóm tắt · 2 Chấm điểm + giải thích · 3 Gợi ý hành động · 4 Soạn sẵn chờ duyệt · 5 Tự làm việc thấp rủi ro · 6 Tự làm việc đã whitelist.
Mặc định **4** (thiết kế: pill header "tự trị 4", trình thiết lập bước 9; spec cho phép 3 hoặc 4).
Mức hiệu lực = **mức thấp nhất** trong các lớp: tổ chức → kênh → nhóm → người → loại việc → agent identity. Lớp dưới không nới được quyền lớp trên.

### 7.2 Luật cứng
Hành động **bắt buộc dừng ở Bàn làm việc** (`biz.action_drafts`, `hold_reason` ghi lý do) nếu có bất kỳ cờ nào:
- `writes_external`: gửi tin, ghi CRM/ERP, tool MCP loại ghi, gửi tài liệu ra ngoài;
- `amount_vnd > approval_threshold_vnd` (mặc định 50.000.000 ₫, `ops.policy_boundaries`);
- `personnel_related`: đánh giá/quyết định về nhân viên, ứng viên, học viên.

Cờ gắn ở **registry loại hành động** do chassis quản, không do LLM tự khai → model không tự hạ cờ, không tự cấp quyền. Luật này áp ở **mọi** mức tự trị (quyết định Q2): mức 5–6 chỉ tự làm việc nội bộ (tạo việc, nhắc, ghi chú, gắn nhãn, ghi sổ tay); mọi tin gửi ra ngoài đều chờ duyệt. Ngưỡng tiền do Owner đặt.

### 7.3 Luồng
`requested` → policy → `auto` (cấp permit, thực thi) | `held` (vào Bàn làm việc) | `blocked`.
Bàn làm việc: Duyệt và gửi · Sửa rồi gửi · Huỷ → `approved | edited | rejected` → executor thực thi với permit → `sent | failed`. Permit: dùng một lần, hạn 5 phút, ký HMAC gồm `draft_id + hash(body) + channel/tool`; bridge và MCP executor kiểm trước khi làm. Duyệt/huỷ đòi PIN nếu phiên PIN hết hạn. Tất cả vào Action Log.

### 7.4 Giới hạn mặc định (quyết định của chủ dự án)
**Mặc định mở hết, trừ quyền nguy hiểm nghiêm trọng.** Mọi giới hạn khác là cài đặt Owner tự bật/tắt (PIN + log).

Khoá cứng, không tắt được bằng cài đặt:
1. Chỉ lắng nghe nhóm Owner đã bật (`listen_authorized_only`).
2. Hệ thống không tự ra quyết định nhân sự.
3. Gửi ra ngoài, vượt ngưỡng tiền, liên quan nhân sự → chờ duyệt (ngưỡng tiền Owner đặt).
4. MCP: tool ghi qua duyệt; agent chỉ gọi tool Owner đã mở.
5. Kho thô và Action Log chỉ INSERT.
6. PIN cho thao tác nhạy cảm; bí mật mã hoá.
7. Điểm số, cảnh báo nhân sự phải có chứng cứ.
8. Ẩn dữ liệu nhạy cảm (số tài khoản, sức khoẻ, đời tư) khỏi vai trò dưới Owner.

Còn lại mặc định **mở** khi cài mới (ví dụ: quan sát nhóm thị trường bên ngoài, cho máy chủ MCP gọi ra mạng ngoài, giới hạn tốc độ, hạn mức model, giới hạn tài nguyên plugin) và Owner đổi được trong Điều khiển hệ thống. Riêng chế độ "Dùng dữ liệu mẫu" nạp đúng trạng thái như thiết kế để màn hình khớp.

---

## 8. Bảo mật (R6, R8, R10)

### 8.1 Đăng nhập
Mật khẩu argon2id (≥12 ký tự), TOTP tuỳ chọn. Phiên là token ngẫu nhiên trong cookie `HttpOnly; Secure; SameSite=Strict`, lưu băm ở `core.sessions` (thu hồi được). CSRF token cho request ghi; `Idempotency-Key` cho mọi endpoint ghi. Owner đầu tiên tạo qua trình thiết lập bằng **mã thiết lập một lần** do trình cài sinh — không có tài khoản mặc định.

### 8.2 PIN 6 số (theo `pinRules` của thiết kế)
- PIN riêng mỗi người, argon2id. Nhập đúng mở **phiên PIN 30 phút** (`core.sessions.pin_verified_until`), gia hạn khi có thao tác.
- Thao tác cần PIN: đăng xuất/đăng nhập kênh, đổi tài khoản Antigravity CLI, cài/gỡ plugin, đổi quyền, xem khoá API, gộp/tách danh tính, duyệt/huỷ ở Bàn làm việc, mở tool MCP, đổi ngưỡng tự trị/tiền, xuất/xoá dữ liệu, xem dữ liệu đánh giá nhân sự. Danh mục nằm trong code (một chỗ), backend kiểm; thiếu/hết hạn trả **`423 PIN_REQUIRED`** → UI bật PinDialog.
- Sai 5 lần → khoá Console 15 phút và báo Owner qua kênh riêng (Zalo của Sếp). Đây là thông báo bảo mật của hệ thống tới chính tài khoản Owner, không phải hành động của agent. Mọi lần nhập, kể cả sai, vào Action Log.

### 8.3 RBAC
- Vai trò: Owner · Manager · Operator · Agent nhân viên · Auditor. Trong code vai trò người là `agent_staff` để không nhầm với Agent Identity (bot).
- Ma trận thiết kế (`permCols` × `permRows`): 7 cột Tổng quan · Hàng đợi · Hồ sơ khách · Đánh giá nhân sự · Cơ hội · Hành động · Nhật ký; ô ✓ toàn quyền / – có giới hạn / ✕ không. Lưu ở `core.role_permissions(scope = all | team | assigned | none)`. Ý nghĩa cụ thể của "có giới hạn" cho từng ô được định nghĩa ở PLAN §1.5 và test hoá.
- Hai tầng, đều ở backend, **ở tầng service** (không chỉ route):
  1. quyền chức năng — `require(permission)`;
  2. phạm vi dữ liệu — mọi truy vấn qua `ScopeFilter(user)`: Manager = team mình; Operator = hàng đợi được giao; Agent nhân viên = khách được phân; Auditor = đọc, không có quyền ghi nào.
- Đánh giá nhân sự: khoá mức Owner (yêu cầu của dự án, chip "Dữ liệu khoá ở cấp Owner", guard MCP "Dữ liệu nhân sự chỉ ở mức Owner"). Mặc định (quyết định Q4): chỉ Owner thấy nội dung; Auditor thấy nhật ký ai đã xem; Manager không thấy. Owner có thể tự cấp thêm cho vai trò khác trong Quyền hạn (PIN + log). Mọi lần xem vào Action Log.
- Ranh giới "Ẩn dữ liệu nhạy cảm khỏi mọi vai trò dưới Owner" áp ở serializer (trường được gắn nhãn nhạy cảm bị che).
- Row-Level Security Postgres bật ở giai đoạn hoàn thiện như lớp phòng thủ thứ hai (handoff 03).

### 8.4 Action Log
`ops.action_log` phân vùng tháng, chỉ INSERT, `row_hash = sha256(prev_hash || nội dung chuẩn hoá)`. Ghi qua **một** service duy nhất; middleware ghi mọi request ghi, worker ghi mọi hành động agent/plugin/hệ thống. Job hằng đêm kiểm chuỗi, đứt → đẩy cảnh báo vào hàng đợi. Test quét route bảo đảm không đường ghi nào bỏ qua log.

### 8.5 Bí mật
Mã hoá phong bì AES-256-GCM cho khoá API, phiên kênh, TOTP, auth MCP (`bytea`). Khoá master ở Docker secret `gh_master_key` do trình cài sinh; không ở DB, repo, image hay log. API chỉ trả `last4`; "hiện khoá" cần PIN và vào log.

---

## 9. Điểm số, chứng cứ, danh tính (R7)

- `clean.score_snapshots` (không ghi đè, giữ lịch sử để vẽ xu hướng) + `clean.current_scores` (bộ đệm đọc). Mỗi snapshot có thành phần theo trọng số, độ tin, phương pháp (quy tắc/model/tay) và chứng cứ (meaning units → `clean.evidence` → `raw.events`).
- **Không chứng cứ thì không có điểm**: service từ chối lưu điểm không có evidence. Độ tin thấp hiển thị nhãn và tính vào chỉ số "% điểm số có độ tin thấp" (spec F4).
- Sửa tay tạo snapshot mới `method=manual` + lý do.
- `GET /api/v1/explain/{kind}/{id}` trả chuỗi điểm → đơn vị ý nghĩa → trích dẫn → bản ghi thô (nút "Vì sao hệ thống nghĩ vậy" / "Xem chứng cứ gốc" ở mọi màn).
- **Ranh giới nhân sự**: hệ thống chỉ sinh tín hiệu + khuyến nghị coaching. Không có loại hành động kỷ luật tự động (ranh giới khoá "Tự động ra quyết định nhân sự" = tắt). Cảnh báo nhân sự không có chứng cứ không được hiện. Có luồng **Phản biện** (`biz.review_disputes`, spec I).
- **Hợp nhất danh tính** (spec G2): `core.identity_merge_candidates` (điểm khớp % + cơ sở: số điện thoại, tên chuẩn hoá, đồng xuất hiện nhóm, tự giới thiệu), gộp/tách tay có PIN, `core.identity_merge_log`, đảo ngược được; gộp thì hồ sơ sống, sổ tay và lịch sử gộp theo; không xoá cứng (`merged_into_id`).

---

## 10. MCP Hub (R9)
- `agent.mcp_servers` (stdio | http+sse | streamable_http, breaker riêng), `agent.mcp_tools` (`access read|write`, `is_exposed` **mặc định false**), `agent.mcp_grants` (tool × agent), `agent.mcp_calls` (nhật ký LIVE).
- Chỉ Owner (PIN) mở tool và cấp cho agent. Agent chỉ thấy tool đã mở + được cấp; gọi tool chưa mở → chặn, ghi log (kết quả "Bị chặn").
- Tool `write` luôn tạo `biz.action_drafts(kind='mcp_write')` trước (guard khoá). Tool `read` chạy ngay nếu mức tự trị cho phép, vẫn ghi log.
- Mặc định chặn mạng công cộng cho máy chủ MCP (guard "Cho phép máy chủ MCP ngoài mạng nội bộ" = tắt).
- Quyền tệp/nhóm áp cả qua MCP: tham số gọi được lọc theo phạm vi của agent.

---

## 11. Model, khoá API, Antigravity CLI (R10)

- Provider plugin: `antigravity_cli`, `gemini`, `deepseek`, `openai_compat`, `embedding` (`agent.providers`). Giao diện chung `generate(messages, schema?, tools?)` và `embed(texts)`.
- **Gán model theo vai trò/agent** (`agent.bindings`): core agent suy luận chính, trả lời nhanh trong nhóm, tách ý định/phân loại, chấm điểm suy luận dài, đánh chỉ mục (khớp `models`, `agentBindings`).
- **Xoay vòng khoá**: `agent.provider_keys.rotation_order`; chọn khoá còn hạn mức, không trong cooldown. 429/hết hạn mức → cooldown khoá đó, sang khoá kế.
- **Hạn mức theo model**: `agent.models.daily_quota`, `rate_limit_per_min`; bộ đếm nóng ở Redis, chốt vào `agent.model_calls` (phân vùng tháng) → `analytics.mv_model_usage_daily`.
- **Chuỗi chuyển hướng** (`failoverRules` thiết kế): hết hạn mức → nhà cung cấp kế tiếp; ngắt mạch → giữ nguyên hội thoại, thử lại sau 60s; hết chuỗi → xếp hàng và báo Sếp qua hàng đợi; còn < 20% hạn mức → cảnh báo.
- **Antigravity CLI** (quyết định Q6: bản cài chính hãng, đăng nhập/đổi tài khoản như heo-harness):
  - Image `worker` cài **binary `agy` chính hãng** của Google lúc build (nguồn tải + checksum ghim trong Dockerfile), không đóng gói lại.
  - Như heo-harness: CLI lưu phiên đăng nhập ở tệp OAuth `~/.gemini/antigravity-cli/antigravity-oauth-token`; email tài khoản đọc từ `id_token` trong tệp đó; đăng xuất = xoá tệp.
  - **Đăng nhập**: Console bấm Đăng nhập → worker chạy luồng đăng nhập của chính CLI trong container, chuyển link/mã xác thực lên Console qua WebSocket; xong thì tệp token được đọc, **mã hoá** và lưu vào `agent.cli_profiles` (email, gói, hạn).
  - **Đổi tài khoản**: nhiều hồ sơ trong `agent.cli_profiles`, một hồ sơ hoạt động; chuyển hồ sơ = ghi tệp token của hồ sơ đó vào thư mục cấu hình CLI trong volume rồi khởi động lại phiên CLI. Cần PIN, vào Action Log.
  - Hết hạn/lỗi → provider `expired`, chuỗi chuyển hướng sang khoá API kế tiếp.

---

## 12. Mô hình dữ liệu

Khởi điểm: `docs/handoff/schema.sql` (9 schema: `core, raw, refinery, clean, memory, biz, agent, ops, analytics`), giữ nguyên mọi quy ước của `docs/handoff/03-database.md`: khoá UUIDv7 (`core.uuid_v7()`), mã công khai ở cột `code` (`GRP-ZL-0114`, `PER-0042`, `OPP-1842`, `ACT-0231`…), mọi bảng có `org_id`, `timestamptz` UTC hiển thị theo `organizations.timezone`, tiền `bigint` đồng, `core.lookup` thay ENUM, `attrs jsonb`, xoá mềm/`merged_into_id`, phân vùng tháng bằng pg_partman, lớp `analytics` materialized view làm mới `CONCURRENTLY`.

Thực thể spec G1 → bảng:

| Spec G1 | Bảng |
|---|---|
| Identity / Channel Account | `core.persons` / `core.person_identities` |
| Organization | `core.organizations` (tổ chức sử dụng) + tổ chức của đối tượng trong `attrs` của person |
| Group / Space | `core.groups`, `core.group_members` |
| Relationship | `clean.relationships` |
| Conversation Thread | nhóm/tin riêng qua `raw.events.group_id` + `clean.meaning_units` |
| Message / Event | `raw.events` / `clean.meaning_units` |
| Intent | `clean.meaning_units.event_type` + `core.lookup(kind='intent')` |
| Opportunity | `biz.opportunities`, `biz.opportunity_stage_history`, `biz.market_signals`, `biz.matches` |
| Deal / Case | `biz.deals`, `biz.cases` |
| Document | `biz.documents`, `biz.document_acl` |
| Task / Reminder | `biz.tasks`, `biz.promises` |
| Evaluation Snapshot | `clean.score_snapshots`, `biz.people_reviews`, `biz.review_disputes` |
| Alert | hàng đợi ý nghĩa — xem bổ sung dưới |
| Action Log | `ops.action_log` |
| Plugin / Connector State | `ops.plugins`, `ops.plugin_dependencies`, `ops.breaker_events`, `ops.plugin_logs` |

**Bổ sung dự kiến** (migration riêng, giữ quy ước):
| Bảng | Lý do |
|---|---|
| `agent.decisions` | Lưu quyết định của agent trực kênh + ID ngữ cảnh đã dùng (§5). |
| `biz.alerts` | Spec E9 yêu cầu cảnh báo có mức ưu tiên, người nhận, hành động đề xuất; schema chưa có bảng riêng. Hộp thư ý nghĩa hợp nhất `meaning_units` + `alerts` + `action_drafts` + `tasks` thành một hàng đợi. |
| `biz.inbox_items` (view) | Hàng đợi hợp nhất cho Hộp thư ý nghĩa và khối Hàng đợi ở Tổng quan. |
| cột `permit_hash`, `permit_expires_at` ở `biz.action_drafts` | Permit dùng một lần (§7.3). |
| `agent.cli_profiles` | Nhiều tài khoản Antigravity CLI, một hồ sơ hoạt động (§11). |
| `core.assignments` | Khách được phân cho Agent nhân viên, hàng đợi cho Operator (phạm vi `assigned`). |

---

## 13. API

REST JSON `/api/v1`, OpenAPI tự sinh; phân trang con trỏ `?cursor=&limit=`; lọc/sắp xếp qua query phản ánh vào URL; lỗi RFC 7807; `Idempotency-Key` cho ghi; 🔒 = cần phiên PIN (423 khi thiếu). WebSocket `/ws`: hàng đợi, tin thô LIVE, tiến độ refinery, trạng thái phiên QR, log plugin LIVE, nhật ký MCP LIVE, tiến độ thiết lập. Mọi route có `require(permission)` + `ScopeFilter`.

| Nhóm | Endpoint | Màn |
|---|---|---|
| Auth | `POST /auth/login` · `POST /auth/logout` · `GET /auth/me` · `POST /auth/pin/verify` · `PUT /auth/pin` 🔒 · `POST /auth/totp` | đăng nhập, PinDialog |
| Thiết lập | `GET /setup/state` · `PUT /setup/steps/{n}` · `POST /setup/seed` · `POST /setup/finish` | `/setup` |
| Khung | `GET /navigation` (cây từ `screens.json`, lọc theo quyền, kèm badge) · `GET /header` (kênh/nhóm LIVE, tự trị, độ tin dữ liệu) · `GET/POST/DELETE /views` | shell |
| Tổng quan | `GET /overview` (kpis, queue, spotlight, signals, health, dataQuality, hourly + KPI F4) | overview |
| Hộp thư | `GET /inbox?tab=` · `GET /inbox/{id}` · `POST /inbox/{id}/act` · `POST /inbox/{id}/assign` · `POST /inbox/{id}/silence` | inbox |
| Bàn làm việc | `GET /drafts` · `GET /drafts/{id}` · `POST /drafts/{id}/approve` 🔒 · `POST /drafts/{id}/edit-send` 🔒 · `POST /drafts/{id}/reject` 🔒 · `POST /drafts/{id}/translate` · `POST /drafts/{id}/regenerate` | workbench |
| Nhóm & Con người | `GET /groups?channel=` · `GET /groups/{id}` · `PATCH /groups/{id}` (chế độ nghe 🔒, BOT) · `GET /persons?filters` · `PUT /persons/{id}/bot` | directory |
| Bản đồ | `GET /graph?mode=list|people|groups|topics&filters` · `PUT /graph/layout` | graph |
| Hồ sơ sống | `GET /profiles/{id}` · `GET /profiles/{id}/timeline` · `PUT /profiles/{id}/autonomy` · `PUT /profiles/{id}/owner` · `GET/POST /profiles/{id}/notes` | profile |
| Sổ tay | `GET /notebooks?type=person|group` · `GET /notebooks/{type}/{id}` · `PATCH /notebooks/entries/{id}` (sửa/ghim) · `DELETE /notebooks/entries/{id}` · `POST /notebooks/{type}/{id}/compact` · `POST /notebooks/{type}/{id}/reset` 🔒 | notebook |
| Cơ hội | `GET /opportunities` · `PATCH /opportunities/{id}/stage` · `PATCH /opportunities/{id}` | opportunity |
| Cung ↔ Cầu | `GET /market` · `GET /market/matches` · `POST /market/matches/{id}/introduce` (tạo bản nháp) · `POST /market/signals/{id}/act` | supply |
| Kho hội thoại | `GET /search?q=&facets` · `GET /search/saved` · `GET /search/patterns` · `POST /search/bulk-action` (qua duyệt) | search |
| Đánh giá | `GET /reviews?board=staff|customer|candidate|learner` 🔒 · `GET /reviews/{id}/evidence` 🔒 · `POST /reviews/{id}/override` 🔒 · `POST /reviews/{id}/disputes` | people |
| Chăm sóc | `GET /care/kpis` · `GET /care/response-grid` · `GET /care/patterns` · `GET /care/scripts` | care |
| Chứng cứ | `GET /explain/{kind}/{id}` · `GET /raw/{id}` | mọi màn |
| Kho thô | `GET /raw?filters` · `GET /raw/by-group` · `GET/PUT /refinery/schedule` · `POST /refinery/run` · `GET /refinery/runs` | raw |
| Quy tắc | `GET /rules` · `POST /rules` · `PUT /rules/{id}` (tạo phiên bản) · `PATCH /rules/{id}/toggle` · `GET/PUT /rules/weights` · `POST /rules/test` | rules |
| Kho sạch | `GET /clean?filters` · `GET /clean/{id}/memory` · `GET /clean/agent-params` | clean |
| Danh tính | `GET /identity/stats` · `GET /identity/candidates` · `POST /identity/merge` 🔒 · `POST /identity/{id}/split` 🔒 · `POST /identity/candidates/{id}/reject` · `GET /identity/{id}/history` | identity |
| Agent | `GET/POST /agents` · `PATCH /agents/{id}` · `POST /agents/{id}/clone` · `PATCH /agents/{id}/toggle` · `GET /agents/log` · `GET /agents/templates` · `POST /agents/{id}/try` | agents |
| Provider & model | `GET/POST /providers` · `PATCH /providers/{id}` · `POST /providers/{id}/test` · `POST /providers/{id}/keys` 🔒 · `GET /providers/keys/{id}/reveal` 🔒 · `GET /models` (hạn mức) · `PUT /models/bindings` · `PUT /models/failover-chain` · `GET/PUT /models/core-params` · `GET/PUT /models/rate-limits` · `GET /cli/profiles` · `POST /cli/profiles/{id}/login` · `POST /cli/profiles/{id}/activate` 🔒 | api, system › Bộ não AI |
| MCP | `GET /mcp/stats` · `GET /mcp/servers` · `POST /mcp/servers` 🔒 · `PATCH /mcp/servers/{id}` 🔒 · `PATCH /mcp/tools/{id}` (mở/đóng) 🔒 · `PUT /mcp/tools/{id}/grants` 🔒 · `GET /mcp/calls` · `GET /mcp/guards` · `GET /mcp/market` | mcp |
| Plugin | `GET /plugins?tab=core|addon` · `GET /plugins/load-order` · `GET /plugins/events` · `POST /plugins/install` 🔒 · `PATCH /plugins/{id}/toggle` · `DELETE /plugins/{id}` 🔒 · `PUT /plugins/{id}/settings` · `POST /plugins/{id}/breaker/reset` · `GET /plugins/market` | plugins |
| Kênh | `GET /channels` · `POST /channels/{id}/sessions` (tạo QR) · `POST /channels/sessions/{id}/logout` 🔒 · `POST /channels/sessions/{id}/rescan` | system › Kênh & đăng nhập |
| Quyền | `GET /roles/matrix` · `PUT /roles/matrix` 🔒 · `GET/POST /users` · `PATCH /users/{id}` 🔒 · `POST /users/invite` | system › Quyền hạn |
| Chính sách | `GET/PUT /policy/boundaries` 🔒 · `GET/PUT /policy/autonomy` 🔒 · `GET/PUT /policy/listen-groups` 🔒 | system |
| Nhật ký | `GET /audit?filters` · `GET /audit/export.csv` · `GET /audit/verify` | system › Nhật ký |
| Dữ liệu | `GET/PUT /data/retention` 🔒 · `POST /data/requests` 🔒 · `DELETE /data/sample` 🔒 · `POST /data/backup` 🔒 | system › Dữ liệu & lưu trữ |
| Vận hành | `GET /health` · `GET /ready` | trình cài, `genh status` |

---

## 14. Chỗ lệch so với handoff và lý do

| # | Handoff | Ở đây | Lý do |
|---|---|---|---|
| D1 | Bridge `INSERT` thẳng `raw.events` (03, 04) | Bridge đẩy vào event bus `gh.bridge.inbound`, consumer `ingest` INSERT | Yêu cầu của dự án ghi rõ "đẩy sự kiện vào kho thô qua event bus". Thêm lợi ích: bridge không cần quyền DB (ít quyền nhất), tin được đệm trong stream khi DB tạm chết. Kho thô vẫn là điểm lưu bền đầu tiên, nguyên trạng. |
| D2 | Không nêu bảng cảnh báo, quyết định agent, permit, hồ sơ CLI, phân công | Thêm theo §12 | Spec E9, E13 ("agent nào đã nói gì, nhân danh gì"), R5, R10, H2 cần chúng. |
| D3 | 6 giai đoạn (có trình cài `genh`, trình thiết lập Owner 12 bước) | Gộp vào kế hoạch 5 + 1 giai đoạn của PLAN.md | Tin nhắn giao việc của dự án có 5 giai đoạn, không nhắc trình cài. Chủ dự án đã duyệt cách gộp (Q1). |

Không có chỗ lệch nào về giao diện.
