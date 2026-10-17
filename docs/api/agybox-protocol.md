# Hộp riêng Antigravity (`agy-box`) — hợp đồng gọi (v0.1.63, gói H1)

Mục đích: các việc có người ngoài (soạn trả lời khách, sàng lọc tin người lạ) chạy `agy` trong container riêng, không có khoá
master, DB hay Redis chính. Mã: `apps/api/gh/agybox/` (`protocol.py` hợp đồng + ký, `server.py` dịch vụ, `client.py` phía api/worker).
Cấu hình: `deploy/compose.yaml` (dịch vụ `agy-box`, mạng `agy-bus` nội bộ + `agy-out`, secret `gh_agy_key`).

## Cho H2 (router/placement) dùng

```python
from gh.agybox.client import AgyBoxClient, box_status, BoxUnavailable, BoxUnauthorized

client = AgyBoxClient.from_env(timeout=240)   # None nếu hộp chưa cài (thiếu GH_AGYBOX_URL / tệp khoá)
# hoặc AgyBoxClient("http://agy-box:8090", "/run/secrets/gh_agy_key", 240)
await client.generate(model, messages, json_mode=..., temperature=..., effort=None)  # -> Completion
await client.discover_models()   # -> list[dict]; client.last_models_raw (đã che)
await client.list_models()       # -> list[str]
await client.diagnose(model, effort, prompt)   # chỉ trạng thái hộp + `agy models`, KHÔNG gọi thử lượt
client.kind == "antigravity_cli"; client.embed(...) -> BadRequest

st = await box_status()          # cache 10 giây; không tham số = đọc GH_AGYBOX_URL / GH_AGYBOX_KEY_FILE
# {"state": "ok"|"down"|"not_installed", "checked_at": "…Z", "agy_version": "1.2.9"|None, "cli_logged_in": bool|None}
```

- `not_installed`: chưa cấu hình URL/khoá (dev, bản cài cũ trước `genh update`). `down`: đã cấu hình mà `/healthz` không trả lời.
- `timeout` của client = thời gian tối đa agy được chạy (gửi sang hộp thành `timeout_s`); client chờ thêm 10 giây cho hộp kịp báo lỗi.
- Ngoại lệ (đều là `ProviderError`): `BoxUnavailable` (không nối được), `BoxUnauthorized` (sai khoá `gh_agy_key` hoặc đồng hồ lệch
  quá 60 giây — KHÔNG phải `AuthFailed`, đừng đánh dấu phiên agy hết hạn), `AuthFailed` (agy chưa đăng nhập trong hộp),
  `RateLimited` (hết hạn mức, hoặc hộp bận: `retry_after` = 5 giây), `ModelRejected`, `BadRequest` (prompt > 120 000 byte, tên model sai),
  `ProviderError` thường (lỗi agy, quá giờ — "CLI quá Ns").
- Hộp tắt ⇒ vai ngoại giao KHÔNG rơi về `AgyClient` trong tiến trình (quyết định của H2). Prompt phải qua `mask_for_model` trước khi gọi.

### Vai nào qua hộp (gói H2 — `gh/providers/placement.py` + `gh/providers/agy_policy.py`)

| Vai | Nơi chạy agy |
|---|---|
| `core.gen` của Owner, `core.briefing`, `agent:<id>` nội bộ (không gắn kênh / nhóm / người) | trong tiến trình (`AgyClient`) |
| `core.reply`, `core.refinery`, `agent:<id>` ngoại giao (có `channel_scopes` / BOT nhóm / BOT người), `core.gen` của nhân viên, lượt thử agent (`purpose="setup_agent_try"`), khoá lạ | qua hộp (`AgyBoxClient`) |

- Một điểm quyết định: `agy_policy.decide(role, owner=, diplomatic=, box=, purpose=)` = `placement.placement(...)` ⊕ `box_status()["state"]`;
  bên gọi có DB dùng `verdict_for` / `verdicts_for`. `AgyVerdict{allowed, where, code, reason}`.
- Hộp `down` / `not_installed` ⇒ lượt thuộc vai qua hộp bỏ Antigravity khỏi chuỗi, dùng nguồn AI kế, lý do tiếng Việt vào `reasons`
  (`REASON_BOX_DOWN`, `REASON_BOX_NOT_INSTALLED`); không bao giờ tạo `AgyClient` trong tiến trình thay cho hộp. Lỗi hộp có ngắt mạch RIÊNG
  (`breaker_key(id, "box")`) và không đổi `auth_state` của nguồn agy.
- Cho gói B2 (readiness `box_down`): `placement.box_required(role, agent=None, *, owner=True, purpose=None) -> bool`
  (`agent`: `AgentRef(diplomatic=…)` hoặc `bool`); vai có `box_required` mà `box_status()["state"] != "ok"` ⇒ `box_down`.

