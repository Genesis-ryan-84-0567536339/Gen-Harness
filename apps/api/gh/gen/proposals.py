"""Gen v2 — A4: đề xuất thao tác có xác nhận (docs/design/gen-v1.md §10).

Ưu tiên đã chốt (§9.5): nháp tin gửi đi → nhắc việc → gán người phụ trách. Nguyên tắc:

1. Gen KHÔNG tự ghi gì. Model trả bước `propose` (envelope có kiểu); server kiểm (quyền, mục tiêu registry, id phải
   vừa thấy trong kết quả tool của chính lượt đó) rồi làm giàu thành bước `proposal` (tóm tắt do HỆ THỐNG viết, nhãn
   tên người/việc, cần PIN hay không) và lưu tạm ở Redis (`PROPOSAL_TTL_S`).
2. Chỉ khi người dùng bấm **Xác nhận** trên thẻ, web gọi `POST /gen/proposals/{id}/confirm` (kèm các trường đã sửa).
   Server kiểm lại mọi thứ, rồi gọi NỘI BỘ đúng endpoint sẵn có (`POST /drafts`, `POST /tasks`, `PATCH /tasks/{id}`,
   `POST /inbox/{id}/assign`) bằng chính phiên + CSRF của người đó → endpoint tự kiểm quyền/phạm vi như khi bấm tay.
3. Mục tiêu registry nhạy cảm (`sensitive`) → cần phiên PIN (423 PIN_REQUIRED, web tự hỏi PIN rồi gửi lại).
4. Mỗi lần xác nhận/huỷ ghi Action Log: actor_type="user" (người bấm), detail.via="gen".
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
import orjson
from pydantic import BaseModel, ValidationError
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.data.common import mask_text
from gh.gen import envelope, registry

PROPOSAL_TTL_S = 24 * 3600
CLAIM_TTL_S = 60
# Nhắc việc lùi quá khứ quá mức này thì từ chối (cho phép lệch đồng hồ nhỏ).
PAST_SLACK = timedelta(minutes=2)

TYPE_LABELS = {"draft_message": "Soạn nháp tin gửi đi", "reminder": "Tạo nhắc việc", "assign": "Giao người phụ trách"}


@dataclass(frozen=True)
class Spec:
    permission: str
    # Trường người dùng được sửa trên thẻ; còn lại (id đối tượng/việc) giữ nguyên như lúc đề xuất.
    editable: tuple[str, ...]


SPECS: dict[str, Spec] = {
    "draft_message": Spec("action.draft", ("title", "text")),
    "reminder": Spec("queue.act", ("title", "remind_at", "due_at", "priority", "assignee_user_id")),
    "assign": Spec("queue.act", ("user_id",)),
}


def key(pid: Any) -> str:
    return f"gh:gen:proposal:{pid}"


def claim_key(pid: Any) -> str:
    return f"gh:gen:proposal:{pid}:claim"


def target_of(ptype: str, fields: dict[str, Any]) -> str:
    """Mục tiêu registry mà đề xuất gắn vào (quyền + cờ nhạy cảm lấy từ đây)."""
    if ptype == "draft_message":
        return "workbench.drafts"
    if ptype == "reminder":
        return "tasks.new"
    return f"{'tasks.row' if fields.get('item_type') == 'task' else 'inbox.row'}:{fields.get('item_id')}"


def requires_pin(target_id: str) -> bool:
    t = registry.resolve_target(target_id)
    return bool(t and t.sensitive)


def _has(permissions: dict[str, str], perm: str | None) -> bool:
    return perm is None or permissions.get(perm, rbac.NONE) != rbac.NONE


def permission_error(permissions: dict[str, str], ptype: str, target_id: str) -> str | None:
    """Quyền của CHÍNH người hỏi: quyền của loại đề xuất + màn + quyền riêng của mục tiêu registry."""
    spec = SPECS[ptype]
    if not _has(permissions, spec.permission):
        return f"người hỏi không có quyền '{spec.permission}'"
    t = registry.resolve_target(target_id)
    if t is None:
        return f"mục tiêu '{target_id}' không có trong registry"
    if not registry.can_see(permissions, t.screen):
        return f"người hỏi không được xem màn '{t.screen}'"
    if not _has(permissions, t.permission):
        return f"người hỏi không có quyền '{t.permission}'"
    return None


def _uuid(v: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(v))
    except (TypeError, ValueError):
        return None


def _aware(dt: datetime | None, tz: ZoneInfo) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=tz) if dt.tzinfo is None else dt


async def org_tz(db: AsyncSession, org_id: uuid.UUID) -> ZoneInfo:
    name = (await db.execute(text("SELECT timezone FROM core.organizations WHERE id = :o"),
                             {"o": org_id})).scalar_one_or_none()
    try:
        return ZoneInfo(name or "Asia/Ho_Chi_Minh")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def normalize(ptype: str, fields: dict[str, Any], tz: ZoneInfo) -> dict[str, Any]:
    """Kiểm schema loại đề xuất + chuẩn hoá (giờ không múi → múi giờ tổ chức, UUID dạng chuẩn). Lỗi → ValueError."""
    model: type[BaseModel] = envelope.PROPOSAL_FIELDS[ptype]
    try:
        m = model.model_validate(fields)
    except ValidationError as e:
        bad = ", ".join(".".join(str(x) for x in err["loc"]) for err in e.errors())
        raise ValueError(f"trường không hợp lệ: {bad}") from e
    out: dict[str, Any] = m.model_dump(mode="python")
    for k in ("remind_at", "due_at"):
        if k in out:
            v = _aware(out[k], tz)
            out[k] = v.astimezone(UTC).isoformat().replace("+00:00", "Z") if v else None
    for k in ("assignee_user_id", "user_id", "item_id"):
        if out.get(k) is not None:
            u = _uuid(out[k])
            if u is None:
                raise ValueError(f"{k} phải là UUID")
            out[k] = str(u)
    subj = out.get("subject")
    if subj is not None:
        u = _uuid(subj.get("id"))
        if u is None:
            raise ValueError("subject.id phải là UUID")
        subj["id"] = str(u)
    if ptype == "reminder":
        remind = datetime.fromisoformat(out["remind_at"].replace("Z", "+00:00"))
        if remind < datetime.now(UTC) - PAST_SLACK:
            raise ValueError("giờ nhắc đã qua")
    return out


def id_errors(ptype: str, fields: dict[str, Any], seen_ids: set[str], self_id: str) -> str | None:
    """Chống bịa id: id đối tượng / việc / người phải vừa xuất hiện trong kết quả tool của lượt này."""
    ids: list[str] = []
    if fields.get("subject"):
        ids.append(fields["subject"]["id"])
    if ptype == "assign":
        ids += [fields["item_id"], fields["user_id"]]
    if ptype == "reminder" and fields.get("assignee_user_id"):
        ids.append(fields["assignee_user_id"])
    for i in ids:
        if i != self_id and i not in seen_ids:
            return f"id '{i}' không có trong kết quả tool của lượt này"
    return None


async def labels(db: AsyncSession, user: service.CurrentUser, ptype: str, fields: dict[str, Any]) -> dict[str, str]:
    """Nhãn hiển thị cho thẻ (tên người, việc, đối tượng). Người được giao phải là người dùng còn hoạt động."""
    owner = user.role_code == rbac.OWNER
    out: dict[str, str] = {}
    uid = fields.get("user_id") if ptype == "assign" else fields.get("assignee_user_id")
    if uid:
        name = (await db.execute(text("""SELECT display_name FROM core.users
                                         WHERE id = :u AND org_id = :o AND is_active AND deleted_at IS NULL"""),
                                 {"u": uid, "o": user.org_id})).scalar_one_or_none()
        if name is None:
            raise ValueError("người được giao không tồn tại hoặc đã bị khoá")
        out["user"] = name
    subj = fields.get("subject")
    if subj:
        if subj["type"] == "person":
            n = (await db.execute(text("SELECT display_name FROM core.persons WHERE id = :i AND org_id = :o"),
                                  {"i": subj["id"], "o": user.org_id})).scalar_one_or_none()
        else:
            n = (await db.execute(text("SELECT name FROM core.groups WHERE id = :i AND org_id = :o"),
                                  {"i": subj["id"], "o": user.org_id})).scalar_one_or_none()
        if n is None:
            raise ValueError("đối tượng không tồn tại")
        out["subject"] = mask_text(n, owner) or ""
    if ptype == "assign" and fields["item_type"] == "task":
        r = (await db.execute(text("SELECT code, title FROM biz.tasks WHERE id = :i AND org_id = :o"),
                              {"i": fields["item_id"], "o": user.org_id})).one_or_none()
        if r is None:
            raise ValueError("việc không tồn tại")
        out["item"] = f"{r.code} · {mask_text(r.title, owner)}"
    elif ptype == "assign":
        # Hiện ĐÚNG mục sẽ bị giao (mã + tiêu đề, theo phạm vi queue.read của người hỏi) — không để thẻ mơ hồ.
        from gh.biz.core.scope import scope_for
        from gh.biz.queue.routes import _item_payload, _load_item
        from gh.errors import ApiError

        try:
            r = await _load_item(db, user.org_id, await scope_for(db, user, "queue.read"),
                                 uuid.UUID(fields["item_id"]))
        except ApiError as e:
            raise ValueError("mục trong Hộp thư không tồn tại hoặc ngoài phạm vi") from e
        item = _item_payload(r, owner=owner)
        out["item"] = f"{item['code']} · {item['title']}" if item.get("code") else str(item["title"] or "")
    return out


def _fmt_time(iso: str | None, tz: ZoneInfo) -> str:
    if not iso:
        return ""
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(tz).strftime("%H:%M %d/%m/%Y")


def summary(ptype: str, fields: dict[str, Any], lab: dict[str, str], tz: ZoneInfo) -> str:
    """Tóm tắt do HỆ THỐNG viết từ các trường đã kiểm — không dùng lời model (chống prompt injection)."""
    if ptype == "draft_message":
        to = f" cho {lab['subject']}" if lab.get("subject") else ""
        return (f"Soạn bản nháp tin “{fields['title']}”{to}. Bản nháp vào Bàn làm việc chờ duyệt — "
                "chưa gửi đi.")
    if ptype == "reminder":
        who = f", giao cho {lab['user']}" if lab.get("user") else ""
        due = f", hạn {_fmt_time(fields.get('due_at'), tz)}" if fields.get("due_at") else ""
        return (f"Tạo nhắc việc “{fields['title']}” ({fields['priority']}), nhắc lúc "
                f"{_fmt_time(fields['remind_at'], tz)}{due}{who}.")
    return f"Giao {lab.get('item', 'mục này')} cho {lab.get('user', 'người được chọn')}."


def public(p: dict[str, Any]) -> dict[str, Any]:
    """Phần gửi xuống web (không kèm user_id/org_id)."""
    return {k: p[k] for k in ("id", "type", "fields", "summary", "labels", "target", "requires_pin", "status")
            if k in p} | ({"result": p["result"]} if p.get("result") else {})


async def build(db: AsyncSession, user: service.CurrentUser, prop: Any, seen_ids: set[str], tz: ZoneInfo,
                *, turn_id: uuid.UUID, conversation_id: uuid.UUID) -> tuple[dict[str, Any] | None, str | None]:
    """Kiểm + làm giàu một đề xuất của model. Trả (đề xuất đầy đủ, None) hoặc (None, lý do chặn)."""
    ptype: str = prop.type
    try:
        fields = normalize(ptype, prop.fields.model_dump(mode="python"), tz)
    except ValueError as e:
        return None, str(e)
    if ptype == "reminder" and not fields.get("assignee_user_id"):
        fields["assignee_user_id"] = str(user.id)  # mặc định nhắc chính người hỏi
    target = target_of(ptype, fields)
    err = permission_error(user.permissions, ptype, target) or id_errors(ptype, fields, seen_ids, str(user.id))
    if err:
        return None, err
    try:
        lab = await labels(db, user, ptype, fields)
    except ValueError as e:
        return None, str(e)
    pid = uuid.uuid4()
    return {"id": str(pid), "type": ptype, "fields": fields, "labels": lab, "target": target,
            "summary": summary(ptype, fields, lab, tz), "requires_pin": requires_pin(target), "status": "pending",
            "user_id": str(user.id), "org_id": str(user.org_id), "turn_id": str(turn_id),
            "conversation_id": str(conversation_id)}, None


async def save(redis: Redis, p: dict[str, Any], ttl: int = PROPOSAL_TTL_S) -> None:
    await redis.set(key(p["id"]), orjson.dumps(p), ex=ttl)


async def load(redis: Redis, pid: Any) -> dict[str, Any] | None:
    raw = await redis.get(key(pid))
    return orjson.loads(raw) if raw is not None else None


# ── Thực hiện sau khi người dùng xác nhận ──

@dataclass
class Call:
    method: str
    path: str
    body: dict[str, Any]
    result_type: str


async def plan_call(db: AsyncSession, user: service.CurrentUser, ptype: str, f: dict[str, Any]) -> Call:
    """Endpoint SẴN CÓ tương ứng loại đề xuất (không có đường ghi riêng cho Gen)."""
    if ptype == "draft_message":
        body: dict[str, Any] = {"kind": "message", "title": f["title"], "text": f["text"],
                                "sources": [{"label": "Gen đề xuất, người dùng xác nhận"}]}
        subj = f.get("subject")
        if subj:
            body["subject"] = subj
            if subj["type"] == "group":
                ch = (await db.execute(text("""SELECT c.type FROM core.groups g JOIN core.channels c
                                               ON c.id = g.channel_id WHERE g.id = :g AND g.org_id = :o"""),
                                       {"g": subj["id"], "o": user.org_id})).scalar_one_or_none()
                if ch:
                    body["target"] = {"channel": ch, "thread_type": "group", "group_id": subj["id"]}
        return Call("POST", "/drafts", body, "draft")
    if ptype == "reminder":
        body = {"title": f["title"], "priority": f["priority"], "remind_at": f["remind_at"],
                "due_at": f.get("due_at"), "assignee_user_id": f.get("assignee_user_id")}
        if f.get("subject"):
            body["subject"] = f["subject"]
        return Call("POST", "/tasks", body, "task")
    if f["item_type"] == "task":
        return Call("PATCH", f"/tasks/{f['item_id']}", {"assignee_user_id": f["user_id"]}, "task")
    return Call("POST", f"/inbox/{f['item_id']}/assign", {"user_id": f["user_id"]}, "inbox_item")


async def call_as_user(app: Any, cookies: dict[str, str], csrf: str, call: Call,
                       ip: str | None = None) -> tuple[int, Any]:
    """Gọi NỘI BỘ (ASGI) endpoint sẵn có bằng phiên + CSRF của chính người bấm — tái dùng nguyên RBAC/phạm vi.
    Người gọi PHẢI đã đóng transaction của request ngoài (xem routes.confirm_proposal)."""
    headers = {"x-csrf-token": csrf} | ({"x-forwarded-for": ip} if ip else {})  # Action Log giữ IP thật
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://gen.internal", cookies=cookies,
                                 timeout=30.0) as c:
        r = await c.request(call.method, f"/api/v1{call.path}", json=call.body,
                            headers=headers)
    try:
        body = r.json()
    except ValueError:
        body = None
    return r.status_code, body


def result_of(call: Call, fields: dict[str, Any], body: Any) -> dict[str, Any]:
    b = body if isinstance(body, dict) else {}
    if call.result_type == "inbox_item":
        return {"type": "inbox_item", "id": fields["item_id"], "screen": "inbox"}
    rid = b.get("id")
    out = {"type": call.result_type, "id": str(rid) if rid else None, "code": b.get("code"),
           "screen": "workbench" if call.result_type == "draft" else "tasks"}
    if call.result_type == "draft":
        # v0.1.43 (F-24): nháp chỉ GỬI ĐƯỢC khi có nơi gửi (hiện chỉ đối tượng là NHÓM mới gắn target — plan_call).
        # Không có target thì duyệt ở Bàn làm việc sẽ NO_TARGET ⇒ web không được hứa "Duyệt & gửi".
        out["sendable"] = bool(call.body.get("target"))
    return out
