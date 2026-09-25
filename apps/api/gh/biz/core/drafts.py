"""Bàn làm việc: tạo bản nháp qua policy, duyệt → permit dùng một lần → bridge gửi → kết quả (ARCHITECTURE §7).

Luật cứng (khoá 3): mọi thứ ghi ra ngoài, vượt ngưỡng tiền, liên quan nhân sự dừng ở đây ở **mọi** mức tự trị.
Cờ lấy từ registry loại hành động của chassis (`gh.chassis.policy`), không từ model hay người gọi.

Mã khác tạo bản nháp bằng `create_draft(...)`. Duyệt / sửa rồi gửi / huỷ đi qua `decide(...)`.
"""

import base64
import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto, realtime
from gh.chassis import actionlog, policy
from gh.chassis.bus import BRIDGE_OUTBOUND, EventBus
from gh.data.common import iso

KIND_LABELS = {"message": "Tin nhắn", "quotation": "Báo giá", "contract": "Hợp đồng", "reminder": "Nhắc việc",
               "report": "Báo cáo", "mcp_write": "Ghi hệ thống ngoài"}
# Loại bản nháp → khoá registry mặc định.
KIND_ACTION = {"message": "message.send", "quotation": "quotation.send", "contract": "contract.send",
               "reminder": "reminder.create", "report": "report.create", "mcp_write": "mcp.write"}
CHANNEL_LABELS = {"zalo": "Zalo", "whatsapp": "WhatsApp", "telegram": "Telegram", "linkedin": "LinkedIn"}
SENDABLE = {"message", "quotation", "contract"}
PENDING, APPROVED, EDITED, REJECTED, SENT, FAILED = "pending", "approved", "edited", "rejected", "sent", "failed"
DECIDED = (APPROVED, EDITED, REJECTED, SENT, FAILED)


class DraftError(Exception):
    def __init__(self, status: int, code: str, title: str):
        super().__init__(title)
        self.status, self.code, self.title = status, code, title


@dataclass(frozen=True)
class Target:
    """Nơi bản nháp sẽ được gửi tới. Đúng một trong group_id / person_id."""

    channel: str                      # zalo | whatsapp | …
    thread_type: str                  # group | user
    group_id: uuid.UUID | None = None
    person_id: uuid.UUID | None = None

    def to_json(self) -> dict[str, Any]:
        return {"channel": self.channel, "thread_type": self.thread_type,
                "group_id": str(self.group_id) if self.group_id else None,
                "person_id": str(self.person_id) if self.person_id else None}


# ─── mức tự trị hiệu lực ──────────────────────────────────────────────────────

async def approval_threshold(db: AsyncSession, org_id: uuid.UUID) -> int:
    v = (await db.execute(text("""SELECT params->>'approval_threshold_vnd' FROM ops.policy_boundaries
                                   WHERE org_id = :o AND code = 'approval_gate'"""),
                          {"o": org_id})).scalar_one_or_none()
    return int(v) if v else policy.DEFAULT_APPROVAL_THRESHOLD_VND


async def effective_level(db: AsyncSession, org_id: uuid.UUID, *, agent_id: uuid.UUID | None = None,
                          person_id: uuid.UUID | None = None, group_id: uuid.UUID | None = None) -> int:
    """Mức thấp nhất trong các lớp đã đặt: tổ chức → nhóm → người → agent (ARCHITECTURE §7.1).

    Mức riêng của một người / nhóm nằm ở `attrs.autonomy_level` (đặt từ Hồ sơ sống, Nhóm & Con người).
    """
    r = (await db.execute(text("""
        SELECT (SELECT (settings->>'autonomy_level')::int FROM core.organizations WHERE id = :o) AS org,
               (SELECT (attrs->>'autonomy_level')::int FROM core.groups WHERE id = :g) AS grp,
               (SELECT (attrs->>'autonomy_level')::int FROM core.persons WHERE id = :p) AS per,
               (SELECT autonomy_level FROM agent.identities WHERE id = :a) AS agt"""),
        {"o": org_id, "g": group_id, "p": person_id, "a": agent_id})).one()
    return policy.effective_autonomy(r.org, r.grp, r.per, r.agt)


# ─── tạo ──────────────────────────────────────────────────────────────────────

def _paragraphs(body: str) -> list[str]:
    return [p.strip() for p in body.replace("\r\n", "\n").split("\n\n") if p.strip()]


