"""Ingest: bridge → Kho thô (ARCHITECTURE §4.2) và đồng bộ trạng thái kênh, danh bạ nhóm.

Mỗi tin vào: một transaction gồm ánh xạ nhóm/người gửi (tạo mới nếu chưa có), khử trùng theo
(kênh, mã tin), `INSERT raw.events` + `refinery.event_state(pending)`, `NOTIFY raw_ingested`. Sau commit mới
đẩy dòng mới lên WebSocket. Tin của nhóm chưa bật (hoặc tin 1-1 khi Owner chưa cho nghe) bị bỏ — khoá cứng
`listen_authorized_only`, kiểm lần hai sau bridge.
"""

import hashlib
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import orjson
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto, realtime
from gh.chassis import actionlog
from gh.chassis.bus import BRIDGE_CONTROL, EventBus, uuid7
from gh.data.common import CHANNEL_PREFIX, LISTENING_MODES, fetch_raw, iso, org_settings, raw_item

log = logging.getLogger("gh.ingest")

QR_TTL_S = 70
KINDS = ("text", "image", "file", "sticker", "reaction", "system", "other")


def _ts(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, UTC)
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(UTC)


async def channel_row(db: AsyncSession, org_id: uuid.UUID, type: str) -> Any:
    return (await db.execute(text("SELECT id, type, name FROM core.channels WHERE org_id = :o AND type = :t"),
                             {"o": org_id, "t": type})).one_or_none()


async def upsert_group(db: AsyncSession, org_id: uuid.UUID, channel: Any, external_id: str, name: str | None,
                       member_count: int | None = None) -> Any:
    row = (await db.execute(text("""SELECT id, code, name, listen_mode FROM core.groups
                                    WHERE channel_id = :c AND external_id = :x"""),
                            {"c": channel.id, "x": external_id})).one_or_none()
    if row is None:
        # Nhóm mới luôn "Không nghe" (khoá cứng) — Owner tự bật.
        code = (await db.execute(text("SELECT core.next_code(:p)"),
                                 {"p": f"GRP-{CHANNEL_PREFIX.get(channel.type, 'XX')}"})).scalar_one()
        row = (await db.execute(text("""
            INSERT INTO core.groups (org_id, code, channel_id, external_id, name, listen_mode, member_count)
            VALUES (:o, :code, :c, :x, :n, 'off', :m)
            ON CONFLICT (channel_id, external_id) DO UPDATE SET name = core.groups.name
            RETURNING id, code, name, listen_mode"""),
            {"o": org_id, "code": code, "c": channel.id, "x": external_id, "n": name or external_id,
             "m": member_count})).one()
    elif (name and name != row.name) or member_count is not None:
        await db.execute(text("""UPDATE core.groups SET name = COALESCE(:n, name),
                                 member_count = COALESCE(:m, member_count) WHERE id = :i"""),
                         {"n": name, "m": member_count, "i": row.id})
    return row


async def upsert_identity(db: AsyncSession, org_id: uuid.UUID, channel: Any, external_id: str, name: str | None,
                          phone: str | None = None) -> Any:
    row = (await db.execute(text("""SELECT id, person_id FROM core.person_identities
                                    WHERE channel_id = :c AND external_id = :x"""),
                            {"c": channel.id, "x": external_id})).one_or_none()
    if row is not None:
        if name or phone:
            await db.execute(text("""UPDATE core.person_identities SET handle = COALESCE(:h, handle),
                                     phone_e164 = COALESCE(:p, phone_e164) WHERE id = :i"""),
                             {"h": name, "p": _e164(phone), "i": row.id})
        return row
    code = (await db.execute(text("SELECT core.next_code('PER')"))).scalar_one()
    person_id = (await db.execute(text("""
        INSERT INTO core.persons (org_id, code, display_name, relation_to_owner, attrs)
        VALUES (:o, :code, :n, 'stranger', '{"auto": true}') RETURNING id"""),
        {"o": org_id, "code": code, "n": (name or external_id)[:200]})).scalar_one()
    return (await db.execute(text("""
        INSERT INTO core.person_identities (person_id, channel_id, external_id, handle, phone_e164)
        VALUES (:p, :c, :x, :h, :ph)
        ON CONFLICT (channel_id, external_id)
          DO UPDATE SET handle = COALESCE(EXCLUDED.handle, core.person_identities.handle)
        RETURNING id, person_id"""),
        {"p": person_id, "c": channel.id, "x": external_id, "h": name, "ph": _e164(phone)})).one()


