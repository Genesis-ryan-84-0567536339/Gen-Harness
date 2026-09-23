# API giai đoạn 1 — hợp đồng giữa web và api

Tiền tố `/api/v1`. JSON. Cookie phiên `gh_session` (HttpOnly). CSRF double-submit: cookie `gh_csrf` (đọc được bằng JS) phải khớp header `X-CSRF-Token` ở mọi request không phải GET/HEAD. Mọi request ghi có thể gửi `Idempotency-Key`.

Lỗi theo RFC 7807: `{"type": "...", "title": "...", "status": 4xx, "code": "PIN_REQUIRED", "detail": "..."}`.

| Mã | Ý nghĩa |
|---|---|
| 401 `UNAUTHENTICATED` | chưa đăng nhập / phiên hết hạn |
| 403 `FORBIDDEN` | vai trò không có quyền |
| 404 `NOT_FOUND` | không tồn tại hoặc ngoài phạm vi dữ liệu |
| 409 `CONFLICT` | ví dụ gỡ plugin nền |
| 423 `PIN_REQUIRED` | cần phiên PIN (UI bật PinDialog rồi gửi lại request) |
| 423 `PIN_LOCKED` | PIN bị khoá, `detail` có `locked_until` |
| 428 `SETUP_REQUIRED` | hệ thống chưa thiết lập xong, UI chuyển tới `/setup` |

## Auth

- `POST /auth/login` `{email, password}` → `200 Me` + set cookie. Sai → 401 `INVALID_CREDENTIALS`.
- `POST /auth/logout` → 204.
- `GET /auth/me` → `Me`:
  ```json
  {
    "id": "uuid", "email": "…", "display_name": "…",
    "role": {"code": "owner", "name": "Owner — Sếp"},
    "org": {"id": "uuid", "name": "…", "timezone": "Asia/Ho_Chi_Minh", "currency": "VND"},
    "addressing": {"self": "Anh", "bot_calls_me": "Sếp"},
    "pin_verified_until": "2026-09-23T15:30:00Z" | null,
    "permissions": {"overview.read": "all", "people_review.read": "none", "…": "…"}
  }
  ```
- `POST /auth/pin/verify` `{pin}` → `{pin_verified_until}`. Sai → 401 `PIN_INVALID` + `attempts_left`. Khoá → 423 `PIN_LOCKED`.
- `PUT /auth/pin` 🔒 `{current_pin, new_pin}` → 204.

## Khung

- `GET /navigation` → cây danh mục đã lọc theo quyền, sinh từ `docs/design/screens.json` + NAV của thiết kế:
  ```json
  [{"domain": "business", "label": "Kinh doanh", "crumb": "KINH DOANH", "icon": "ph-fill ph-briefcase", "tone": "ok",
    "count": 12,
    "groups": [
      {"key": "overview", "name": "Tổng quan điều hành", "en": "Command Overview — màn hình 10 phút", "icon": "ph ph-gauge", "badge": {"value": "9", "tone": "bad"} | null, "children": []},
      {"key": null, "name": "Hàng đợi & Hành động", "icon": "ph ph-tray", "children": [ {"key": "inbox", …} ]}
    ]}]
  ```
  `tone` ∈ `ok | warn | bad | accent`. `badge` là số thật từ API (giai đoạn 1 trả `null` khi chưa có dữ liệu).
- `GET /header` → `{"channels_live": 0, "groups_listening": 0, "autonomy_level": 4, "data_confidence": null}`.
- `GET /health` → `{"status": "ok"}`; `GET /ready` → `{"db": "ok", "redis": "ok", "objects": "ok"|"skip", "bridge": "ok"|"down"}`.

## Thiết lập Owner (`/setup`)

- `GET /setup/state` → `{"finished": false, "current_step": 1, "steps": [{"n": 1, "key": "welcome", "title": "Chào mừng", "required": true, "status": "todo|doing|done|skipped"} …12]}`. Không cần đăng nhập khi chưa xong. Khi `finished=true`, mọi route `/setup/*` khác trả 409.
- `PUT /setup/steps/1` `{token, language: "vi"|"en", mode: "empty"|"sample"}` → state. Token sai → 403 `SETUP_TOKEN_INVALID`.
- `PUT /setup/steps/2` `{token, display_name, email, password, pin, pin_confirm}` → state + đăng nhập luôn (set cookie). Mật khẩu ≥ 12 ký tự; PIN đúng 6 chữ số, hai lần khớp. Lỗi trường → 422 `{"errors": {"field": "message"}}`.
- `PUT /setup/steps/3` (đã đăng nhập, Owner) `{org_name, timezone, currency, self_name, bot_calls_me}` → state.
- Bước 4–12 làm ở các giai đoạn sau; giai đoạn 1 cho phép `POST /setup/steps/{n}/skip` với bước không bắt buộc, và web hiện bước chưa làm với trạng thái "Sắp có".

## Nhật ký & plugin (phục vụ test giai đoạn 1; màn hình đầy đủ ở GĐ 4)

- `GET /audit?cursor=&limit=&actor_type=&action=` → `{"items": [{"id","at","actor_type","actor_id","actor_label","action","target_type","target_id","target_label","autonomy_level","result","detail"}], "next_cursor": "…"|null}`.
- `GET /audit/verify` → `{"ok": true, "checked": 1234, "broken_at": null}`.
- `GET /plugins` → danh sách `ops.plugins` + sức khoẻ + breaker.
- `PATCH /plugins/{package}/toggle` 🔒 `{enabled}`; `DELETE /plugins/{package}` 🔒 (409 với plugin nền).