async def create_draft(db: AsyncSession, *, org_id: uuid.UUID, kind: str, title: str, body_text: str,
                       target: Target | None = None, action_key: str | None = None,
                       agent_id: uuid.UUID | None = None, created_by: uuid.UUID | None = None,
                       subject: tuple[str, uuid.UUID] | None = None, sources: list[dict[str, Any]] | None = None,
                       side_actions: list[dict[str, Any]] | None = None, amount_vnd: int | None = None,
                       autonomy_level: int | None = None, lang: str = "vi", parent_draft_id: uuid.UUID | None = None,
                       redis: Redis | None = None) -> dict[str, Any]:
    """Tạo một hành động đề xuất và cho qua policy.

    - `sources`: `[{"label", "ref": {"type", "id", "code"?}}]` — đúng dữ liệu đã dùng, không mục nào không truy được.
    - `side_actions`: `[{"key", "label", "on", "action_key", "params"}]` — công tắc "Tạo kèm theo".
    - `autonomy_level`: bỏ trống → tính mức hiệu lực theo tổ chức / nhóm / người / agent.

    Trả `{"id", "code", "status", "outcome", "hold_reason"}`. `outcome` là quyết định policy: `held` (vào Bàn
    làm việc, trạng thái `pending`), `auto` (việc nội bộ được tự làm: thực hiện ngay, trạng thái `sent`),
    `suggest` / `blocked` (mức 0–3: không tạo bản nháp, `id` = None).
    """
    if kind not in KIND_LABELS:
        raise ValueError(f"Loại bản nháp không hợp lệ: {kind}")
    key = action_key or KIND_ACTION[kind]
    t = policy.action_type(key)
    person_id = target.person_id if target else None
    group_id = target.group_id if target else None
    if subject and subject[0] == "person":
        person_id = person_id or subject[1]
    if subject and subject[0] == "group":
        group_id = group_id or subject[1]
    level = autonomy_level if autonomy_level is not None else await effective_level(
        db, org_id, agent_id=agent_id, person_id=person_id, group_id=group_id)
    threshold = await approval_threshold(db, org_id)
    if created_by is not None and level < 4:
        level = 4    # người tự soạn: luôn thành bản nháp chờ duyệt, không bị mức 0–3 của agent chặn
    decision = policy.evaluate(key, level, amount_vnd=amount_vnd or 0, approval_threshold_vnd=threshold)
    if decision.outcome in (policy.SUGGEST, policy.BLOCKED):
        return {"id": None, "code": None, "status": None, "outcome": decision.outcome,
                "hold_reason": "; ".join(decision.reasons)}
    over = bool(t.has_amount and (amount_vnd or 0) > threshold)
    flags = {"writes_external": t.writes_external, "personnel_related": t.personnel_related,
             "over_threshold": over, "amount_vnd": amount_vnd}
    channel_id = None
    if target is not None:
        channel_id = (await db.execute(text("SELECT id FROM core.channels WHERE org_id = :o AND type = :t"),
                                       {"o": org_id, "t": target.channel})).scalar_one_or_none()
    body: dict[str, Any] = {"text": body_text, "lang": lang, "target": target.to_json() if target else None,
            "amount_vnd": amount_vnd, "versions": []}
    code = (await db.execute(text("SELECT core.next_code('ACT')"))).scalar_one()
    status = PENDING if decision.outcome == policy.HELD else SENT
    row = (await db.execute(text("""
        INSERT INTO biz.action_drafts (org_id, code, kind, action_key, title, agent_id, created_by, subject_type,
                                       subject_id, channel_id, group_id, body, sources, side_actions, autonomy_level,
                                       hold_reason, status, flags, parent_draft_id,
                                       decided_at, sent_at)
        VALUES (:o, :c, :k, :ak, :ti, :a, :cb, :st, :si, :ch, :g, CAST(:b AS jsonb), CAST(:src AS jsonb),
                CAST(:sa AS jsonb), :lvl, :hr, :s, CAST(:f AS jsonb), :par,
                CASE WHEN :s = 'sent' THEN now() END, CASE WHEN :s = 'sent' THEN now() END)
        RETURNING id, code"""),
        {"o": org_id, "c": code, "k": kind, "ak": key, "ti": title, "a": agent_id, "cb": created_by,
         "st": subject[0] if subject else None, "si": subject[1] if subject else None, "ch": channel_id,
         "g": group_id, "b": orjson.dumps(body).decode(), "src": orjson.dumps(sources or []).decode(),
         "sa": orjson.dumps(side_actions or []).decode(), "lvl": level, "hr": decision.hold_reason,
         "s": status, "f": orjson.dumps(flags).decode(), "par": parent_draft_id})).one()
    actor_type, actor_id = ("agent", f"agent:{agent_id}") if agent_id else (
        ("user", f"user:{created_by}") if created_by else ("system", "system:drafts"))
    await actionlog.record(db, org_id=org_id, actor_type=actor_type, actor_id=actor_id,
                           action="draft.created" if status == PENDING else "action.auto_executed",
                           target_type="draft", target_id=str(row.id), target_label=f"{row.code} · {title}",
                           autonomy_level=level, result="held" if status == PENDING else "ok",
                           detail={"action_key": key, "reasons": decision.reasons, "flags": flags})
    if status == SENT:
        await _execute_internal(db, org_id, row.id, key, body_text, subject, created_by)
    if redis is not None:
        await realtime.publish(redis, "draft.new", await list_item(db, row.id), org_id=org_id)
    return {"id": row.id, "code": row.code, "status": status, "outcome": decision.outcome,
            "hold_reason": decision.hold_reason}


