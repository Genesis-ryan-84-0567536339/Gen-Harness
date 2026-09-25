"""API Quan hệ & Đối tượng (docs/api/phase-3-relations.md): Nhóm & Con người, Hồ sơ sống, Sổ tay nhận thức,
Tài liệu. Nền chung: `docs/api/phase-3.md` (PersonRef/GroupRef/Score/EvidenceRef, ScopeFilter, chứng cứ).

Sổ tay nhận thức: lõi ghi/nén đã có ở `gh.memory.notebook` (giai đoạn 2) — cụm này chỉ là lớp API đọc/ghim/
sửa/xoá/nén ngay/đặt lại, có kiểm phạm vi (`gh.biz.core.scope`), khác với `gh.data_api.routes` (kỹ thuật, chỉ
`data.read`/không lọc phạm vi theo người/nhóm) — hai lớp API cùng đọc một engine cho hai màn khác nhau.
"""

import base64
import urllib.parse
import uuid
from typing import Any, Literal

import orjson
from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import require
from gh.biz.core import explain
from gh.biz.core.scope import Scope, ensure_group, ensure_person, not_found, scope_for
from gh.biz.relations import service as rsvc
from gh.chassis import actionlog
from gh.chassis.objects import ObjectNotFound, content_hash, get_object_store, new_key
from gh.data.common import iso, mask_text, parse_cursor
from gh.db import DB
from gh.errors import ApiError
from gh.memory import notebook

router = APIRouter(tags=["relations"])

READ = require("profile.read")
WRITE = require("profile.write")


# ═══ Nhóm & Con người (directory) ═══════════════════════════════════════════