def _e164(phone: str | None) -> str | None:
    if not phone:
        return None
    digits = "".join(ch for ch in phone if ch.isdigit())
    if not digits:
        return None
    if phone.strip().startswith("+"):
        return "+" + digits
    if digits.startswith("84"):
        return "+" + digits
    if digits.startswith("0"):
        return "+84" + digits[1:]
    return "+" + digits


async def _member(db: AsyncSession, group_id: uuid.UUID, person_id: uuid.UUID) -> None:
    await db.execute(text("""INSERT INTO core.group_members (group_id, person_id, joined_at) VALUES (:g, :p, now())
                             ON CONFLICT (group_id, person_id) DO UPDATE SET left_at = NULL
                             WHERE core.group_members.left_at IS NOT NULL"""), {"g": group_id, "p": person_id})


async def ingest_message(db: AsyncSession, org_id: uuid.UUID, p: dict[str, Any]) -> uuid.UUID | None:
    """Ghi một tin vào Kho thô. Trả id bản ghi mới, hoặc None nếu bỏ (trùng, nhóm chưa bật, kênh lạ)."""
    channel = await channel_row(db, org_id, str(p.get("channel", "")))
    msg_id = str(p.get("external_msg_id") or "")
    sender = str(p.get("sender_external_id") or "")
    if channel is None or not msg_id or not sender:
        return None
    group = None
    if p.get("external_group_id"):
        group = await upsert_group(db, org_id, channel, str(p["external_group_id"]), p.get("group_name"))
        if group.listen_mode not in LISTENING_MODES:
            return None
    elif not (await org_settings(db, org_id)).get("listen_direct", {}).get(channel.type, False):
        return None
    identity = await upsert_identity(db, org_id, channel, sender, p.get("sender_name"), p.get("sender_phone"))
    if group is not None:
        await _member(db, group.id, identity.person_id)

    event_id, received_at = uuid7(), datetime.now(UTC)
    fresh = (await db.execute(text("""
        INSERT INTO raw.event_keys (channel_id, external_msg_id, event_id, received_at) VALUES (:c, :m, :e, :r)
        ON CONFLICT DO NOTHING RETURNING event_id"""),
        {"c": channel.id, "m": msg_id, "e": event_id, "r": received_at})).scalar_one_or_none()
    if fresh is None:
        return None  # bridge gửi lại / tin trùng
    body = p.get("body_text")
    kind = p.get("kind") if p.get("kind") in KINDS else "other"
    payload = p.get("payload") if isinstance(p.get("payload"), dict) else {"value": p.get("payload")}
    content_hash = hashlib.sha256(orjson.dumps([channel.type, msg_id, sender, body or "", kind])).digest()
    direction = "outbound" if p.get("direction") == "outbound" else "inbound"
    mentions = bool(p.get("mentions_self"))
    await db.execute(text("""
        INSERT INTO raw.events (id, org_id, received_at, occurred_at, channel_id, group_id, sender_identity_id,
                                external_msg_id, kind, body_text, payload, content_hash, direction, mentions_agent)
        VALUES (:id, :o, :r, :occ, :c, :g, :s, :m, :k, :b, CAST(:pl AS jsonb), :h, :d, :men)"""),
        {"id": event_id, "o": org_id, "r": received_at, "occ": _ts(p.get("occurred_at")), "c": channel.id,
         "g": group.id if group else None, "s": identity.id, "m": msg_id, "k": kind, "b": body,
         "pl": orjson.dumps(payload, default=str).decode(), "h": content_hash, "d": direction, "men": mentions})
    # Đường nhanh: tin tag agent và tin 1-1 (ARCHITECTURE §4.3, quyết định Q3). Tin của chính mình không cần.
    fast = direction == "inbound" and (mentions or group is None)
    await db.execute(text("""
        INSERT INTO refinery.event_state (event_id, event_received_at, org_id, state, fast)
        VALUES (:e, :r, :o, 'pending', :f)"""), {"e": event_id, "r": received_at, "o": org_id, "f": fast})
    await db.execute(text("SELECT pg_notify('raw_ingested', :p)"),
                     {"p": f"{org_id}|{'fast' if fast else 'normal'}|{event_id}"})
    return event_id