def _when(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value))


async def _execute_internal(db: AsyncSession, org_id: uuid.UUID, draft_id: uuid.UUID | None, action_key: str,
                            label: str, subject: tuple[str, uuid.UUID] | None, user_id: uuid.UUID | None,
                            params: dict[str, Any] | None = None) -> None:
    """Việc nội bộ (không ghi ra ngoài): tạo việc, đặt nhắc, ghi sổ tay, gắn nhãn."""
    params = params or {}
    if action_key in ("task.create", "reminder.create"):
        code = (await db.execute(text("SELECT core.next_code('TSK')"))).scalar_one()
        due = _when(params.get("due_at"))
        remind = _when(params.get("remind_at"))
        if action_key == "reminder.create" and not remind:
            remind = datetime.now(UTC) + timedelta(hours=float(params.get("after_hours", 48)))
        await db.execute(text("""
            INSERT INTO biz.tasks (org_id, code, title, priority, status, assignee_user_id, subject_type, subject_id,
                                   due_at, remind_at, source)
            VALUES (:o, :c, :t, :p, 'todo', :u, :st, :si, :d, :r, 'draft')"""),
            {"o": org_id, "c": code, "t": label, "p": params.get("priority", "P2"), "u": user_id,
             "st": subject[0] if subject else None, "si": subject[1] if subject else None, "d": due, "r": remind})
    elif action_key == "note.write" and subject and subject[0] in ("person", "group"):
        from gh.memory import notebook

        await notebook.append(db, org_id, subject[0], subject[1], params.get("section", "rolling_context"), label,
                              refs=[{"type": "draft", "id": str(draft_id)}] if draft_id else [],
                              author="user" if user_id else "agent")


# ─── đọc ──────────────────────────────────────────────────────────────────────

_SELECT = """
SELECT d.*, a.name AS agent_name, u.display_name AS creator_name, du.display_name AS decider_name,
       c.type AS channel_type,
       p.id AS p_id, p.code AS p_code, p.display_name AS p_name, p.person_type AS p_type,
       p.organization_name AS p_org,
       g.id AS g_id, g.code AS g_code, g.name AS g_name, gc.type AS g_channel
FROM biz.action_drafts d
LEFT JOIN agent.identities a ON a.id = d.agent_id
LEFT JOIN core.users u ON u.id = d.created_by
LEFT JOIN core.users du ON du.id = d.decided_by
LEFT JOIN core.channels c ON c.id = d.channel_id
LEFT JOIN core.persons p ON d.subject_type = 'person' AND p.id = d.subject_id
LEFT JOIN core.groups g ON g.id = COALESCE(CASE WHEN d.subject_type = 'group' THEN d.subject_id END, d.group_id)
LEFT JOIN core.channels gc ON gc.id = g.channel_id
"""


def _subject(r: Any) -> dict[str, Any] | None:
    if r.p_id:
        return {"id": str(r.p_id), "code": r.p_code, "name": r.p_name, "type": r.p_type, "org_name": r.p_org}
    if r.g_id and r.subject_type == "group":
        return {"id": str(r.g_id), "code": r.g_code, "name": r.g_name, "channel": r.g_channel}
    return None