@router.get("/directory/channels")
async def list_channels(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""
        SELECT c.id, c.type, c.name,
               (SELECT s.state FROM core.channel_sessions s WHERE s.channel_id = c.id
                ORDER BY COALESCE(s.started_at, s.qr_issued_at) DESC NULLS LAST LIMIT 1) AS state,
               (SELECT count(*) FROM core.groups g WHERE g.channel_id = c.id) AS group_count,
               (SELECT count(*) FROM raw.events e WHERE e.channel_id = c.id
                AND e.occurred_at > now() - interval '24 hours') AS events_24h
        FROM core.channels c WHERE c.org_id = :o ORDER BY c.type"""), {"o": user.org_id})).all()
    return [{"id": str(r.id), "type": r.type, "name": r.name, "state": r.state, "group_count": r.group_count,
             "events_24h": r.events_24h} for r in rows]


_GROUP_SELECT = """
SELECT g.id, g.code, g.name, g.kind, g.listen_mode, g.member_count, g.created_at,
       c.type AS channel_type, c.name AS channel_name, ag.id AS agent_id, ag.name AS agent_name,
       (SELECT count(*) FROM raw.events e WHERE e.group_id = g.id
        AND e.occurred_at > now() - interval '24 hours') AS events_24h,
       cs.value AS heat
FROM core.groups g
JOIN core.channels c ON c.id = g.channel_id
LEFT JOIN agent.identities ag ON ag.id = g.assigned_agent_id
LEFT JOIN clean.current_scores cs ON cs.subject_type = 'group' AND cs.subject_id = g.id AND cs.dimension = 'heat'
"""


def _group_payload(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "code": r.code, "name": r.name, "kind": r.kind, "listen_mode": r.listen_mode,
            "member_count": r.member_count, "events_24h": r.events_24h,
            "heat": float(r.heat) if r.heat is not None else None,
            "channel": {"type": r.channel_type, "name": r.channel_name},
            "bot": rsvc.agent_ref(r.agent_id, r.agent_name), "created_at": iso(r.created_at)}


@router.get("/directory/groups")
async def list_groups(channel_id: uuid.UUID | None = None, kind: str | None = None, listen_mode: str | None = None,
                      cursor: str | None = None, limit: int = Query(50, ge=1, le=200),
                      user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    where, params = sc.group_sql("g")
    conds = [f"g.org_id = :o AND {where}"]
    if channel_id:
        conds.append("g.channel_id = :ch")
    if kind:
        conds.append("g.kind = :k")
    if listen_mode:
        conds.append("g.listen_mode = :lm")
    if cursor:
        conds.append("g.created_at < :c")
    sql_where = " AND ".join(conds)
    base = {"o": user.org_id, "ch": channel_id, "k": kind, "lm": listen_mode, "c": parse_cursor(cursor), **params}
    total = (await db.execute(text(f"SELECT count(*) FROM core.groups g WHERE {sql_where}"),  # noqa: S608
                              base)).scalar_one()
    rows = (await db.execute(text(_GROUP_SELECT + f" WHERE {sql_where} ORDER BY g.created_at DESC LIMIT :n"),  # noqa: S608
                             {**base, "n": limit + 1})).all()
    items = [_group_payload(r) for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].created_at) if len(rows) > limit else None,
            "total": total}


class GroupBotIn(BaseModel):
    agent_id: uuid.UUID | None = None
    autonomy_level: int | None = Field(default=None, ge=0, le=6)


@router.post("/directory/groups/{group_id}/bot")
async def set_group_bot(group_id: uuid.UUID, body: GroupBotIn, user: service.CurrentUser = Depends(WRITE),
                        db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    await ensure_group(db, sc, group_id)
    await rsvc.set_group_bot(db, group_id, agent_id=body.agent_id, autonomy_level=body.autonomy_level,
                             set_autonomy="autonomy_level" in body.model_fields_set)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="directory.group_bot_set", target_type="group", target_id=str(group_id),
                           result="ok", detail={"agent_id": str(body.agent_id) if body.agent_id else None,
                                                 "autonomy_level": body.autonomy_level}, ip=user.ip)
    return {"ok": True}


_PEOPLE_CTE = """
WITH rows AS (
  SELECT p.id, p.code, p.display_name AS name, p.person_type AS type, p.organization_name AS org_name,
         p.relation_to_owner AS relation, p.attrs, p.created_at, p.owner_user_id,
         cs.value AS heat, cs.trend AS heat_trend,
         COALESCE(ov.value_vnd, 0) AS value_vnd,
         COALESCE(pr.pri_rank, 3) AS pri_rank,
         COALESCE(ch.channels, '{{}}') AS channels,
         ag.id AS agent_id, ag.name AS agent_name
  FROM core.persons p
  LEFT JOIN clean.current_scores cs ON cs.subject_type = 'person' AND cs.subject_id = p.id AND cs.dimension = 'heat'
  LEFT JOIN LATERAL (SELECT sum(o.value_vnd) AS value_vnd FROM biz.opportunities o
                      WHERE o.person_id = p.id AND o.closed_at IS NULL) ov ON true
  LEFT JOIN LATERAL (SELECT min(CASE i.priority WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 ELSE 3 END) AS pri_rank
                      FROM biz.inbox_items i WHERE i.person_id = p.id) pr ON true
  LEFT JOIN LATERAL (SELECT array_agg(DISTINCT ch2.type) AS channels FROM core.person_identities pi2
                      JOIN core.channels ch2 ON ch2.id = pi2.channel_id WHERE pi2.person_id = p.id) ch ON true
  LEFT JOIN agent.identities ag ON (p.attrs->>'agent_id') IS NOT NULL AND ag.id = (p.attrs->>'agent_id')::uuid
  WHERE p.org_id = :o AND p.deleted_at IS NULL AND p.merged_into_id IS NULL AND {scope}
)
"""
PRI_LABEL = {1: "P1", 2: "P2", 3: "P3"}


def _person_row(r: Any, *, owner: bool) -> dict[str, Any]:
    autonomy = r.attrs.get("autonomy_level") if r.attrs else None
    return {"id": str(r.id), "code": r.code, "name": mask_text(r.name, owner), "type": r.type,
            "org_name": r.org_name, "relation": r.relation, "channels": list(r.channels or []),
            "heat": float(r.heat) if r.heat is not None else None, "heat_trend": r.heat_trend,
            "value_vnd": int(r.value_vnd) if r.value_vnd else None, "priority": PRI_LABEL[r.pri_rank],
            "bot": rsvc.agent_ref(r.agent_id, r.agent_name), "autonomy_level": autonomy,
            "owner_user_id": str(r.owner_user_id) if r.owner_user_id else None}


@router.get("/directory/people")
async def list_people(relation: str | None = None, heat: Literal["high", "mid", "cold"] | None = None,
                      value: Literal["high", "mid", "unknown"] | None = None,
                      priority: Literal["P1", "P2", "P3"] | None = None,
                      bot: Literal["assigned", "unassigned"] | None = None, cursor: str | None = None,
                      limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(READ),
                      db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    where, params = sc.person_sql("p")
    conds = ["TRUE"]
    if relation:
        conds.append("relation = :rel")
    if heat == "high":
        conds.append("heat >= 80")
    elif heat == "mid":
        conds.append("heat >= 50 AND heat < 80")
    elif heat == "cold":
        conds.append("(heat IS NULL OR heat < 50)")
    if value == "high":
        conds.append("value_vnd >= 500000000")
    elif value == "mid":
        conds.append("value_vnd >= 100000000 AND value_vnd < 500000000")
    elif value == "unknown":
        conds.append("value_vnd = 0")
    if priority:
        conds.append("pri_rank = :prirank")
    if bot == "assigned":
        conds.append("(attrs->>'agent_id') IS NOT NULL")
    elif bot == "unassigned":
        conds.append("(attrs->>'agent_id') IS NULL")
    if cursor:
        conds.append("created_at < :c")
    filt = " AND ".join(conds)
    prirank = {"P1": 1, "P2": 2, "P3": 3}.get(priority) if priority else None
    base = {"o": user.org_id, "rel": relation, "prirank": prirank, "c": parse_cursor(cursor), **params}
    cte = _PEOPLE_CTE.format(scope=where)
    total = (await db.execute(text(cte + f" SELECT count(*) FROM rows WHERE {filt}"), base)).scalar_one()  # noqa: S608
    rows = (await db.execute(text(cte + f" SELECT * FROM rows WHERE {filt} ORDER BY created_at DESC LIMIT :n"),  # noqa: S608
                             {**base, "n": limit + 1})).all()
    owner = user.role_code == rbac.OWNER
    items = [_person_row(r, owner=owner) for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].created_at) if len(rows) > limit else None,
            "total": total}


class PersonBotIn(BaseModel):
    agent_id: uuid.UUID | None = None
    autonomy_level: int | None = Field(default=None, ge=0, le=6)


@router.post("/directory/people/{person_id}/bot")
async def set_person_bot(person_id: uuid.UUID, body: PersonBotIn, user: service.CurrentUser = Depends(WRITE),
                         db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    await ensure_person(db, sc, person_id)
    await rsvc.set_person_bot(db, person_id, agent_id=body.agent_id, set_agent="agent_id" in body.model_fields_set,
                              autonomy_level=body.autonomy_level,
                              set_autonomy="autonomy_level" in body.model_fields_set)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="directory.bot_assigned", target_type="person", target_id=str(person_id),
                           result="ok", detail={"agent_id": str(body.agent_id) if body.agent_id else None,
                                                 "autonomy_level": body.autonomy_level}, ip=user.ip)
    return {"ok": True}


# ═══ Hồ sơ sống (profile) ════════════════════════════════════════════════════

async def _person_or_404(db: AsyncSession, sc: Scope, person_id: uuid.UUID) -> Any:
    await ensure_person(db, sc, person_id)
    r = (await db.execute(text("""
        SELECT p.id, p.code, p.display_name AS name, p.person_type AS type, p.organization_name AS org_name,
               p.title, p.relation_to_owner, p.attrs, p.owner_user_id, u.display_name AS owner_name,
               ro.code AS owner_role
        FROM core.persons p LEFT JOIN core.users u ON u.id = p.owner_user_id
        LEFT JOIN LATERAL (SELECT r2.code FROM core.user_roles ur2 JOIN core.roles r2 ON r2.id = ur2.role_id
                            WHERE ur2.user_id = u.id ORDER BY r2.code LIMIT 1) ro ON true
        WHERE p.id = :i"""), {"i": person_id})).one_or_none()
    if r is None:
        raise not_found("Người")
    return r


@router.get("/profile/{person_id}")
async def get_profile(person_id: uuid.UUID, user: service.CurrentUser = Depends(READ),
                      db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    r = await _person_or_404(db, sc, person_id)
    owner = user.role_code == rbac.OWNER

    identities = (await db.execute(text("""
        SELECT pi.id, pi.external_id, pi.handle, pi.phone_e164, pi.first_seen_at, c.type AS channel_type,
               c.name AS channel_name
        FROM core.person_identities pi JOIN core.channels c ON c.id = pi.channel_id
        WHERE pi.person_id = :p ORDER BY pi.first_seen_at"""), {"p": person_id})).all()

    scores = (await db.execute(text("""
        SELECT dimension, value, trend, updated_at FROM clean.current_scores
        WHERE subject_type = 'person' AND subject_id = :p ORDER BY dimension"""), {"p": person_id})).all()

    timeline = (await db.execute(text("""
        SELECT mu.id, mu.event_type, mu.conclusion, mu.confidence, mu.observed_at,
               g.id AS g_id, g.code AS g_code, g.name AS g_name, gc.type AS g_channel
        FROM clean.meaning_units mu LEFT JOIN core.groups g ON g.id = mu.group_id
        LEFT JOIN core.channels gc ON gc.id = g.channel_id
        WHERE mu.org_id = :o AND mu.person_id = :p AND mu.superseded_by IS NULL
        ORDER BY mu.observed_at DESC LIMIT 30"""), {"o": user.org_id, "p": person_id})).all()

    docs = (await db.execute(text("""
        SELECT id, title, mime, bytes, created_at FROM biz.documents
        WHERE org_id = :o AND owner_person_id = :p AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT 20"""), {"o": user.org_id, "p": person_id})).all()

    touchpoints = (await db.execute(text("""
        SELECT DISTINCT u.id, u.display_name, ro.code AS role_code
        FROM ops.action_log a JOIN core.users u ON ('user:' || u.id::text) = a.actor_id
        LEFT JOIN core.user_roles ur ON ur.user_id = u.id LEFT JOIN core.roles ro ON ro.id = ur.role_id
        WHERE a.org_id = :o AND a.target_type = 'person' AND a.target_id = :p
        ORDER BY u.display_name LIMIT 12"""), {"o": user.org_id, "p": str(person_id)})).all()

    merges = (await db.execute(text("""
        SELECT id, op, from_person, to_person, identities, at, reverted_at
        FROM core.identity_merge_log WHERE org_id = :o AND (from_person = :p OR to_person = :p)
        ORDER BY at DESC LIMIT 20"""), {"o": user.org_id, "p": person_id})).all()

    def tone(event_type: str) -> str:
        if event_type in ("Complained", "MentionsCompetitor", "WentSilent"):
            return "bad"
        if event_type in ("AskedPrice", "OfferedSupply", "SentQuotation", "DealWon"):
            return "ok"
        return "neutral"

    return {
        "person": {"id": str(r.id), "code": r.code, "name": mask_text(r.name, owner), "type": r.type,
                   "org_name": r.org_name, "title": r.title, "relation_to_owner": r.relation_to_owner,
                   "owner": rsvc.user_ref(r.owner_user_id, r.owner_name, r.owner_role)},
        "autonomy_level": r.attrs.get("autonomy_level") if r.attrs else None,
        "bot": rsvc.agent_ref(uuid.UUID(r.attrs["agent_id"]), None) if r.attrs and r.attrs.get("agent_id") else None,
        "owner_note": r.attrs.get("owner_note") if r.attrs else None,
        "identities": [{"id": str(i.id), "channel": {"type": i.channel_type, "name": i.channel_name},
                        "external_id": i.external_id, "handle": i.handle,
                        "phone_e164": mask_text(i.phone_e164, owner), "first_seen_at": iso(i.first_seen_at)}
                       for i in identities],
        "scores": [{"dimension": s.dimension, "label": explain.DIMENSION_LABELS.get(s.dimension, s.dimension),
                    "value": float(s.value), "trend": s.trend, "updated_at": iso(s.updated_at)} for s in scores],
        "summary": [{"text": mask_text(t.conclusion, owner), "tone": tone(t.event_type),
                     "evidence": {"type": "meaning_unit", "id": str(t.id)}} for t in timeline[:5]],
        "timeline": [{"id": str(t.id), "event_type": t.event_type, "conclusion": mask_text(t.conclusion, owner),
                      "confidence": float(t.confidence), "observed_at": iso(t.observed_at),
                      "group": rsvc.group_ref(t, "g"),
                      "evidence": {"type": "meaning_unit", "id": str(t.id)}} for t in timeline],
        "documents": [{"id": str(d.id), "title": d.title, "mime": d.mime, "bytes": d.bytes,
                       "created_at": iso(d.created_at)} for d in docs],
        "touchpoints": [rsvc.user_ref(t.id, t.display_name, t.role_code) for t in touchpoints],
        "merge_history": [{"id": str(m.id), "op": m.op, "from_person": str(m.from_person),
                           "to_person": str(m.to_person), "identities": [str(i) for i in (m.identities or [])],
                           "at": iso(m.at), "reverted_at": iso(m.reverted_at)} for m in merges],
    }


class ProfilePatch(BaseModel):
    owner_user_id: uuid.UUID | None = None
    autonomy_level: int | None = Field(default=None, ge=0, le=6)
    note: str | None = Field(default=None, max_length=4000)


@router.patch("/profile/{person_id}")
async def patch_profile(person_id: uuid.UUID, body: ProfilePatch, user: service.CurrentUser = Depends(WRITE),
                        db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    await ensure_person(db, sc, person_id)
    fields = body.model_fields_set
    detail: dict[str, Any] = {}
    if "owner_user_id" in fields:
        if body.owner_user_id is not None:
            ok = (await db.execute(text("SELECT 1 FROM core.users WHERE id = :u AND org_id = :o AND is_active"),
                                   {"u": body.owner_user_id, "o": user.org_id})).first()
            if ok is None:
                raise not_found("Người dùng")
        await db.execute(text("UPDATE core.persons SET owner_user_id = :u, updated_at = now() WHERE id = :i"),
                         {"u": body.owner_user_id, "i": person_id})
        detail["owner_user_id"] = str(body.owner_user_id) if body.owner_user_id else None
    if "autonomy_level" in fields:
        await rsvc.set_person_bot(db, person_id, agent_id=None, set_agent=False,
                                  autonomy_level=body.autonomy_level, set_autonomy=True)
        detail["autonomy_level"] = body.autonomy_level
    if "note" in fields:
        row = (await db.execute(text("SELECT attrs FROM core.persons WHERE id = :i"), {"i": person_id})).scalar_one()
        attrs = dict(row or {})
        if body.note is None:
            attrs.pop("owner_note", None)
        else:
            attrs["owner_note"] = body.note
        await db.execute(text("UPDATE core.persons SET attrs = CAST(:a AS jsonb), updated_at = now() WHERE id = :i"),
                         {"a": orjson.dumps(attrs).decode(), "i": person_id})
        detail["note_changed"] = True
    if detail:
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="profile.updated", target_type="person", target_id=str(person_id),
                               result="ok", detail=detail, ip=user.ip)
    return await get_profile(person_id, user, db)


# ═══ Sổ tay nhận thức (notebook) ═════════════════════════════════════════════

async def _ensure_subject(db: AsyncSession, sc: Scope, type_: str, sid: uuid.UUID) -> dict[str, Any]:
    if type_ == "person":
        await ensure_person(db, sc, sid)
        table, col = "core.persons", "display_name"
    else:
        await ensure_group(db, sc, sid)
        table, col = "core.groups", "name"
    r = (await db.execute(text(f"SELECT id, code, {col} AS name FROM {table} WHERE id = :i AND org_id = :o"),  # noqa: S608
                          {"i": sid, "o": sc.org_id})).one_or_none()
    if r is None:
        raise not_found("Hồ sơ" if type_ == "person" else "Nhóm")
    return {"type": type_, "id": str(r.id), "code": r.code, "name": r.name}


@router.get("/notebook/subjects")
async def notebook_subjects(type: Literal["person", "group"] = "person", cursor: str | None = None,  # noqa: A002
                            limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(READ),
                            db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    table, col = ("core.persons", "display_name") if type == "person" else ("core.groups", "name")
    where, params = (sc.person_sql("s") if type == "person" else sc.group_sql("s"))
    conds = [f"s.org_id = :o AND {where}"]
    if type == "person":
        conds.append("s.deleted_at IS NULL AND s.merged_into_id IS NULL")
    if cursor:
        conds.append("n.last_compacted_at < :c OR (n.last_compacted_at IS NULL AND n.created_at < :c)")
    sql_where = " AND ".join(conds)
    base = {"o": user.org_id, "t": type, "c": parse_cursor(cursor), **params}
    q = f"""
        SELECT s.id, s.code, s.{col} AS name, n.token_used, n.token_budget, n.last_compacted_at, n.created_at,
               (SELECT count(*) FROM memory.entries e WHERE e.notebook_id = n.id AND e.archived_at IS NULL) AS n_entries
        FROM {table} s JOIN memory.notebooks n ON n.subject_type = :t AND n.subject_id = s.id
        WHERE {sql_where}
        ORDER BY COALESCE(n.last_compacted_at, n.created_at) DESC LIMIT :n"""  # noqa: S608
    rows = (await db.execute(text(q), {**base, "n": limit + 1})).all()
    items = [{"id": str(r.id), "code": r.code, "name": r.name, "entries": r.n_entries,
             "token_used": r.token_used, "token_budget": r.token_budget,
             "updated_at": iso(r.last_compacted_at or r.created_at)} for r in rows[:limit]]
    nxt = None
    if len(rows) > limit:
        last = rows[limit - 1]
        nxt = iso(last.last_compacted_at or last.created_at)
    return {"items": items, "next_cursor": nxt}


async def _notebook_payload(db: AsyncSession, org_id: uuid.UUID, type_: str, sid: uuid.UUID,
                            subject: dict[str, Any]) -> dict[str, Any]:
    nb = await notebook.ensure(db, org_id, type_, sid)
    rows = (await db.execute(text("""
        SELECT e.id, e.section, e.body, e.refs, e.author, e.is_pinned, e.created_at, u.display_name AS user_name
        FROM memory.entries e
        LEFT JOIN core.users u ON e.author LIKE 'user:%' AND u.id::text = substring(e.author from 6)
        WHERE e.notebook_id = :n AND e.archived_at IS NULL ORDER BY e.is_pinned DESC, e.created_at DESC"""),
        {"n": nb.id})).all()
    refs: list[dict[str, Any]] = []
    seen = set()
    for r in rows:
        for ref in (r.refs or []):
            key = (ref.get("type"), ref.get("id"))
            if key not in seen:
                seen.add(key)
                refs.append(ref)
    sections = []
    for sec_key, title in notebook.SECTIONS.items():
        entries = [r for r in rows if r.section == sec_key]
        sections.append({"key": sec_key, "title": title,
                         "entries": [{"id": str(e.id), "body": e.body, "refs": e.refs, "pinned": e.is_pinned,
                                      "editable": e.author.startswith("user:"),
                                      "author": {"type": "user" if e.author.startswith("user:") else "agent",
                                                 "label": e.user_name or "Core agent"},
                                      "created_at": iso(e.created_at)} for e in entries]})
    return {"subject": subject, "token_used": nb.token_used, "token_budget": nb.token_budget,
            "compaction_no": nb.compaction_no, "last_compacted_at": iso(nb.last_compacted_at),
            "sections": sections, "refs": refs[:40]}


@router.get("/notebook/{type_}/{sid}")
async def get_notebook(type_: Literal["person", "group"], sid: uuid.UUID, user: service.CurrentUser = Depends(READ),
                       db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    subject = await _ensure_subject(db, sc, type_, sid)
    return await _notebook_payload(db, user.org_id, type_, sid, subject)


class NotebookEntryIn(BaseModel):
    section: str
    body: str = Field(min_length=1, max_length=2000)
    pinned: bool = False
    refs: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/notebook/{type_}/{sid}/entries", status_code=201)
async def add_notebook_entry(type_: Literal["person", "group"], sid: uuid.UUID, body: NotebookEntryIn,
                             user: service.CurrentUser = Depends(WRITE), db: AsyncSession = DB) -> dict[str, Any]:
    if body.section not in notebook.SECTIONS:
        raise ApiError(422, "VALIDATION", "Mục sổ tay không hợp lệ", errors={"section": "Không hợp lệ"})
    sc = await scope_for(db, user, "profile.write")
    subject = await _ensure_subject(db, sc, type_, sid)
    eid = await notebook.append(db, user.org_id, type_, sid, body.section, body.body, body.refs,
                                f"user:{user.id}", body.pinned)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="notebook.entry_added", target_type=type_, target_id=subject["code"],
                           result="ok", detail={"entry_id": str(eid), "section": body.section,
                                                 "pinned": body.pinned}, ip=user.ip)
    return {"id": str(eid)}


async def _notebook_entry(db: AsyncSession, org_id: uuid.UUID, type_: str, sid: uuid.UUID, eid: uuid.UUID) -> Any:
    r = (await db.execute(text("""
        SELECT e.* FROM memory.entries e JOIN memory.notebooks n ON n.id = e.notebook_id
        WHERE e.id = :e AND n.org_id = :o AND n.subject_type = :t AND n.subject_id = :s AND e.archived_at IS NULL"""),
        {"e": eid, "o": org_id, "t": type_, "s": sid})).one_or_none()
    if r is None:
        raise not_found("Mục sổ tay")
    return r


class NotebookEntryPatch(BaseModel):
    body: str | None = Field(default=None, min_length=1, max_length=2000)
    pinned: bool | None = None


@router.patch("/notebook/{type_}/{sid}/entries/{eid}")
async def patch_notebook_entry(type_: Literal["person", "group"], sid: uuid.UUID, eid: uuid.UUID,
                               body: NotebookEntryPatch, user: service.CurrentUser = Depends(WRITE),
                               db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    await _ensure_subject(db, sc, type_, sid)
    e = await _notebook_entry(db, user.org_id, type_, sid, eid)
    new_id = eid
    if body.body is not None and body.body != e.body:
        if not e.author.startswith("user:"):
            raise ApiError(409, "SYSTEM_ENTRY_READONLY", "Mục do hệ thống/agent ghi — không sửa nội dung được")
        new_id = (await db.execute(text("""
            INSERT INTO memory.entries (notebook_id, section, body, refs, author, is_pinned, tokens, created_at)
            VALUES (:n, :s, :b, CAST(:r AS jsonb), :a, :p, :t, now()) RETURNING id"""),
            {"n": e.notebook_id, "s": e.section, "b": body.body, "r": orjson.dumps(e.refs).decode(),
             "a": f"user:{user.id}", "p": body.pinned if body.pinned is not None else e.is_pinned,
             "t": notebook.estimate_tokens(body.body)})).scalar_one()
        await db.execute(text("UPDATE memory.entries SET archived_at = now(), replaced_by = :n WHERE id = :e"),
                         {"n": new_id, "e": eid})
    elif body.pinned is not None:
        # Ghim/bỏ ghim cho phép trên mọi mục (kể cả do agent ghi) — đây là cách Owner giữ một quan sát quan
        # trọng khỏi bị nén, không phải sửa nội dung.
        await db.execute(text("UPDATE memory.entries SET is_pinned = :p WHERE id = :e"), {"p": body.pinned, "e": eid})
    await notebook.recount(db, e.notebook_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="notebook.entry_edited", target_type=type_, target_id=str(sid),
                           result="ok", detail={"entry_id": str(eid), "new_entry_id": str(new_id),
                                                 "pinned": body.pinned}, ip=user.ip)
    return {"id": str(new_id)}


@router.delete("/notebook/{type_}/{sid}/entries/{eid}", status_code=204)
async def delete_notebook_entry(type_: Literal["person", "group"], sid: uuid.UUID, eid: uuid.UUID,
                                user: service.CurrentUser = Depends(WRITE), db: AsyncSession = DB) -> Response:
    sc = await scope_for(db, user, "profile.write")
    await _ensure_subject(db, sc, type_, sid)
    e = await _notebook_entry(db, user.org_id, type_, sid, eid)
    if not e.author.startswith("user:"):
        raise ApiError(409, "SYSTEM_ENTRY_READONLY", "Mục do hệ thống/agent ghi — không xoá được")
    await db.execute(text("UPDATE memory.entries SET archived_at = now() WHERE id = :e"), {"e": eid})
    await notebook.recount(db, e.notebook_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="notebook.entry_archived", target_type=type_, target_id=str(sid),
                           result="ok", detail={"entry_id": str(eid)}, ip=user.ip)
    return Response(status_code=204)


@router.post("/notebook/{type_}/{sid}/compact")
async def compact_notebook(type_: Literal["person", "group"], sid: uuid.UUID,
                           user: service.CurrentUser = Depends(WRITE), db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    subject = await _ensure_subject(db, sc, type_, sid)
    nb = await notebook.ensure(db, user.org_id, type_, sid)
    info = await notebook.compact(db, nb.id, reason="manual")
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="notebook.compacted", target_type=type_, target_id=str(sid), result="ok",
                           detail=info or {}, ip=user.ip)
    return await _notebook_payload(db, user.org_id, type_, sid, subject)


@router.post("/notebook/{type_}/{sid}/reset")
async def reset_notebook(type_: Literal["person", "group"], sid: uuid.UUID,
                         user: service.CurrentUser = Depends(WRITE), db: AsyncSession = DB) -> dict[str, Any]:
    """Đặt lại: lưu trữ toàn bộ mục chưa ghim (trừ "Giới hạn cho agent", như nén) mà **không** sinh mục tóm tắt —
    khác `compact()` (nén giữ tóm tắt), đây là dọn sạch hẳn để agent bắt đầu lại từ số 0 cho chủ thể này."""
    sc = await scope_for(db, user, "profile.write")
    subject = await _ensure_subject(db, sc, type_, sid)
    nb = await notebook.ensure(db, user.org_id, type_, sid)
    ids = (await db.execute(text("""
        SELECT id FROM memory.entries WHERE notebook_id = :n AND archived_at IS NULL AND NOT is_pinned
          AND section <> ALL(:never)"""), {"n": nb.id, "never": list(notebook.NEVER_COMPACT)})).scalars().all()
    if ids:
        await db.execute(text("UPDATE memory.entries SET archived_at = now() WHERE id = ANY(:ids)"), {"ids": ids})
    await notebook.recount(db, nb.id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="notebook.reset", target_type=type_, target_id=str(sid), result="ok",
                           detail={"archived": len(ids)}, ip=user.ip)
    return await _notebook_payload(db, user.org_id, type_, sid, subject)


@router.get("/notebook/{type_}/{sid}/history")
async def notebook_history(type_: Literal["person", "group"], sid: uuid.UUID,
                           user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> list[dict[str, Any]]:
    sc = await scope_for(db, user, "profile.read")
    await _ensure_subject(db, sc, type_, sid)
    rows = (await db.execute(text("""
        SELECT c.compaction_no, c.at, c.tokens_before, c.tokens_after, cardinality(c.archived_entries) AS n, c.summary
        FROM memory.compactions c JOIN memory.notebooks n ON n.id = c.notebook_id
        WHERE n.org_id = :o AND n.subject_type = :t AND n.subject_id = :s ORDER BY c.compaction_no DESC"""),
        {"o": user.org_id, "t": type_, "s": sid})).all()
    return [{"compaction_no": r.compaction_no, "at": iso(r.at), "tokens_before": r.tokens_before,
             "tokens_after": r.tokens_after, "archived": r.n, "summary": r.summary} for r in rows]


@router.get("/notebook/{type_}/{sid}/dropped")
async def notebook_dropped(type_: Literal["person", "group"], sid: uuid.UUID, cursor: str | None = None,
                           limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(READ),
                           db: AsyncSession = DB) -> dict[str, Any]:
    """Mục đã nén khỏi ngữ cảnh — vẫn truy được (handoff/01 §notebook `[nbDropped]`)."""
    sc = await scope_for(db, user, "profile.read")
    await _ensure_subject(db, sc, type_, sid)
    nb = await notebook.ensure(db, user.org_id, type_, sid)
    conds = ["e.notebook_id = :n", "e.archived_at IS NOT NULL"]
    if cursor:
        conds.append("e.archived_at < :c")
    where = " AND ".join(conds)
    rows = (await db.execute(text(f"""
        SELECT e.id, e.section, e.body, e.refs, e.author, e.archived_at
        FROM memory.entries e WHERE {where} ORDER BY e.archived_at DESC LIMIT :lim"""),  # noqa: S608
        {"n": nb.id, "c": parse_cursor(cursor), "lim": limit + 1})).all()
    items = [{"id": str(r.id), "section": r.section, "body": r.body, "refs": r.refs,
             "author": {"type": "user" if r.author.startswith("user:") else "agent"},
             "archived_at": iso(r.archived_at)} for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].archived_at) if len(rows) > limit else None}


# ═══ Tài liệu (documents) ════════════════════════════════════════════════════
# ACL (`biz.document_acl.principal`): `role:<code>` (vai trò) | `user:<id>` (cá nhân) | `group:<id>` (một
# `core.teams` — nhóm nhân viên nội bộ, khác `core.groups` là nhóm chat của khách) | `agent:<id>`. ACL là danh
# sách **cấp thêm** quyền (không phải danh sách chặn): một tài liệu luôn thấy được theo phạm vi mặc định của
# người/nhóm sở hữu (`owner_person_id`/`owner_group_id`, như mọi đối tượng nghiệp vụ khác — docs/api/phase-3.md
# §Phạm vi), **cộng thêm** bất kỳ dòng ACL nào khớp vai trò/cá nhân/team của người gọi — dùng để chia sẻ một
# tài liệu ra ngoài phạm vi mặc định (vd cho một vai trò hoặc một team cụ thể xem/sửa dù không sở hữu người/
# nhóm gắn với tài liệu).

MAX_DOC_BYTES = 20 * 1024 * 1024


def _principals(user: service.CurrentUser) -> list[str]:
    out = [f"role:{user.role_code}", f"user:{user.id}"]
    if user.team_id:
        out.append(f"group:{user.team_id}")
    return out


def _doc_default_scope_sql(sc: Scope) -> tuple[str, dict[str, Any]]:
    """Phạm vi mặc định (không có dòng ACL nào cho tài liệu): theo người/nhóm sở hữu, như mọi đối tượng khác."""
    if sc.is_all:
        return "TRUE", {}
    pw, pp = sc.person_id_sql("d.owner_person_id")
    gw, gp = sc.group_id_sql("d.owner_group_id")
    return f"(({pw}) OR ({gw}) OR (d.owner_person_id IS NULL AND d.owner_group_id IS NULL))", {**pp, **gp}


def _doc_visible_sql(sc: Scope, user: service.CurrentUser, *, need_write: bool = False) -> tuple[str, dict[str, Any]]:
    """Một dòng `biz.documents d` thấy được (hoặc sửa được, `need_write`) — dùng chung cho danh sách và chi
    tiết: trong phạm vi mặc định (người/nhóm sở hữu) **hoặc** có dòng ACL cấp quyền cho vai trò/cá nhân/team của
    người gọi (xem chú thích ACL ở trên — cấp thêm, không phải chặn bớt)."""
    if sc.is_all:
        return "TRUE", {}
    flag = "a.can_write" if need_write else "(a.can_read OR a.can_write)"
    acl_grant = (f"EXISTS (SELECT 1 FROM biz.document_acl a WHERE a.document_id = d.id "
                f"AND a.principal = ANY(:doc_principals) AND {flag})")
    default_where, default_params = _doc_default_scope_sql(sc)
    return f"(({acl_grant}) OR ({default_where}))", {"doc_principals": _principals(user), **default_params}


_DOC_SELECT = """
SELECT d.id, d.title, d.description, d.storage_key, d.mime, d.bytes, d.owner_group_id, d.owner_person_id,
       d.created_by, d.raw_event_id, d.created_at, d.updated_at,
       p.id AS p_id, p.code AS p_code, p.display_name AS p_name, p.person_type AS p_type, p.organization_name AS p_org,
       g.id AS g_id, g.code AS g_code, g.name AS g_name, gc.type AS g_channel
FROM biz.documents d
LEFT JOIN core.persons p ON p.id = d.owner_person_id
LEFT JOIN core.groups g ON g.id = d.owner_group_id LEFT JOIN core.channels gc ON gc.id = g.channel_id
WHERE d.deleted_at IS NULL
"""
_SOURCE_SQL = {"agent": "d.created_by LIKE 'agent:%'", "tay": "d.created_by LIKE 'user:%'",
              "channel": "d.created_by NOT LIKE 'agent:%' AND d.created_by NOT LIKE 'user:%'"}


def _doc_source(created_by: str) -> str:
    if created_by.startswith("agent:"):
        return "agent"
    if created_by.startswith("user:"):
        return "tay"
    return "channel"


def _doc_payload(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "title": r.title, "description": r.description, "mime": r.mime, "bytes": r.bytes,
            "owner": rsvc.person_ref(r, "p") or rsvc.group_ref(r, "g"), "source": _doc_source(r.created_by),
            "created_by": r.created_by, "created_at": iso(r.created_at), "updated_at": iso(r.updated_at)}


async def _visible_document(db: AsyncSession, sc: Scope, user: service.CurrentUser, doc_id: uuid.UUID,
                            *, need_write: bool = False) -> Any:
    where, params = _doc_visible_sql(sc, user, need_write=need_write)
    r = (await db.execute(text(_DOC_SELECT + f" AND d.id = :i AND d.org_id = :o AND {where}"),  # noqa: S608
                          {"i": doc_id, "o": user.org_id, **params})).one_or_none()
    if r is None:
        raise not_found("Tài liệu")
    return r


@router.get("/documents")
async def list_documents(owner_person_id: uuid.UUID | None = None, owner_group_id: uuid.UUID | None = None,
                         source: Literal["channel", "agent", "tay"] | None = None, cursor: str | None = None,
                         limit: int = Query(50, ge=1, le=200), user: service.CurrentUser = Depends(READ),
                         db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    dw, dp = _doc_visible_sql(sc, user)
    conds = [f"d.org_id = :o AND {dw}"]
    if owner_person_id:
        conds.append("d.owner_person_id = :op")
    if owner_group_id:
        conds.append("d.owner_group_id = :og")
    if source:
        conds.append(_SOURCE_SQL[source])
    if cursor:
        conds.append("d.created_at < :c")
    sql_where = " AND ".join(conds)
    base = {"o": user.org_id, "op": owner_person_id, "og": owner_group_id, "c": parse_cursor(cursor), **dp}
    total = (await db.execute(text(f"SELECT count(*) FROM biz.documents d WHERE d.deleted_at IS NULL "  # noqa: S608
                                   f"AND {sql_where}"), base)).scalar_one()
    rows = (await db.execute(text(_DOC_SELECT + f" AND {sql_where} ORDER BY d.created_at DESC LIMIT :n"),  # noqa: S608
                             {**base, "n": limit + 1})).all()
    items = [_doc_payload(r) for r in rows[:limit]]
    return {"items": items, "next_cursor": iso(rows[limit - 1].created_at) if len(rows) > limit else None,
            "total": total}


@router.get("/documents/{document_id}")
async def get_document(document_id: uuid.UUID, user: service.CurrentUser = Depends(READ),
                       db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.read")
    r = await _visible_document(db, sc, user, document_id)
    acl = (await db.execute(text("SELECT principal, can_read, can_write FROM biz.document_acl WHERE document_id = :d"),
                            {"d": document_id})).all()
    out = _doc_payload(r)
    out["acl"] = [{"principal": a.principal, "can_read": a.can_read, "can_write": a.can_write} for a in acl]
    return out


class AclIn(BaseModel):
    principal: str = Field(min_length=1, max_length=200)
    can_read: bool = True
    can_write: bool = False


class DocumentIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    filename: str = Field(min_length=1, max_length=200)
    mime: str = Field(min_length=1, max_length=100)
    content_base64: str = Field(min_length=1, max_length=30_000_000)
    owner_person_id: uuid.UUID | None = None
    owner_group_id: uuid.UUID | None = None
    acl: list[AclIn] = Field(default_factory=list)


@router.post("/documents", status_code=201)
async def create_document(body: DocumentIn, user: service.CurrentUser = Depends(WRITE),
                          db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    if body.owner_person_id:
        await ensure_person(db, sc, body.owner_person_id)
    if body.owner_group_id:
        await ensure_group(db, sc, body.owner_group_id)
    try:
        data = base64.b64decode(body.content_base64, validate=True)
    except Exception as e:
        raise ApiError(422, "VALIDATION", "Nội dung tệp không phải base64 hợp lệ",
                       errors={"content_base64": "Không hợp lệ"}) from e
    if len(data) > MAX_DOC_BYTES:
        raise ApiError(422, "VALIDATION", "Tệp vượt giới hạn 20MB", errors={"content_base64": "Quá lớn"})
    key = new_key(user.org_id, body.filename)
    await get_object_store().put(key, data)
    row = (await db.execute(text("""
        INSERT INTO biz.documents (org_id, title, description, storage_key, mime, bytes, owner_group_id,
                                   owner_person_id, created_by)
        VALUES (:o, :t, :d, :k, :m, :b, :og, :op, :cb) RETURNING id"""),
        {"o": user.org_id, "t": body.title, "d": body.description, "k": key, "m": body.mime, "b": len(data),
         "og": body.owner_group_id, "op": body.owner_person_id, "cb": user.actor_id})).one()
    acl_rows = [(row.id, f"role:{rbac.OWNER}", True, True), (row.id, user.actor_id, True, True)]
    acl_rows += [(row.id, a.principal, a.can_read, a.can_write) for a in body.acl]
    for did, principal, can_read, can_write in acl_rows:
        await db.execute(text("""INSERT INTO biz.document_acl (document_id, principal, can_read, can_write)
                                 VALUES (:d, :p, :r, :w)
                                 ON CONFLICT (document_id, principal) DO UPDATE
                                   SET can_read = EXCLUDED.can_read, can_write = EXCLUDED.can_write"""),
                         {"d": did, "p": principal, "r": can_read, "w": can_write})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="document.uploaded", target_type="document", target_id=str(row.id),
                           target_label=body.title, result="ok",
                           detail={"bytes": len(data), "mime": body.mime, "hash": content_hash(data)}, ip=user.ip)
    return await get_document(row.id, user, db)


@router.get("/documents/{document_id}/content")
async def download_document(document_id: uuid.UUID, user: service.CurrentUser = Depends(READ),
                            db: AsyncSession = DB) -> Response:
    sc = await scope_for(db, user, "profile.read")
    r = await _visible_document(db, sc, user, document_id)
    try:
        data = await get_object_store().get(r.storage_key)
    except ObjectNotFound as e:
        raise not_found("Tệp") from e
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="document.downloaded", target_type="document", target_id=str(document_id),
                           target_label=r.title, result="ok", ip=user.ip)
    # Header HTTP chỉ nhận latin-1 — tên tài liệu tiếng Việt phải mã hoá theo RFC 5987 (filename*=UTF-8''…).
    filename = urllib.parse.quote(r.title)
    return Response(content=data, media_type=r.mime,
                    headers={"Content-Disposition": f"inline; filename*=UTF-8''{filename}"})


class DocumentPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    owner_person_id: uuid.UUID | None = None
    owner_group_id: uuid.UUID | None = None


@router.patch("/documents/{document_id}")
async def patch_document(document_id: uuid.UUID, body: DocumentPatch, user: service.CurrentUser = Depends(WRITE),
                         db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    await _visible_document(db, sc, user, document_id, need_write=True)
    fields: list[str] = []
    params: dict[str, Any] = {"i": document_id}
    if body.title is not None:
        fields.append("title = :title")
        params["title"] = body.title
    if "description" in body.model_fields_set:
        fields.append("description = :description")
        params["description"] = body.description
    if "owner_person_id" in body.model_fields_set:
        if body.owner_person_id:
            await ensure_person(db, sc, body.owner_person_id)
        fields.append("owner_person_id = :op")
        params["op"] = body.owner_person_id
    if "owner_group_id" in body.model_fields_set:
        if body.owner_group_id:
            await ensure_group(db, sc, body.owner_group_id)
        fields.append("owner_group_id = :og")
        params["og"] = body.owner_group_id
    if fields:
        fields.append("updated_at = now()")
        await db.execute(text(f"UPDATE biz.documents SET {', '.join(fields)} WHERE id = :i"), params)  # noqa: S608
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="document.updated", target_type="document", target_id=str(document_id),
                               result="ok", ip=user.ip)
    return await get_document(document_id, user, db)


@router.put("/documents/{document_id}/acl")
async def put_document_acl(document_id: uuid.UUID, body: list[AclIn], user: service.CurrentUser = Depends(WRITE),
                           db: AsyncSession = DB) -> dict[str, Any]:
    sc = await scope_for(db, user, "profile.write")
    await _visible_document(db, sc, user, document_id, need_write=True)
    await db.execute(text("DELETE FROM biz.document_acl WHERE document_id = :d"), {"d": document_id})
    for a in body:
        await db.execute(text("""INSERT INTO biz.document_acl (document_id, principal, can_read, can_write)
                                 VALUES (:d, :p, :r, :w)"""),
                         {"d": document_id, "p": a.principal, "r": a.can_read, "w": a.can_write})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="document.acl_updated", target_type="document", target_id=str(document_id),
                           result="ok", detail={"acl": [a.model_dump() for a in body]}, ip=user.ip)
    return await get_document(document_id, user, db)


@router.delete("/documents/{document_id}", status_code=204)
async def delete_document(document_id: uuid.UUID, user: service.CurrentUser = Depends(WRITE),
                          db: AsyncSession = DB) -> Response:
    sc = await scope_for(db, user, "profile.write")
    r = await _visible_document(db, sc, user, document_id, need_write=True)
    await db.execute(text("UPDATE biz.documents SET deleted_at = now() WHERE id = :i"), {"i": document_id})
    try:
        await get_object_store().delete(r.storage_key)
    except Exception:  # noqa: BLE001 — xoá blob là best-effort, dòng metadata đã xoá mềm là nguồn sự thật
        pass
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="document.deleted", target_type="document", target_id=str(document_id),
                           target_label=r.title, result="ok", ip=user.ip)
    return Response(status_code=204)


# ═══ chứng cứ: điểm của người/nhóm dùng chung registry "score" của core (đã đăng ký) ════════════════════════