# ─── Tập nhóm được nghe (bridge kiểm trước khi đẩy tin) ─────────────────────

async def sync_listen_sets(db: AsyncSession, redis: Redis, org_id: uuid.UUID) -> None:
    rows = (await db.execute(text("""
        SELECT c.type, g.external_id, g.listen_mode FROM core.channels c
        LEFT JOIN core.groups g ON g.channel_id = c.id WHERE c.org_id = :o"""), {"o": org_id})).all()
    sets: dict[str, list[str]] = {}
    for r in rows:
        sets.setdefault(r.type, [])
        if r.external_id and r.listen_mode in LISTENING_MODES:
            sets[r.type].append(r.external_id)
    direct = (await org_settings(db, org_id)).get("listen_direct", {})
    pipe = redis.pipeline(transaction=True)
    for ch, ids in sets.items():
        key = f"gh:bridge:listen:{ch}"
        pipe.delete(key)
        if ids:
            pipe.sadd(key, *ids)
        pipe.set(f"gh:bridge:listen_direct:{ch}", "1" if direct.get(ch) else "0")
    await pipe.execute()


# ─── Trạng thái phiên kênh ─────────────────────────────────────────────────

async def _session(db: AsyncSession, session_id: Any) -> Any:
    try:
        sid = uuid.UUID(str(session_id))
    except ValueError:
        return None
    return (await db.execute(text("""
        SELECT s.id, s.channel_id, s.state, s.account_label, s.started_at, c.type, c.org_id
        FROM core.channel_sessions s JOIN core.channels c ON c.id = s.channel_id WHERE s.id = :i"""),
        {"i": sid})).one_or_none()


async def _status_ws(redis: Redis, org_id: Any, type: str, state: str, account_label: str | None,
                     session_id: Any, scanned: bool = False, error: str | None = None) -> None:
    await realtime.publish(redis, "channel.status", {"type": type, "state": state, "account_label": account_label,
                                                     "session_id": str(session_id), "scanned": scanned,
                                                     "error": error}, org_id=org_id)