## Giao thức HTTP (`http://agy-box:8090`)

| Đường | Ký | Yêu cầu | Trả lời 200 |
|---|---|---|---|
| `GET /healthz` | không | — | `{ok, service:"agy-box", protocol:1, agy_version, cli_logged_in}` |
| `POST /v1/generate` | có | `{request_id, model, effort\|null, prompt, json_mode, timeout_s}` | `{request_id, text, tokens_in, tokens_out, raw}` |
| `POST /v1/models` | có | `{request_id, timeout_s?}` | `{request_id, models:[{id,…}], raw_text}` |

- `request_id`: `[A-Za-z0-9_-]{1,64}`. `timeout_s`: 1–600 (mặc định 300; models 60). Prompt ghép như `AgyClient` (`[role]\n…`).
- **Ký**: header `X-GH-Ts` (giây UNIX) và `X-GH-Sig` = hex HMAC-SHA256 bằng subkey `sha256(gh_agy_key ‖ "gh-agybox:" ‖ "request")`
  trên `"gh-agybox-v1\n" + METHOD + "\n" + PATH + "\n" + TS + "\n" + thân`. Lệch giờ > 60 giây, thiếu/sai chữ ký, hoặc dùng lại đúng
  chữ ký ⇒ `401`. Trả lời đã xác thực mang `X-GH-Sig` (subkey `"response"`, trên `chữ-ký-yêu-cầu + "\n" + status + "\n" + thân`);
  client bỏ trả lời sai chữ ký. `401` không ký.
- **Lỗi**: `{"error": {"code", "message", …}, "request_id"?}`. Mã → HTTP: `bad_request` 400 · `model_rejected` 400 (+`what`, `available`, `raw`) ·
  `unauthorized` 401 · `cli_auth_failed` 403 · `not_found` 404 · `method_not_allowed` 405 · `too_large` 413 (thân > 1 MiB hoặc prompt > 120 000 byte) ·
  `rate_limited` 429 (+`retry_after`) · `busy` 429 (+`retry_after`; quá `GH_AGYBOX_MAX_JOBS` lượt đồng thời) · `internal` 500 ·
  `provider_error` 502 · `timeout` 504. Thông điệp lỗi đã che bí mật.
- Hộp KHÔNG gọi ngược api; kết quả là văn bản không tin cậy (parse như đầu ra agy trực tiếp).

## Cô lập (tóm tắt) và cách kiểm

- Hộp chỉ có: secret `gh_agy_key`, volume `agy_state` (token OAuth agy), env `GH_AGYBOX_KEY_FILE`, `GH_CLI_HOME`, `GH_CLI_BINARY`,
  `AGY_CLI_DISABLE_AUTO_UPDATE`, `GH_AGYBOX_MAX_JOBS`. `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, uid `gh`, không `default`/`browser-bus`.
  Tiến trình hộp tự xoá mọi biến `GH_*` ngoài danh sách và không import `gh.config`/DB/Redis/crypto.
- Test: `apps/api/tests/test_agybox_v0163.py` (giao thức, server, client, sức khoẻ), `test_agybox_compose_v0163.py` (YAML cô lập).
- Kiểm thật (project riêng, không đụng bản cài): dựng `docker compose -p <tên riêng> -f deploy/compose.yaml up -d --no-deps agy-box`
  sau khi mồi volume `agy_state` bằng một container tạm mount thường (giống api chép ảnh trước); trong hộp `ls /run/secrets` chỉ
  thấy `gh_agy_key`, `env` không có biến DB/Redis/khoá, ghi `/app` bị từ chối, `CapEff=0`, `NoNewPrivs=1`, không phân giải `db`/`redis`/`api`,
  không nối được IP của container ở mạng khác; một container tạm ở `agy-bus` gọi được hộp với HMAC đúng và nhận `401` khi sai khoá, lệch giờ, phát lại.

## Nợ / ghi chú vận hành

- Lối ra `agy-out` hiện KHÔNG có allowlist tên miền. Đã đo (agy 1.2.9, token giả, mạng chỉ có proxy ghi CONNECT): agy **có** theo
  `HTTPS_PROXY` — thấy CONNECT tới `antigravity-unleash.goog:443` và `play.googleapis.com:443` (hai tên miền chưa có trong danh sách đoán ban đầu). Chưa
  đo được đường gọi model/OAuth thật (cần đăng nhập thật nên chưa làm), vì vậy chưa dựng proxy allowlist: làm khi có phiên đăng nhập để ghi đủ tên miền.
- Làm mới token đồng thời giữa agy trong api (đăng nhập, lượt inproc của core) và agy trong hộp dùng chung volume `agy_state`: khoá `flock`
  trên `antigravity-oauth-token.lock` thuộc gói G/H4 (không nằm ở H1).
- Cổng nội bộ 8090 không publish ra máy chủ; `agy-bus` là mạng `internal`.
