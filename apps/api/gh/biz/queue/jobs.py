"""Việc nền của cụm Hàng đợi & Hành động: cảnh báo sớm (spec E9) quét theo ngưỡng thời gian.

`biz.alerts` đã có từ giai đoạn 1 (`db/sql/0002_phase1.sql`) và một phần loại đã được sinh nơi khác: than phiền
lặp lại do `gh.refinery.runner` (luật R-03) sinh ngay khi sàng lọc, hạn mức/chuỗi model do `gh.providers.router`
sinh khi gọi model. Việc quét ở đây (mỗi 15 phút, theo tổ chức) phủ các loại còn lại của spec E9 mà không gắn
liền một sự kiện sàng lọc cụ thể: khách đang lạnh, phản hồi chậm bất thường, cơ hội nóng chưa ai nhận, đối thủ
xuất hiện, deadline (lời hứa) bị bỏ quên.

Chống trùng: loại theo **trạng thái đang kéo dài** (khách lạnh, cơ hội chưa nhận) dedupe theo (tổ chức, loại,
đối tượng) trong `DEDUPE_DAYS` ngày; loại theo **một sự kiện cụ thể** (đối thủ, phản hồi chậm) dedupe bằng
chứa đúng chứng cứ đó trong `evidence` (an toàn dù lượt quét chạy lại hay chồng lấn cửa sổ thời gian).
"""

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import realtime
from gh.biz.hooks import CronJob, Hook
from gh.providers.router import raise_alert

COOLING_DAYS = 14
COOLING_MIN_UNITS = 2
RESPONSE_SLA_MIN = 60
RESPONSE_WINDOW_H = 24
UNCLAIMED_AGE_H = 24
COMPETITOR_WINDOW_H = 2
DEDUPE_DAYS = 7
SCAN_LIMIT = 50


async def _already_open(db: AsyncSession, org_id: uuid.UUID, alert_type: str, subject_type: str,
                        subject_id: uuid.UUID) -> bool:
    return bool((await db.execute(text("""
        SELECT 1 FROM biz.alerts WHERE org_id = :o AND alert_type = :t AND subject_type = :st AND subject_id = :si
          AND created_at > now() - make_interval(days => :d)"""),
        {"o": org_id, "t": alert_type, "st": subject_type, "si": subject_id, "d": DEDUPE_DAYS})).first())


async def _already_evidenced(db: AsyncSession, org_id: uuid.UUID, alert_type: str, ref: dict[str, Any]) -> bool:
    import orjson

    return bool((await db.execute(text("""
        SELECT 1 FROM biz.alerts WHERE org_id = :o AND alert_type = :t
          AND evidence @> CAST(:ref AS jsonb)"""),
        {"o": org_id, "t": alert_type, "ref": orjson.dumps([ref]).decode()})).first())


async def _notify(redis: Any, org_id: uuid.UUID) -> None:
    if redis is not None:
        await realtime.publish(redis, "alert.new", {}, org_id=org_id)


# ─── khách đang lạnh / sắp mất ────────────────────────────────────────────────

async def _scan_customer_cooling(db: AsyncSession, org_id: uuid.UUID) -> int:
    rows = (await db.execute(text("""
        SELECT p.id, p.display_name, max(mu.observed_at) AS last_at, count(*) AS n,
               (array_agg(mu.id ORDER BY mu.observed_at DESC))[1] AS last_unit
        FROM core.persons p JOIN clean.meaning_units mu ON mu.person_id = p.id AND mu.superseded_by IS NULL
        WHERE p.org_id = :o AND p.deleted_at IS NULL AND p.merged_into_id IS NULL AND p.person_type = 'customer'
        GROUP BY p.id
        HAVING max(mu.observed_at) < now() - make_interval(days => :d) AND count(*) >= :n
        LIMIT :lim"""), {"o": org_id, "d": COOLING_DAYS, "n": COOLING_MIN_UNITS, "lim": SCAN_LIMIT})).all()
    n = 0
    for r in rows:
        if await _already_open(db, org_id, "customer_cooling", "person", r.id):
            continue
        await raise_alert(db, org_id, alert_type="customer_cooling", priority="P2",
                          title=f"{r.display_name} có thể đang lạnh dần", subject_type="person", subject_id=r.id,
                          summary=f"Không có tương tác mới trong {COOLING_DAYS} ngày qua",
                          suggested="Chủ động hỏi thăm hoặc gọi lại",
                          evidence=[{"type": "meaning_unit", "id": str(r.last_unit)}])
        n += 1
    return n


# ─── nhân viên phản hồi chậm bất thường ───────────────────────────────────────