async def handle_status(db: AsyncSession, redis: Redis, bus: EventBus, org_id: uuid.UUID, type: str,
                        p: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Xử lý một sự kiện gh.bridge.status. Trả các sự kiện WebSocket cần phát sau commit."""
    out: list[tuple[str, dict[str, Any]]] = []
    if type == "bridge.hello":
        await sync_listen_sets(db, redis, org_id)
        rows = (await db.execute(text("""
            SELECT s.id, s.credential_enc, c.type
            FROM core.channel_sessions s JOIN core.channels c ON c.id = s.channel_id
            WHERE c.org_id = :o AND s.state = 'active' AND s.ended_at IS NULL AND s.credential_enc IS NOT NULL"""),
            {"o": org_id})).all()
        for r in rows:
            wire = crypto.transport_encrypt(crypto.decrypt(bytes(r.credential_enc), b"channel_session"),
                                            f"{r.type}:{r.id}")
            await bus.publish(BRIDGE_CONTROL, "session.login", {"channel": r.type, "session_id": str(r.id),
                                                                "credential": wire}, actor="system:ingest",
                              org_id=org_id)
        return out
    s = await _session(db, p.get("session_id"))
    if s is None or s.org_id != org_id:
        return out
    if type == "session.qr":
        await redis.set(f"gh:channel:qr:{s.id}", orjson.dumps({"image": p.get("image"),
                                                                "expires_at": p.get("expires_at"),
                                                                "scanned": False}), ex=QR_TTL_S)
        await db.execute(text("""UPDATE core.channel_sessions SET state = 'pending_qr', qr_issued_at = now()
                                 WHERE id = :i AND ended_at IS NULL"""), {"i": s.id})
        out.append(("channel.qr", {"type": s.type, "session_id": str(s.id), "image": p.get("image"),
                                   "expires_at": p.get("expires_at")}))
    elif type == "session.scanned":
        raw = await redis.get(f"gh:channel:qr:{s.id}")
        if raw:
            qr = orjson.loads(raw)
            qr["scanned"] = True
            await redis.set(f"gh:channel:qr:{s.id}", orjson.dumps(qr), ex=QR_TTL_S)
        out.append(("channel.status", {"type": s.type, "state": "pending_qr", "account_label": s.account_label,
                                       "session_id": str(s.id), "scanned": True, "error": None}))
    elif type == "session.active":
        account = p.get("account") or {}
        cred = _reencrypt(p.get("credential"), s)
        # Một kênh chỉ một phiên hoạt động: phiên cũ kết thúc.
        await db.execute(text("""UPDATE core.channel_sessions SET state = 'logged_out', ended_at = now()
                                 WHERE channel_id = :c AND id <> :i AND ended_at IS NULL"""),
                         {"c": s.channel_id, "i": s.id})
        label = s.account_label or account.get("name") or s.type
        await db.execute(text("""
            UPDATE core.channel_sessions SET state = 'active', started_at = now(),
                   credential_enc = COALESCE(:c, credential_enc),
                   external_account = :x, account_label = :l, last_heartbeat_at = now(),
                   meta = meta || CAST(:m AS jsonb) WHERE id = :i"""),
            {"c": cred, "x": str(account.get("id") or "") or None, "l": label, "i": s.id,
             "m": orjson.dumps({"account_name": account.get("name")}).decode()})
        await redis.delete(f"gh:channel:qr:{s.id}")
        await actionlog.record(db, org_id=org_id, actor_type="system", actor_id=f"bridge:{s.type}",
                               action="channel.session_active", target_type="channel_session",
                               target_id=str(s.id), target_label=label)
        out.append(("channel.status", {"type": s.type, "state": "active", "account_label": label,
                                       "session_id": str(s.id), "scanned": True, "error": None}))
    elif type == "session.credential":
        cred = _reencrypt(p.get("credential"), s)
        if cred is not None:
            await db.execute(text("UPDATE core.channel_sessions SET credential_enc = :c WHERE id = :i"),
                             {"c": cred, "i": s.id})
    elif type == "session.ended":
        reason = p.get("reason") if p.get("reason") in ("expired", "logged_out", "error") else "error"
        await db.execute(text("""
            UPDATE core.channel_sessions SET state = :st, ended_at = COALESCE(ended_at, now()),
                   credential_enc = CASE WHEN :st IN ('logged_out', 'expired') THEN NULL ELSE credential_enc END,
                   meta = meta || CAST(:m AS jsonb) WHERE id = :i"""),
            {"st": reason, "i": s.id, "m": orjson.dumps({"error": p.get("error")}).decode()})
        await redis.delete(f"gh:channel:qr:{s.id}")
        await actionlog.record(db, org_id=org_id, actor_type="system", actor_id=f"bridge:{s.type}",
                               action="channel.session_ended", target_type="channel_session", target_id=str(s.id),
                               target_label=s.account_label, result="ok" if reason == "logged_out" else "failed",
                               detail={"reason": reason, "error": p.get("error")})
        out.append(("channel.status", {"type": s.type, "state": reason, "account_label": s.account_label,
                                       "session_id": str(s.id), "scanned": False, "error": p.get("error")}))
    elif type == "heartbeat":
        await db.execute(text("""UPDATE core.channel_sessions SET last_heartbeat_at = now(),
                                 meta = meta || CAST(:m AS jsonb) WHERE id = :i AND ended_at IS NULL"""),
                         {"i": s.id, "m": orjson.dumps({"latency_ms": p.get("latency_ms"),
                                                        "queued": p.get("queued", 0)}).decode()})
        now = datetime.now(UTC)
        key = f"gh:uptime:{s.type}:{now:%Y%m%d}"
        await redis.setbit(key, now.hour * 60 + now.minute, 1)
        await redis.expire(key, 3 * 86400)
    elif type == "send.result":
        await actionlog.record(db, org_id=org_id, actor_type="system", actor_id=f"bridge:{s.type}",
                               action="message.sent" if p.get("ok") else "message.send_failed",
                               target_type="draft", target_id=str(p.get("draft_id") or ""),
                               result="ok" if p.get("ok") else "failed",
                               detail={"error": p.get("error"), "external_msg_id": p.get("external_msg_id")})
    return out


def _reencrypt(transport: Any, s: Any) -> bytes | None:
    if not transport:
        return None
    try:
        plain = crypto.transport_decrypt(str(transport), f"{s.type}:{s.id}")
    except Exception:  # noqa: BLE001 — khoá bridge sai / dữ liệu hỏng: không lưu
        log.error("Không giải mã được phiên kênh %s từ bridge", s.id)
        return None
    return crypto.encrypt(plain, b"channel_session")


# ─── Danh bạ nhóm ───────────────────────────────────────────────────────────

async def handle_directory(db: AsyncSession, redis: Redis, org_id: uuid.UUID, p: dict[str, Any]) -> int:
    channel = await channel_row(db, org_id, str(p.get("channel", "")))
    if channel is None:
        return 0
    n = 0
    for g in p.get("groups") or []:
        if not g.get("external_id"):
            continue
        row = await upsert_group(db, org_id, channel, str(g["external_id"]), g.get("name"), g.get("member_count"))
        n += 1
        for m in (g.get("members") or [])[:5000]:
            if not m.get("external_id"):
                continue
            ident = await upsert_identity(db, org_id, channel, str(m["external_id"]), m.get("name"), m.get("phone"))
            await _member(db, row.id, ident.person_id)
    await sync_listen_sets(db, redis, org_id)
    return n


# ─── Consumer ──────────────────────────────────────────────────────────────

class Ingest:
    """Ba consumer chạy trong api: inbound → Kho thô, status → phiên kênh, directory → nhóm."""

    GROUP = "ingest"

    def __init__(self, bus: EventBus, redis: Redis, org_id: uuid.UUID, sessionmaker: Any):
        self.bus, self.redis, self.org_id, self.sm = bus, redis, org_id, sessionmaker

    async def on_inbound(self, event: Any) -> None:
        if event.type != "message":
            return
        async with self.sm() as db:
            event_id = await ingest_message(db, self.org_id, event.payload)
            await db.commit()
            if event_id is None:
                return
            row = await fetch_raw(db, event_id)
        if row is not None:
            await realtime.publish(self.redis, "raw.new", raw_item(row), org_id=self.org_id)

    async def on_status(self, event: Any) -> None:
        async with self.sm() as db:
            out = await handle_status(db, self.redis, self.bus, self.org_id, event.type, event.payload)
            await db.commit()
        for type, data in out:
            await realtime.publish(self.redis, type, data, org_id=self.org_id)

    async def on_directory(self, event: Any) -> None:
        if event.type != "groups":
            return
        async with self.sm() as db:
            await handle_directory(db, self.redis, self.org_id, event.payload)
            await db.commit()


def uptime_minutes_key(type: str, day: datetime) -> str:
    return f"gh:uptime:{type}:{day:%Y%m%d}"


async def uptime_pct(redis: Redis, type: str, since: datetime | None) -> float | None:
    """Tỉ lệ phút có heartbeat trong 24 giờ qua (tính từ lúc phiên bắt đầu nếu mới hơn)."""
    now = datetime.now(UTC)
    start = max(now - timedelta(hours=24), since) if since else now - timedelta(hours=24)
    total = int((now - start).total_seconds() // 60)
    if total <= 0:
        return None
    maps: dict[str, bytes] = {}
    hits, t = 0, start
    while t < now:
        key = uptime_minutes_key(type, t)
        if key not in maps:
            maps[key] = await redis.get(key) or b""
        bit, bm = t.hour * 60 + t.minute, maps[key]
        if bit // 8 < len(bm) and bm[bit // 8] & (0x80 >> (bit % 8)):
            hits += 1
        t += timedelta(minutes=1)
    return round(min(100.0, hits * 100 / total), 1)


__all__ = ["Ingest", "handle_directory", "handle_status", "ingest_message", "iso", "sync_listen_sets",
           "uptime_pct"]
