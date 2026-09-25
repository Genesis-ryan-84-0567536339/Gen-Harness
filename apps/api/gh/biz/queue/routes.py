"""API Hàng đợi & Hành động (docs/api/phase-3-queue.md): Tổng quan, Hộp thư ý nghĩa, Việc & Nhắc hẹn.

Cảnh báo sớm (spec E9) dùng bảng `biz.alerts` đã có từ giai đoạn 1/2 (`gh.providers.router.raise_alert`, đã được
`gh.refinery.runner` và `ModelRouter` gọi); cụm này đọc/hành động trên chúng qua Hộp thư và sinh thêm các loại
cảnh báo theo ngưỡng thời gian (`gh.biz.queue.jobs.early_warning_scan`).
"""

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import realtime
from gh.auth import rbac, service
from gh.auth.deps import current_user, require
from gh.biz.core import drafts, explain
from gh.biz.core.scope import Scope, ensure_group, ensure_person, not_found, scope_for
from gh.biz.queue import service as qsvc
from gh.chassis import actionlog
from gh.data.common import iso, mask_text
from gh.db import DB
from gh.errors import ApiError

router = APIRouter(tags=["queue"])

realtime.register_event("alert.new", "queue.read")

OPP_EVENTS = list(qsvc.OPPORTUNITY_EVENTS)
REPLY_EVENTS = list(qsvc.REPLY_EVENTS)


# ─── Hộp thư ý nghĩa ────────────────────────────────────────────────────────

_ITEMS_CTE = """
WITH items AS (
  SELECT i.org_id, i.item_type, i.item_id, i.code, i.title, i.summary, i.subject_type, i.subject_id,
         i.group_id, i.person_id, i.priority, i.created_at, i.score,
         p.code AS p_code, p.display_name AS p_name, p.person_type AS p_type, p.organization_name AS p_org,
         g.code AS g_code, g.name AS g_name, gc.type AS g_channel,
         d.kind AS draft_kind, d.status AS draft_status, d.agent_id AS draft_agent_id, ag.name AS draft_agent_name,
         a.alert_type, a.suggested_action, a.status AS alert_status,
         CASE WHEN i.item_type = 'alert' THEN 'alert'
              WHEN i.item_type = 'draft' THEN 'approval'
              WHEN p.person_type = 'candidate' THEN 'candidate'
              WHEN i.title = ANY(CAST(:opp AS text[])) THEN 'opportunity'
              WHEN i.title = ANY(CAST(:reply AS text[])) THEN 'reply'
              ELSE 'other' END AS tab
  FROM biz.inbox_items i
  LEFT JOIN core.persons p ON p.id = i.person_id
  LEFT JOIN core.groups g ON g.id = i.group_id
  LEFT JOIN core.channels gc ON gc.id = g.channel_id
  LEFT JOIN biz.action_drafts d ON i.item_type = 'draft' AND d.id = i.item_id
  LEFT JOIN agent.identities ag ON ag.id = d.agent_id
  LEFT JOIN biz.alerts a ON i.item_type = 'alert' AND a.id = i.item_id
  WHERE i.org_id = :o AND {scope} AND {silence}
)
"""


def _item_payload(r: Any, *, owner: bool) -> dict[str, Any]:
    subject = qsvc.subject_ref(r)
    tab = r.tab if r.tab != "other" else ("reply" if r.item_type == "unit" else "all")
    label = qsvc.EVENT_LABELS.get(r.title, r.title) if r.item_type == "unit" else r.title
    return {
        "id": str(r.item_id), "code": r.code, "item_type": r.item_type, "tab": tab,
        "title": mask_text(label, owner), "summary": mask_text(r.summary, owner),
        "priority": r.priority, "created_at": iso(r.created_at),
        "score": float(r.score) if r.score is not None else None,
        "confidence_band": qsvc.confidence_band(float(r.score)) if r.score is not None else None,
        "subject": subject, "group": qsvc.group_ref(r),
        "agent": {"id": str(r.draft_agent_id), "name": r.draft_agent_name}
        if getattr(r, "draft_agent_id", None) else None,
        "alert_type": getattr(r, "alert_type", None),
        "alert_type_label": qsvc.ALERT_TYPE_LABELS.get(getattr(r, "alert_type", None) or "",
                                                        getattr(r, "alert_type", None)),
        "suggested_action": mask_text(getattr(r, "suggested_action", None), owner),
    }