def item_payload(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "code": r.code, "kind": r.kind, "kind_label": KIND_LABELS.get(r.kind, r.kind),
            "title": r.title or KIND_LABELS.get(r.kind, r.kind),
            "agent": {"id": str(r.agent_id), "name": r.agent_name} if r.agent_id else None,
            "created_by": {"id": str(r.created_by), "name": r.creator_name} if r.created_by else None,
            "created_at": iso(r.created_at), "status": r.status, "hold_reason": r.hold_reason,
            "subject": _subject(r)}


async def list_item(db: AsyncSession, draft_id: uuid.UUID) -> dict[str, Any]:
    r = (await db.execute(text(_SELECT + " WHERE d.id = :i"), {"i": draft_id})).one()
    return item_payload(r)


async def load(db: AsyncSession, draft_id: uuid.UUID) -> Any:
    return (await db.execute(text(_SELECT + " WHERE d.id = :i"), {"i": draft_id})).one_or_none()


# ─── gửi ──────────────────────────────────────────────────────────────────────

def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def bridge_permit(claims: dict[str, Any]) -> str:
    """Permit gửi tin theo docs/api/bridge-protocol.md: base64url(JSON claims) "." base64url(HMAC)."""
    head = _b64url(json.dumps(claims, separators=(",", ":"), ensure_ascii=False).encode())
    return f"{head}.{_b64url(crypto.hmac_sign(head.encode()))}"


async def _thread(db: AsyncSession, target: dict[str, Any]) -> tuple[str, str] | None:
    """(thread_id phía nền tảng, thread_type) của đích gửi."""
    if target.get("group_id"):
        ext = (await db.execute(text("SELECT external_id FROM core.groups WHERE id = :g"),
                                {"g": target["group_id"]})).scalar_one_or_none()
        return (ext, "group") if ext else None
    if target.get("person_id"):
        ext = (await db.execute(text("""
            SELECT pi.external_id FROM core.person_identities pi JOIN core.channels c ON c.id = pi.channel_id
            WHERE pi.person_id = :p AND c.type = :ch ORDER BY pi.first_seen_at LIMIT 1"""),
            {"p": target["person_id"], "ch": target["channel"]})).scalar_one_or_none()
        return (ext, "user") if ext else None
    return None


async def _dispatch_send(db: AsyncSession, bus: EventBus | None, r: Any, body_text: str) -> dict[str, Any] | None:
    """Cấp permit dùng một lần và đẩy lệnh gửi sang bridge. Trả send_result nếu thất bại ngay."""
    target = (r.body or {}).get("target")
    if not target:
        return {"ok": False, "error": "NO_TARGET"}
    thread = await _thread(db, target)
    if thread is None:
        return {"ok": False, "error": "TARGET_NOT_FOUND"}
    session_id = (await db.execute(text("""
        SELECT s.id FROM core.channel_sessions s JOIN core.channels c ON c.id = s.channel_id
        WHERE c.org_id = :o AND c.type = :t AND s.state = 'active' AND s.ended_at IS NULL
        ORDER BY s.started_at DESC LIMIT 1"""), {"o": r.org_id, "t": target["channel"]})).scalar_one_or_none()
    if session_id is None:
        return {"ok": False, "error": "SESSION_NOT_ACTIVE"}
    exp = int(time.time()) + policy.PERMIT_TTL_S
    nonce = uuid.uuid4().hex
    claims = {"nonce": nonce, "draft_id": str(r.id), "channel": target["channel"], "thread_id": thread[0],
              "thread_type": thread[1], "body_sha256": hashlib.sha256(body_text.encode()).hexdigest(), "exp": exp}
    token = bridge_permit(claims)
    await db.execute(text("""UPDATE biz.action_drafts SET permit_hash = :h, permit_expires_at = to_timestamp(:e)
                             WHERE id = :i"""), {"h": hashlib.sha256(token.encode()).digest(), "e": exp, "i": r.id})
    if bus is not None:
        await bus.publish(BRIDGE_OUTBOUND, "message.send",
                          {"channel": target["channel"], "session_id": str(session_id), "thread_id": thread[0],
                           "thread_type": thread[1], "text": body_text, "permit": token},
                          actor="system:drafts", org_id=r.org_id, correlation_id=str(r.id))
    return None