async def _scan_slow_response(db: AsyncSession, org_id: uuid.UUID) -> int:
    rows = (await db.execute(text("""
        SELECT e.id AS raw_id, e.channel_id, e.group_id, p.id AS person_id, p.display_name AS person_name,
               p.owner_user_id, u.display_name AS owner_name
        FROM raw.events e
        JOIN core.channels c ON c.id = e.channel_id
        LEFT JOIN core.person_identities pi ON pi.id = e.sender_identity_id
        LEFT JOIN core.persons p ON p.id = pi.person_id
        LEFT JOIN core.users u ON u.id = p.owner_user_id
        WHERE c.org_id = :o AND e.direction = 'inbound'
          AND e.occurred_at < now() - make_interval(mins => :sla)
          AND e.occurred_at > now() - make_interval(hours => :win)
          AND NOT EXISTS (SELECT 1 FROM raw.events o2 WHERE o2.channel_id = e.channel_id
                          AND o2.group_id IS NOT DISTINCT FROM e.group_id
                          AND o2.direction = 'outbound' AND o2.occurred_at > e.occurred_at)
        ORDER BY e.occurred_at LIMIT :lim"""),
        {"o": org_id, "sla": RESPONSE_SLA_MIN, "win": RESPONSE_WINDOW_H, "lim": SCAN_LIMIT})).all()
    n = 0
    for r in rows:
        ref = {"type": "raw", "id": str(r.raw_id)}
        if await _already_evidenced(db, org_id, "slow_response", ref):
            continue
        who = r.person_name or "một khách"
        title = f"Chưa trả lời {who} sau {RESPONSE_SLA_MIN} phút"
        summary = f"Phụ trách: {r.owner_name}" if r.owner_name else "Chưa có người phụ trách"
        await raise_alert(db, org_id, alert_type="slow_response", priority="P2", title=title, summary=summary,
                          suggested="Trả lời ngay hoặc giao cho người khác", subject_type="person",
                          subject_id=r.person_id, evidence=[ref], personnel_related=r.owner_user_id is not None)
        n += 1
    return n


# ─── cơ hội nóng nhưng chưa ai nhận ────────────────────────────────────────────

async def _scan_unclaimed_opportunity(db: AsyncSession, org_id: uuid.UUID) -> int:
    rows = (await db.execute(text("""
        SELECT id, code, need FROM biz.opportunities
        WHERE org_id = :o AND owner_user_id IS NULL AND stage NOT IN ('won', 'lost', 'dormant')
          AND created_at < now() - make_interval(hours => :h)
        LIMIT :lim"""), {"o": org_id, "h": UNCLAIMED_AGE_H, "lim": SCAN_LIMIT})).all()
    n = 0
    for r in rows:
        if await _already_open(db, org_id, "unclaimed_opportunity", "opportunity", r.id):
            continue
        await raise_alert(db, org_id, alert_type="unclaimed_opportunity", priority="P1",
                          title=f"{r.code} chưa ai nhận sau {UNCLAIMED_AGE_H} giờ", summary=r.need,
                          suggested="Gán người phụ trách", subject_type="opportunity", subject_id=r.id,
                          evidence=[{"type": "opportunity", "id": str(r.id), "code": r.code}])
        n += 1
    return n


# ─── đối thủ xuất hiện trong hội thoại ─────────────────────────────────────────

async def _scan_competitor(db: AsyncSession, org_id: uuid.UUID) -> int:
    rows = (await db.execute(text("""
        SELECT mu.id, mu.person_id, mu.group_id, mu.conclusion FROM clean.meaning_units mu
        WHERE mu.org_id = :o AND mu.event_type = 'MentionsCompetitor' AND mu.superseded_by IS NULL
          AND mu.created_at > now() - make_interval(hours => :h)
        LIMIT :lim"""), {"o": org_id, "h": COMPETITOR_WINDOW_H, "lim": SCAN_LIMIT})).all()
    n = 0
    for r in rows:
        ref = {"type": "meaning_unit", "id": str(r.id)}
        if await _already_evidenced(db, org_id, "competitor", ref):
            continue
        await raise_alert(db, org_id, alert_type="competitor", priority="P2", title="Đối thủ xuất hiện trong hội thoại",
                          summary=r.conclusion, suggested="Xem lại giá / điều khoản đang chào",
                          subject_type="person" if r.person_id else "group", subject_id=r.person_id or r.group_id,
                          evidence=[ref])
        n += 1
    return n


# ─── deadline / lời hứa bị bỏ quên ─────────────────────────────────────────────

async def _scan_forgotten_deadline(db: AsyncSession, org_id: uuid.UUID) -> int:
    rows = (await db.execute(text("""
        SELECT id, promiser_person_id, text, meaning_unit_id FROM biz.promises
        WHERE org_id = :o AND kept_at IS NULL AND due_at < now() AND broken IS NOT TRUE
        LIMIT :lim"""), {"o": org_id, "lim": SCAN_LIMIT})).all()
    n = 0
    for r in rows:
        await db.execute(text("UPDATE biz.promises SET broken = true WHERE id = :i"), {"i": r.id})
        evidence = [{"type": "meaning_unit", "id": str(r.meaning_unit_id)}] if r.meaning_unit_id else []
        await raise_alert(db, org_id, alert_type="forgotten_deadline", priority="P1",
                          title="Một lời hứa đã quá hạn mà chưa thực hiện", summary=r.text,
                          suggested="Liên hệ lại và cập nhật tiến độ", subject_type="person",
                          subject_id=r.promiser_person_id, evidence=evidence)
        n += 1
    return n


async def early_warning_scan(ctx: dict[str, Any]) -> dict[str, int]:
    from gh.db import sessionmaker

    sm = sessionmaker()
    redis = ctx.get("redis_bus")
    out: dict[str, int] = {}
    async with sm() as db:
        orgs = (await db.execute(text("SELECT id FROM core.organizations"))).scalars().all()
    for org in orgs:
        async with sm() as db:
            n = (await _scan_customer_cooling(db, org)) + (await _scan_slow_response(db, org)) + \
                (await _scan_unclaimed_opportunity(db, org)) + (await _scan_competitor(db, org)) + \
                (await _scan_forgotten_deadline(db, org))
            await db.commit()
        if n:
            await _notify(redis, org)
        out[str(org)] = n
    return out


HOOKS: list[Hook] = []
JOBS: list[CronJob] = [(early_warning_scan, {"minute": set(range(3, 60, 15))})]