@router.get("/inbox")
async def list_inbox(tab: Literal["all", "opportunity", "alert", "approval", "reply", "candidate"] = "all",
                     intent: str | None = None, cursor: str | None = None,
                     limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(current_user),
                     db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.read")
    where, params = qsvc.item_scope_sql(sc, "i")
    base = {"o": user.org_id, "opp": OPP_EVENTS, "reply": REPLY_EVENTS, **params}
    counts_rows = (await db.execute(
        text(_ITEMS_CTE.format(scope=where, silence=qsvc.not_silenced_sql("i")) +
             " SELECT tab, count(*) AS cnt FROM items GROUP BY tab"), base)).all()  # noqa: S608
    counts = {t: 0 for t in qsvc.TABS}
    for row in counts_rows:
        t = row.tab if row.tab != "other" else "reply"
        counts[t] = counts.get(t, 0) + row.cnt
        counts["all"] += row.cnt
    conds = []
    if tab != "all":
        conds.append("tab = :tab" if tab != "reply" else "tab IN ('reply', 'other')")
    if intent:
        conds.append("title = :intent")
    if cursor:
        conds.append("created_at < :c")
    where_page = (" AND " + " AND ".join(conds)) if conds else ""
    rows = (await db.execute(
        text(_ITEMS_CTE.format(scope=where, silence=qsvc.not_silenced_sql("i")) +
             f" SELECT * FROM items WHERE TRUE{where_page} ORDER BY created_at DESC LIMIT :n"),  # noqa: S608
        {**base, "tab": tab, "intent": intent, "c": qsvc.when(cursor), "n": limit + 1})).all()
    owner = user.role_code == rbac.OWNER
    items = [_item_payload(r, owner=owner) for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].created_at) if len(rows) > limit else None,
            "total": counts["all"], "counts": counts}


async def _load_item(db: AsyncSession, org_id: uuid.UUID, sc: Scope, item_id: uuid.UUID) -> Any:
    where, params = qsvc.item_scope_sql(sc, "i")
    r = (await db.execute(
        text(_ITEMS_CTE.format(scope=where, silence="TRUE") + " SELECT * FROM items WHERE item_id = :i"),  # noqa: S608
        {"o": org_id, "opp": OPP_EVENTS, "reply": REPLY_EVENTS, "i": item_id, **params})).one_or_none()
    if r is None:
        raise not_found("Mục trong hàng đợi")
    return r