async def expire_stale_permits(db: AsyncSession, redis: Redis | None = None) -> list[uuid.UUID]:
    """Giai đoạn 5.4 (chịu lỗi, spec M7): bridge rớt giữa chừng khi đang gửi (mất kết nối trước khi gửi lại
    `send.result` cho `on_send_result`) từng khiến bản nháp kẹt ở `approved`/`edited` MÃI MÃI — không rõ đã gửi
    hay chưa, không thấy trong hàng đợi lỗi. Quét định kỳ (xem `gh.app._permit_sweep_loop`): permit dùng một
    lần đã hết hạn (`permit_expires_at < now()`) mà chưa được dùng (`permit_used_at IS NULL`) → đánh dấu
    `failed` rõ ràng với lý do `PERMIT_EXPIRED`, vào Action Log, đẩy WS để Owner thấy và có thể tạo bản nháp
    gửi lại. Không có bản ghi nào bị xoá hay mất — chỉ chuyển từ "không rõ" sang "lỗi, cần gửi lại"."""
    rows = (await db.execute(text("""
        UPDATE biz.action_drafts SET status = :failed, send_result = CAST(:r AS jsonb), updated_at = now()
        WHERE status IN (:approved, :edited) AND permit_used_at IS NULL
          AND permit_expires_at IS NOT NULL AND permit_expires_at < now()
        RETURNING id, org_id, code, title, autonomy_level"""),
        {"failed": FAILED, "approved": APPROVED, "edited": EDITED,
         "r": orjson.dumps({"ok": False, "error": "PERMIT_EXPIRED",
                            "at": datetime.now(UTC).isoformat()}).decode()})).all()
    for row in rows:
        await actionlog.record(db, org_id=row.org_id, actor_type="system", actor_id="system:drafts",
                               action="draft.failed", target_type="draft", target_id=str(row.id),
                               target_label=f"{row.code} · {row.title}", autonomy_level=row.autonomy_level,
                               result="failed", detail={"error": "PERMIT_EXPIRED"})
        if redis is not None:
            await realtime.publish(redis, "draft.updated",
                                   {"id": str(row.id), "status": FAILED,
                                    "send_result": {"ok": False, "error": "PERMIT_EXPIRED"}}, org_id=row.org_id)
    return [row.id for row in rows]


async def on_send_result(db: AsyncSession, org_id: uuid.UUID, payload: dict[str, Any],
                         redis: Redis | None = None) -> None:
    """`send.result` từ bridge → trạng thái `sent` / `failed` của bản nháp (dùng một lần: chỉ lần đầu có tác dụng)."""
    try:
        draft_id = uuid.UUID(str(payload.get("draft_id")))
    except ValueError:
        return
    ok = bool(payload.get("ok"))
    result = {"ok": ok, "error": payload.get("error"), "external_msg_id": payload.get("external_msg_id"),
              "at": datetime.now(UTC).isoformat()}
    row = (await db.execute(text("""
        UPDATE biz.action_drafts SET status = :s, send_result = CAST(:r AS jsonb), permit_used_at = now(),
               sent_at = CASE WHEN :ok THEN now() END, updated_at = now()
        WHERE id = :i AND org_id = :o AND status IN ('approved', 'edited') AND permit_used_at IS NULL
        RETURNING id, code, title, autonomy_level"""),
        {"s": SENT if ok else FAILED, "r": orjson.dumps(result).decode(), "ok": ok, "i": draft_id,
         "o": org_id})).one_or_none()
    if row is None:
        return
    await actionlog.record(db, org_id=org_id, actor_type="system", actor_id="system:drafts",
                           action="draft.sent" if ok else "draft.failed", target_type="draft",
                           target_id=str(row.id), target_label=f"{row.code} · {row.title}",
                           autonomy_level=row.autonomy_level, result="ok" if ok else "failed", detail=result)
    if redis is not None:
        await realtime.publish(redis, "draft.updated", {"id": str(row.id), "status": SENT if ok else FAILED,
                                                        "send_result": result}, org_id=org_id)


# ─── quyết định ───────────────────────────────────────────────────────────────

async def decide(db: AsyncSession, *, draft_id: uuid.UUID, org_id: uuid.UUID, user_id: uuid.UUID, verdict: str,
                 text_override: str | None = None, reason: str | None = None,
                 side_actions: dict[str, bool] | None = None, bus: EventBus | None = None,
                 redis: Redis | None = None) -> str:
    """Duyệt (`approve`), sửa rồi gửi (`edit`) hoặc huỷ (`reject`). Trả trạng thái mới.

    Khoá dòng bằng `FOR UPDATE` → hai người bấm cùng lúc chỉ một người quyết (người sau nhận 409 DRAFT_DECIDED).
    """
    r = (await db.execute(text("SELECT * FROM biz.action_drafts WHERE id = :i AND org_id = :o FOR UPDATE"),
                          {"i": draft_id, "o": org_id})).one_or_none()
    if r is None:
        raise DraftError(404, "NOT_FOUND", "Bản nháp không tồn tại")
    if r.status != PENDING:
        raise DraftError(409, "DRAFT_DECIDED", "Bản nháp này đã được quyết định")
    body = dict(r.body or {})
    if verdict == "reject":
        status = REJECTED
    else:
        status = EDITED if verdict == "edit" else APPROVED
        if verdict == "edit":
            if not (text_override or "").strip():
                raise DraftError(422, "VALIDATION", "Nội dung gửi không được để trống")
            versions = list(body.get("versions") or [])
            versions.append({"at": datetime.now(UTC).isoformat(), "by": "agent" if r.agent_id else "user",
                             "text": body.get("text", "")})
            body = {**body, "text": text_override, "versions": versions}
    toggles = side_actions or {}
    actions = [{**a, "on": bool(toggles.get(a.get("key"), a.get("on")))} for a in (r.side_actions or [])]
    await db.execute(text("""
        UPDATE biz.action_drafts SET status = :s, decided_by = :u, decided_at = now(), decision_reason = :why,
               body = CAST(:b AS jsonb), side_actions = CAST(:sa AS jsonb), updated_at = now()
        WHERE id = :i"""), {"s": status, "u": user_id, "why": reason, "b": orjson.dumps(body).decode(),
                            "sa": orjson.dumps(actions).decode(), "i": draft_id})
    label = f"{r.code} · {r.title or KIND_LABELS.get(r.kind, r.kind)}"
    await actionlog.record(db, org_id=org_id, actor_type="user", actor_id=f"user:{user_id}",
                           action={"approve": "draft.approved", "edit": "draft.edited", "reject": "draft.rejected"}[
                               verdict], target_type="draft", target_id=str(draft_id), target_label=label,
                           autonomy_level=r.autonomy_level, result="ok", detail={"reason": reason})
    subject = (r.subject_type, r.subject_id) if r.subject_type and r.subject_id else None
    if status != REJECTED:
        for a in actions:
            if not a.get("on") or not a.get("action_key"):
                continue
            t = policy.action_type(a["action_key"])
            if t.writes_external or t.personnel_related:
                await create_draft(db, org_id=org_id, kind="mcp_write" if a["action_key"] == "mcp.write" else "report",
                                   title=a.get("label", ""), body_text=a.get("label", ""),
                                   action_key=a["action_key"], created_by=user_id, subject=subject,
                                   parent_draft_id=draft_id, redis=redis)
            else:
                await _execute_internal(db, org_id, draft_id, a["action_key"], a.get("label", ""), subject, user_id,
                                        a.get("params"))
        if r.kind in SENDABLE:
            fresh = (await db.execute(text("SELECT * FROM biz.action_drafts WHERE id = :i"), {"i": draft_id})).one()
            failed = await _dispatch_send(db, bus, fresh, body.get("text", ""))
            if failed is not None:
                await db.execute(text("""UPDATE biz.action_drafts SET status = 'failed',
                                         send_result = CAST(:r AS jsonb), updated_at = now() WHERE id = :i"""),
                                 {"r": orjson.dumps({**failed, "at": datetime.now(UTC).isoformat()}).decode(),
                                  "i": draft_id})
                await actionlog.record(db, org_id=org_id, actor_type="system", actor_id="system:drafts",
                                       action="draft.failed", target_type="draft", target_id=str(draft_id),
                                       target_label=label, autonomy_level=r.autonomy_level, result="failed",
                                       detail=failed)
                status = FAILED
        else:
            await _execute_internal(db, org_id, draft_id, r.action_key or KIND_ACTION[r.kind],
                                    r.title or body.get("text", ""), subject, user_id)
            await db.execute(text("""UPDATE biz.action_drafts SET status = 'sent', sent_at = now(), updated_at = now()
                                     WHERE id = :i"""), {"i": draft_id})
            status = SENT
    if redis is not None:
        cur = (await db.execute(text("SELECT send_result FROM biz.action_drafts WHERE id = :i"),
                                {"i": draft_id})).scalar_one()
        await realtime.publish(redis, "draft.updated", {"id": str(draft_id), "status": status, "send_result": cur},
                               org_id=org_id)
    return status


def permit_matches(token: str, stored_hash: bytes | None) -> bool:
    return stored_hash is not None and hmac.compare_digest(hashlib.sha256(token.encode()).digest(), stored_hash)