@router.get("/inbox/{item_id}")
async def get_inbox_item(item_id: uuid.UUID, user: service.CurrentUser = Depends(current_user),
                         db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.read")
    r = await _load_item(db, user.org_id, sc, item_id)
    owner = user.role_code == rbac.OWNER
    payload = _item_payload(r, owner=owner)
    if r.item_type == "unit":
        payload["units"] = await explain.units_payload(db, [item_id], is_owner=owner)
    elif r.item_type == "alert":
        ev = (await db.execute(text("SELECT evidence FROM biz.alerts WHERE id = :i"), {"i": item_id})).scalar_one()
        payload["units"] = await explain.units_payload(db, explain.unit_ids_of(ev), is_owner=owner)
        payload["status"] = r.alert_status
    elif r.item_type == "draft":
        payload["status"] = r.draft_status
        payload["kind"] = r.draft_kind
    return payload


class ActIn(BaseModel):
    text: str | None = Field(default=None, max_length=20000)
    create_task: bool = False


@router.post("/inbox/{item_id}/act")
async def act_inbox_item(item_id: uuid.UUID, request: Request, body: ActIn | None = None,
                         user: service.CurrentUser = Depends(require("queue.act")),
                         db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.act")
    r = await _load_item(db, user.org_id, sc, item_id)
    body = body or ActIn()
    if r.item_type == "draft":
        raise ApiError(409, "USE_WORKBENCH", "Duyệt bản nháp này ở Bàn làm việc")
    if r.item_type == "alert":
        row = (await db.execute(text("""UPDATE biz.alerts SET status = 'acknowledged'
                                        WHERE id = :i AND org_id = :o AND status = 'open' RETURNING id"""),
                                {"i": item_id, "o": user.org_id})).first()
        if row is None:
            raise ApiError(409, "ALERT_DECIDED", "Cảnh báo này đã được xử lý")
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="alert.acknowledged", target_type="alert", target_id=str(item_id),
                               target_label=r.title, result="ok")
        if body.create_task:
            code = (await db.execute(text("SELECT core.next_code('TSK')"))).scalar_one()
            await db.execute(text("""INSERT INTO biz.tasks (org_id, code, title, priority, status, assignee_user_id,
                                                            subject_type, subject_id, source)
                                     VALUES (:o, :c, :t, :p, 'todo', :u, :st, :si, 'alert')"""),
                             {"o": user.org_id, "c": code, "t": r.title, "p": r.priority, "u": user.id,
                              "st": r.subject_type, "si": r.subject_id})
        return {"ok": True, "status": "acknowledged"}
    # item_type == "unit": soạn nhanh một bản nháp trả lời.
    if not body.text or not body.text.strip():
        raise ApiError(422, "VALIDATION", "Cần nội dung để soạn trả lời", errors={"text": "Không được để trống"})
    subject = (r.subject_type, r.subject_id) if r.subject_type and r.subject_id else None
    tgt = None
    if r.group_id:
        ch = (await db.execute(text("SELECT type FROM core.channels WHERE id = (SELECT channel_id FROM core.groups "
                                    "WHERE id = :g)"), {"g": r.group_id})).scalar_one_or_none()
        if ch:
            tgt = drafts.Target(channel=ch, thread_type="group", group_id=r.group_id)
    label = qsvc.EVENT_LABELS.get(r.title, r.title)
    made = await drafts.create_draft(
        db, org_id=user.org_id, kind="message", title=f"Trả lời {label}",
        body_text=body.text, target=tgt, created_by=user.id, subject=subject,
        sources=[{"label": label, "ref": {"type": "meaning_unit", "id": str(item_id)}}],
        redis=request.app.state.redis)
    return {"ok": True, "draft": {"id": str(made["id"]), "code": made["code"], "status": made["status"]}}


class AssignIn(BaseModel):
    user_id: uuid.UUID


@router.post("/inbox/{item_id}/assign")
async def assign_inbox_item(item_id: uuid.UUID, body: AssignIn,
                            user: service.CurrentUser = Depends(require("queue.act")),
                            db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.act")
    r = await _load_item(db, user.org_id, sc, item_id)
    target = (await db.execute(text("""SELECT id, display_name FROM core.users
                                       WHERE id = :u AND org_id = :o AND is_active"""),
                               {"u": body.user_id, "o": user.org_id})).one_or_none()
    if target is None:
        raise not_found("Người dùng")
    await qsvc.assign(db, user.org_id, r.item_type, item_id, to_user=body.user_id, by_user=user.id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="queue.assigned", target_type=r.item_type, target_id=str(item_id),
                           target_label=r.title, result="ok", detail={"to": str(body.user_id)})
    return {"ok": True, "assigned_to": {"id": str(target.id), "name": target.display_name}}


class SilenceIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)
    until: str | None = None


@router.post("/inbox/{item_id}/silence")
async def silence_inbox_item(item_id: uuid.UUID, body: SilenceIn | None = None,
                             user: service.CurrentUser = Depends(require("queue.act")),
                             db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.act")
    r = await _load_item(db, user.org_id, sc, item_id)
    body = body or SilenceIn()
    await qsvc.silence(db, user.org_id, r.item_type, item_id, user_id=user.id, reason=body.reason, until=body.until)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="queue.silenced", target_type=r.item_type, target_id=str(item_id),
                           target_label=r.title, result="ok", detail={"reason": body.reason, "until": body.until})
    return {"ok": True}


# ─── Tổng quan điều hành ───────────────────────────────────────────────────

QUEUE_WIDGET_LIMIT = 20
SPOTLIGHT_LIMIT = 5
SIGNALS_LIMIT = 5


def _kpi(key: str, label: str, value: Any, *, unit: str | None = None, row: int = 1, status: str = "ok",
        sublabel: str | None = None, pct: float | None = None, screen: str | None = None,
        filters: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"key": key, "label": label, "value": value, "unit": unit, "row": row, "status": status,
            "sublabel": sublabel, "pct": pct,
            "filter": {"screen": screen, "filters": filters or {}} if screen else None}


async def _queue_widget(db: AsyncSession, user: service.CurrentUser, sc: Scope) -> list[dict[str, Any]]:
    """Khối "Hàng đợi cần xử lý" của Tổng quan: cơ hội mới / cảnh báo / chờ duyệt / đến hạn, ưu tiên trước."""
    where2, params2 = qsvc.item_scope_sql(sc, "i")
    qrows = (await db.execute(text(f"""
        SELECT i.item_type, i.item_id, i.code, i.title, i.priority, i.created_at
        FROM biz.inbox_items i
        WHERE i.org_id = :o AND {where2} AND {qsvc.not_silenced_sql("i")}
          AND (i.item_type IN ('alert', 'draft') OR (i.item_type = 'unit' AND i.title = ANY(CAST(:opp AS text[]))))
        ORDER BY CASE i.priority WHEN 'P1' THEN 0 WHEN 'P2' THEN 1 ELSE 2 END, i.created_at DESC
        LIMIT :n"""), {"o": user.org_id, "opp": OPP_EVENTS, "n": QUEUE_WIDGET_LIMIT, **params2})).all()  # noqa: S608
    tw, tp = sc.subject_sql("t.subject_type", "t.subject_id") if not sc.is_all else ("TRUE", {})
    uw, up = sc.user_sql("t.assignee_user_id") if not sc.is_all else ("TRUE", {})
    tcond = "TRUE" if sc.is_all else f"({tw} OR {uw})"
    trows = (await db.execute(text(f"""
        SELECT t.id, t.code, t.title, t.priority, t.due_at FROM biz.tasks t
        WHERE t.org_id = :o AND t.status NOT IN ('done', 'cancelled') AND t.due_at IS NOT NULL
          AND t.due_at < now() + interval '2 days' AND {tcond}
        ORDER BY t.due_at LIMIT :n"""), {"o": user.org_id, "n": QUEUE_WIDGET_LIMIT, **tp, **up})).all()  # noqa: S608
    out = [{"kind": {"alert": "alert", "draft": "draft"}.get(r.item_type, "opportunity"),
            "id": str(r.item_id), "code": r.code,
            "title": qsvc.EVENT_LABELS.get(r.title, r.title) if r.item_type == "unit" else r.title,
            "priority": r.priority, "at": iso(r.created_at), "due_at": None} for r in qrows]
    out += [{"kind": "due", "id": str(t.id), "code": t.code, "title": t.title,
             "priority": t.priority, "at": None, "due_at": iso(t.due_at)} for t in trows]
    return out


async def _spotlight(db: AsyncSession, user: service.CurrentUser, sc: Scope) -> list[dict[str, Any]]:
    where, params = sc.person_sql("p")
    rows = (await db.execute(text(f"""
        SELECT p.id, p.code, p.display_name AS name, p.person_type AS type, p.organization_name AS org_name,
               cs.dimension, cs.value, cs.updated_at
        FROM clean.current_scores cs JOIN core.persons p ON p.id = cs.subject_id
        WHERE cs.subject_type = 'person' AND p.org_id = :o AND p.deleted_at IS NULL AND p.merged_into_id IS NULL
          AND cs.dimension IN ('heat', 'churn_risk') AND {where}
        ORDER BY cs.value DESC, cs.updated_at DESC LIMIT :n"""),  # noqa: S608
        {"o": user.org_id, "n": SPOTLIGHT_LIMIT, **params})).all()
    owner = user.role_code == rbac.OWNER
    return [{"person": {"id": str(r.id), "code": r.code, "name": mask_text(r.name, owner), "type": r.type,
                        "org_name": r.org_name},
             "dimension": r.dimension, "value": float(r.value), "at": iso(r.updated_at)} for r in rows]


async def _signals(db: AsyncSession, user: service.CurrentUser, sc: Scope) -> list[dict[str, Any]]:
    where, params = sc.person_id_sql("mu.person_id") if not sc.is_all else ("TRUE", {})
    gwhere, gparams = sc.group_id_sql("mu.group_id") if not sc.is_all else ("TRUE", {})
    scope_cond = "TRUE" if sc.is_all else f"({where} OR {gwhere})"
    rows = (await db.execute(text(f"""
        SELECT entities->>'product' AS topic,
               count(*) FILTER (WHERE observed_at > now() - interval '7 days') AS this_week,
               count(*) FILTER (WHERE observed_at <= now() - interval '7 days'
                                 AND observed_at > now() - interval '14 days') AS last_week
        FROM clean.meaning_units mu
        WHERE mu.org_id = :o AND mu.superseded_by IS NULL AND entities->>'product' IS NOT NULL
          AND mu.observed_at > now() - interval '14 days' AND {scope_cond}
        GROUP BY 1 ORDER BY this_week DESC LIMIT :n"""),  # noqa: S608
        {"o": user.org_id, "n": SIGNALS_LIMIT, **params, **gparams})).all()
    out = []
    for r in rows:
        delta = (float(r.this_week - r.last_week) / r.last_week * 100) if r.last_week else None
        out.append({"topic": r.topic, "count": r.this_week,
                    "delta_pct": round(delta, 1) if delta is not None else None})
    return out


async def _health(db: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    channels = (await db.execute(text("""
        SELECT c.type, count(*) FILTER (WHERE s.state = 'active') AS active
        FROM core.channels c LEFT JOIN core.channel_sessions s ON s.channel_id = c.id AND s.ended_at IS NULL
        WHERE c.org_id = :o GROUP BY c.type"""), {"o": org_id})).all()
    plugins = (await db.execute(text("""
        SELECT count(*) FILTER (WHERE b.state IS NULL OR b.state = 'closed') AS healthy,
               count(*) FILTER (WHERE b.state = 'half_open') AS degraded,
               count(*) FILTER (WHERE b.state = 'open') AS isolated
        FROM ops.plugins p LEFT JOIN LATERAL (
          SELECT state FROM ops.breaker_events WHERE plugin_id = p.id ORDER BY at DESC LIMIT 1) b ON true
        WHERE p.is_enabled"""))).one()
    backlog = (await db.execute(text("""SELECT count(*) FROM refinery.event_state
                                        WHERE org_id = :o AND state = 'pending'
                                          AND updated_at < now() - interval '10 minutes'"""),
                                {"o": org_id})).scalar_one()
    return {"channels": [{"type": c.type, "active": c.active} for c in channels],
            "plugins": {"healthy": plugins.healthy, "degraded": plugins.degraded, "isolated": plugins.isolated},
            "backlog_pending": backlog}


async def _data_quality(db: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    persons = (await db.execute(text("""
        SELECT count(*) AS total, count(*) FILTER (
          WHERE NOT EXISTS (SELECT 1 FROM core.person_identities pi WHERE pi.person_id = p.id)) AS missing_identity
        FROM core.persons p WHERE p.org_id = :o AND p.deleted_at IS NULL AND p.merged_into_id IS NULL"""),
        {"o": org_id})).one()
    scores = (await db.execute(text("""
        SELECT count(*) AS total, count(*) FILTER (WHERE s.confidence < 0.6) AS low
        FROM clean.current_scores cs LEFT JOIN clean.score_snapshots s ON s.id = cs.snapshot_id
        WHERE cs.subject_type IN ('person', 'group')
          AND EXISTS (SELECT 1 FROM core.organizations o WHERE o.id = :o)"""), {"o": org_id})).one()
    events = (await db.execute(text("""
        SELECT count(*) AS total,
               count(*) FILTER (WHERE sender_identity_id IS NULL AND group_id IS NULL) AS unassigned
        FROM raw.events e
        WHERE e.org_id = :o AND e.occurred_at > now() - interval '7 days'"""), {"o": org_id})).one()

    def pct(n: int, d: int) -> float:
        return round(n / d * 100, 1) if d else 0.0
    return {"missing_identity_pct": pct(persons.missing_identity, persons.total),
            "low_confidence_score_pct": pct(scores.low, scores.total),
            "unassigned_event_pct": pct(events.unassigned, events.total)}


async def _hourly(db: AsyncSession, org_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""
        SELECT date_trunc('hour', e.occurred_at) AS h, count(*) AS n
        FROM raw.events e
        WHERE e.org_id = :o AND e.occurred_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1"""),
        {"o": org_id})).all()
    return [{"hour": iso(r.h), "count": r.n} for r in rows]


@router.get("/overview")
async def overview(user: service.CurrentUser = Depends(require("overview.read")),
                   db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "overview.read")
    org = user.org_id
    channels_live = (await db.execute(text("""SELECT count(DISTINCT c.id) FROM core.channels c
        JOIN core.channel_sessions s ON s.channel_id = c.id
        WHERE c.org_id = :o AND s.state = 'active' AND s.ended_at IS NULL"""), {"o": org})).scalar_one()
    groups_listening = (await db.execute(text("""SELECT count(*) FROM core.groups
        WHERE org_id = :o AND listen_mode NOT IN ('off', 'paused')"""), {"o": org})).scalar_one()
    # Giai đoạn 5.5 (benchmark 10 triệu raw.events, p95 < 150ms): lọc trực tiếp e.org_id (cột đã có sẵn, ghi ở
    # gh/data/ingest.py lúc chèn) thay vì JOIN core.channels — org_id của event LUÔN bằng org_id của kênh, nên
    # kết quả giống hệt, nhưng dùng được chỉ mục (org_id, occurred_at DESC) (migration 0013) mà không cần JOIN.
    events_today = (await db.execute(text(
        "SELECT count(*) FROM raw.events e WHERE e.org_id = :o AND e.occurred_at > now() - interval '24 hours'"),
        {"o": org})).scalar_one()
    health = await _health(db, org)
    latency = (await db.execute(text("""SELECT avg(extract(epoch FROM finished_at - started_at)) FROM (
        SELECT finished_at, started_at FROM refinery.runs WHERE org_id = :o AND status = 'done'
        ORDER BY started_at DESC LIMIT 20) x"""), {"o": org})).scalar_one()
    pending = (await db.execute(text("""SELECT count(*) FILTER (WHERE status = 'pending') AS p, count(*) AS a
        FROM biz.action_drafts WHERE org_id = :o AND created_at > now() - interval '30 days'"""),
        {"o": org})).one()
    pending_ratio = round(pending.p / pending.a * 100, 1) if pending.a else 0.0

    time_to_contact = (await db.execute(text("""
        SELECT percentile_cont(0.5) WITHIN GROUP (
          ORDER BY extract(epoch FROM first_contact_at - first_signal_at) / 60)
        FROM biz.opportunities WHERE org_id = :o AND first_contact_at IS NOT NULL
          AND first_signal_at > now() - interval '90 days'"""), {"o": org})).scalar_one()
    quotations_sent = (await db.execute(text("""SELECT count(*) FROM biz.action_drafts
        WHERE org_id = :o AND kind = 'quotation' AND status = 'sent'
          AND created_at > now() - interval '30 days'"""), {"o": org})).scalar_one()
    opp_claim = (await db.execute(text("""SELECT count(*) AS total,
        count(*) FILTER (WHERE owner_user_id IS NOT NULL) AS claimed
        FROM biz.opportunities WHERE org_id = :o AND closed_at IS NULL"""), {"o": org})).one()
    claim_rate = round(opp_claim.claimed / opp_claim.total * 100, 1) if opp_claim.total else 0.0
    active_profiles = (await db.execute(text("""SELECT count(DISTINCT person_id) FROM clean.meaning_units
        WHERE org_id = :o AND person_id IS NOT NULL AND observed_at > now() - interval '30 days'"""),
        {"o": org})).scalar_one()

    kpis = [
        _kpi("channels_live", "Kênh sống", channels_live, row=1, screen="system"),
        _kpi("groups_listening", "Nhóm đang lắng nghe", groups_listening, row=1, screen="directory"),
        _kpi("events_today", "Sự kiện / ngày", events_today, row=1, screen="raw"),
        _kpi("plugins_health", "Plugin lành mạnh", health["plugins"]["healthy"], row=1, screen="plugins",
             sublabel=f"suy giảm {health['plugins']['degraded']} · cách ly {health['plugins']['isolated']}",
             status="warn" if health["plugins"]["isolated"] else "ok"),
        _kpi("processing_latency", "Độ trễ xử lý", round(float(latency), 1) if latency is not None else None,
             unit="giây", row=1, screen="rules"),
        _kpi("pending_ratio", "Tỉ lệ chờ duyệt", pending_ratio, unit="%", row=1, screen="workbench",
             filters={"status": "pending"}),
        _kpi("time_to_contact", "Tín hiệu → tiếp cận (trung vị)",
             round(float(time_to_contact), 1) if time_to_contact is not None else None, unit="phút", row=2,
             screen="opportunity"),
        _kpi("quotations_sent", "Báo giá đã gửi (30 ngày)", quotations_sent, row=2, screen="workbench",
             filters={"kind": "quotation"}),
        _kpi("opportunity_claim_rate", "Tỉ lệ cơ hội được nhận", claim_rate, unit="%", row=2, screen="opportunity",
             filters={"owner": "none"}),
        _kpi("chassis_latency", "Độ trễ xử lý chassis", round(float(latency), 1) if latency is not None else None,
             unit="giây", row=2, screen="rules"),
        _kpi("active_profiles", "Hồ sơ active (30 ngày)", active_profiles, row=2, screen="directory"),
    ]
    return {"kpis": kpis, "queue": await _queue_widget(db, user, sc), "spotlight": await _spotlight(db, user, sc),
            "signals": await _signals(db, user, sc), "health": health, "dataQuality": await _data_quality(db, org),
            "hourly": await _hourly(db, org)}


# ─── Việc & Nhắc hẹn ────────────────────────────────────────────────────────

def _task_scope(sc: Scope) -> tuple[str, dict[str, Any]]:
    if sc.is_all:
        return "TRUE", {}
    sw, sp = sc.subject_sql("t.subject_type", "t.subject_id")
    uw, up = sc.user_sql("t.assignee_user_id")
    return f"({sw} OR {uw})", {**sp, **up}


def _task_payload(r: Any) -> dict[str, Any]:
    overdue = bool(r.due_at and r.status not in ("done", "cancelled") and r.due_at < datetime.now(UTC))
    return {"id": str(r.id), "code": r.code, "title": r.title, "priority": r.priority, "status": r.status,
            "assignee": {"id": str(r.assignee_user_id), "name": r.assignee_name} if r.assignee_user_id else None,
            "subject": qsvc.subject_ref(r), "due_at": iso(r.due_at), "remind_at": iso(r.remind_at),
            "overdue": overdue, "source": r.source, "created_at": iso(r.created_at),
            "completed_at": iso(r.completed_at)}


_TASK_SELECT = """
SELECT t.*, u.display_name AS assignee_name,
       p.id AS p_id, p.code AS p_code, p.display_name AS p_name, p.person_type AS p_type, p.organization_name AS p_org,
       g.id AS g_id, g.code AS g_code, g.name AS g_name, gc.type AS g_channel
FROM biz.tasks t
LEFT JOIN core.users u ON u.id = t.assignee_user_id
LEFT JOIN core.persons p ON t.subject_type = 'person' AND p.id = t.subject_id
LEFT JOIN core.groups g ON t.subject_type = 'group' AND g.id = t.subject_id
LEFT JOIN core.channels gc ON gc.id = g.channel_id
"""


@router.get("/tasks")
async def list_tasks(status: str | None = None, priority: str | None = None, overdue: bool | None = None,
                     assignee_user_id: uuid.UUID | None = None, cursor: str | None = None,
                     limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(current_user),
                     db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.read")
    where, params = _task_scope(sc)
    conds = [f"t.org_id = :o AND {where}"]
    if status:
        conds.append("t.status = :s")
    if priority:
        conds.append("t.priority = :p")
    if overdue:
        conds.append("t.due_at IS NOT NULL AND t.due_at < now() AND t.status NOT IN ('done', 'cancelled')")
    if assignee_user_id:
        conds.append("t.assignee_user_id = :a")
    if cursor:
        conds.append("t.created_at < :c")
    sql_where = " AND ".join(conds)
    base = {"o": user.org_id, "s": status, "p": priority, "a": assignee_user_id, "c": qsvc.when(cursor), **params}
    total = (await db.execute(text(f"SELECT count(*) FROM biz.tasks t WHERE {sql_where}"), base)).scalar_one()  # noqa: S608
    rows = (await db.execute(text(_TASK_SELECT + f" WHERE {sql_where} ORDER BY t.created_at DESC LIMIT :n"),  # noqa: S608
                             {**base, "n": limit + 1})).all()
    items = [_task_payload(r) for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].created_at) if len(rows) > limit else None,
            "total": total}


# ─── Lời hứa ────────────────────────────────────────────────────────────────
# Đặt trước `/tasks/{task_id}` (đăng ký dưới): FastAPI/Starlette khớp route theo thứ tự đăng ký, đường tĩnh
# `/tasks/promises` phải đứng trước đường động để không bị nuốt bởi `{task_id}`.

_PROMISE_SELECT = """
SELECT pr.id, pr.text, pr.due_at, pr.kept_at, pr.broken, pr.meaning_unit_id,
       fp.id AS from_id, fp.code AS from_code, fp.display_name AS from_name, fp.person_type AS from_type,
       fp.organization_name AS from_org,
       tp.id AS to_id, tp.code AS to_code, tp.display_name AS to_name, tp.person_type AS to_type,
       tp.organization_name AS to_org
FROM biz.promises pr
JOIN core.persons fp ON fp.id = pr.promiser_person_id
LEFT JOIN core.persons tp ON tp.id = pr.to_person_id
"""


def _promise_payload(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "text": r.text, "due_at": iso(r.due_at), "kept_at": iso(r.kept_at),
            "broken": bool(r.broken) if r.broken is not None else (
                r.kept_at is None and r.due_at < datetime.now(UTC)),
            "from": qsvc.person_ref(r, "from"), "to": qsvc.person_ref(r, "to"),
            "evidence": {"type": "meaning_unit", "id": str(r.meaning_unit_id)} if r.meaning_unit_id else None}


@router.get("/tasks/promises")
async def list_promises(status: Literal["upcoming", "overdue", "kept", "all"] = "upcoming", cursor: str | None = None,
                        limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(current_user),
                        db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.read")
    pw, pp = sc.person_sql("fp")
    tw, tpar = sc.person_sql("tp")
    conds = [f"pr.org_id = :o AND ({pw} OR {tw} OR tp.id IS NULL)"]
    if status == "upcoming":
        conds.append("pr.kept_at IS NULL AND pr.due_at >= now() AND pr.due_at < now() + interval '3 days'")
    elif status == "overdue":
        conds.append("pr.kept_at IS NULL AND pr.due_at < now()")
    elif status == "kept":
        conds.append("pr.kept_at IS NOT NULL")
    if cursor:
        conds.append("pr.due_at > :c")
    sql_where = " AND ".join(conds)
    base = {"o": user.org_id, "c": qsvc.when(cursor), **pp, **tpar}
    total = (await db.execute(text(f"SELECT count(*) FROM biz.promises pr JOIN core.persons fp "  # noqa: S608
                                   f"ON fp.id = pr.promiser_person_id LEFT JOIN core.persons tp "
                                   f"ON tp.id = pr.to_person_id WHERE {sql_where}"), base)).scalar_one()
    rows = (await db.execute(text(_PROMISE_SELECT + f" WHERE {sql_where} ORDER BY pr.due_at LIMIT :n"),  # noqa: S608
                             {**base, "n": limit + 1})).all()
    items = [_promise_payload(r) for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].due_at) if len(rows) > limit else None,
            "total": total}


class PromisePatch(BaseModel):
    kept: bool


@router.patch("/tasks/promises/{promise_id}")
async def patch_promise(promise_id: uuid.UUID, body: PromisePatch,
                        user: service.CurrentUser = Depends(require("queue.act")),
                        db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.act")
    pw, pp = sc.person_sql("fp")
    tw, tpar = sc.person_sql("tp")
    r = (await db.execute(text(_PROMISE_SELECT + f" WHERE pr.id = :i AND pr.org_id = :o AND ({pw} OR {tw} "  # noqa: S608
                               f"OR tp.id IS NULL)"), {"i": promise_id, "o": user.org_id, **pp, **tpar})).one_or_none()
    if r is None:
        raise not_found("Lời hứa")
    await db.execute(text("""UPDATE biz.promises SET kept_at = CASE WHEN :kept THEN now() ELSE NULL END,
                             broken = NOT :kept WHERE id = :i"""), {"kept": body.kept, "i": promise_id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="promise.kept" if body.kept else "promise.broken", target_type="promise",
                           target_id=str(promise_id), target_label=r.text[:200], result="ok")
    return {"ok": True}


async def _visible_task(db: AsyncSession, sc: Scope, task_id: uuid.UUID, org_id: uuid.UUID) -> Any:
    where, params = _task_scope(sc)
    r = (await db.execute(text(_TASK_SELECT + f" WHERE t.id = :i AND t.org_id = :o AND {where}"),  # noqa: S608
                          {"i": task_id, "o": org_id, **params})).one_or_none()
    if r is None:
        raise not_found("Việc")
    return r


@router.get("/tasks/{task_id}")
async def get_task(task_id: uuid.UUID, user: service.CurrentUser = Depends(current_user),
                   db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.read")
    r = await _visible_task(db, sc, task_id, user.org_id)
    return _task_payload(r)


class TaskIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    priority: Literal["P1", "P2", "P3"] = "P3"
    assignee_user_id: uuid.UUID | None = None
    subject: dict[str, Any] | None = None
    due_at: str | None = None
    remind_at: str | None = None


@router.post("/tasks", status_code=201)
async def create_task(body: TaskIn, user: service.CurrentUser = Depends(require("queue.act")),
                      db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.act")
    subject = None
    if body.subject:
        try:
            subject = (str(body.subject["type"]), uuid.UUID(str(body.subject["id"])))
        except (KeyError, ValueError) as e:
            raise ApiError(422, "VALIDATION", "Đối tượng không hợp lệ") from e
        if subject[0] == "person":
            await ensure_person(db, sc, subject[1])
        elif subject[0] == "group":
            await ensure_group(db, sc, subject[1])
    code = (await db.execute(text("SELECT core.next_code('TSK')"))).scalar_one()
    row = (await db.execute(text("""
        INSERT INTO biz.tasks (org_id, code, title, priority, status, assignee_user_id, subject_type, subject_id,
                               due_at, remind_at, source)
        VALUES (:o, :c, :t, :p, 'todo', :u, :st, :si, :d, :r, 'manual')
        RETURNING id"""),
        {"o": user.org_id, "c": code, "t": body.title, "p": body.priority, "u": body.assignee_user_id,
         "st": subject[0] if subject else None, "si": subject[1] if subject else None,
         "d": qsvc.when(body.due_at), "r": qsvc.when(body.remind_at)})).one()
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="task.created",
                           target_type="task", target_id=str(row.id), target_label=body.title, result="ok")
    return await get_task(row.id, user, db)


class TaskPatch(BaseModel):
    status: Literal["todo", "doing", "done", "cancelled"] | None = None
    priority: Literal["P1", "P2", "P3"] | None = None
    assignee_user_id: uuid.UUID | None = None
    due_at: str | None = None
    remind_at: str | None = None


@router.patch("/tasks/{task_id}")
async def patch_task(task_id: uuid.UUID, body: TaskPatch, user: service.CurrentUser = Depends(require("queue.act")),
                     db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "queue.act")
    await _visible_task(db, sc, task_id, user.org_id)
    fields: list[str] = []
    params: dict[str, Any] = {"i": task_id}
    if body.status is not None:
        fields.append("status = :status")
        params["status"] = body.status
        fields.append("completed_at = CASE WHEN :status = 'done' THEN now() ELSE completed_at END")
    if body.priority is not None:
        fields.append("priority = :priority")
        params["priority"] = body.priority
    if "assignee_user_id" in body.model_fields_set:
        fields.append("assignee_user_id = :assignee")
        params["assignee"] = body.assignee_user_id
    if body.due_at is not None:
        fields.append("due_at = :due")
        params["due"] = qsvc.when(body.due_at)
    if body.remind_at is not None:
        fields.append("remind_at = :remind")
        params["remind"] = qsvc.when(body.remind_at)
    if fields:
        await db.execute(text(f"UPDATE biz.tasks SET {', '.join(fields)} WHERE id = :i"), params)  # noqa: S608
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="task.updated", target_type="task", target_id=str(task_id), result="ok",
                               detail={k: str(v) for k, v in params.items() if k != "i"})
    return await get_task(task_id, user, db)


# ─── chứng cứ: đăng ký kind "task" ──────────────────────────────────────────

async def _explain_task(db: AsyncSession, user: service.CurrentUser, sc: Scope, id: str) -> dict[str, Any]:
    try:
        tid = uuid.UUID(id)
    except ValueError as e:
        raise not_found("Việc") from e
    r = (await db.execute(text("""SELECT id, code, title, subject_type, subject_id, assignee_user_id
                                  FROM biz.tasks WHERE id = :i AND org_id = :o"""),
                          {"i": tid, "o": user.org_id})).one_or_none()
    if r is None:
        raise not_found("Việc")
    if not sc.is_all and r.assignee_user_id not in sc.users:
        if r.subject_type == "person" and r.subject_id:
            await ensure_person(db, sc, r.subject_id)          # 404 nếu ngoài phạm vi
        elif r.subject_type == "group" and r.subject_id:
            await ensure_group(db, sc, r.subject_id)
        else:
            raise not_found("Việc")
    owner = user.role_code == rbac.OWNER
    return explain.payload("task", id, f"{r.code} · {mask_text(r.title, owner)}", "Việc & Nhắc hẹn", method="manual")


explain.register("task", "queue.read", _explain_task)
