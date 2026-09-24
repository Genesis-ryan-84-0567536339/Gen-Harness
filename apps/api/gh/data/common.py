"""Tiện ích dùng chung cho tầng dữ liệu: mã công khai, dòng Kho thô, thời gian."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

CHANNEL_PREFIX = {"zalo": "ZL", "whatsapp": "WA", "telegram": "TG", "linkedin": "LI"}
CHANNEL_NAME = {"zalo": "Zalo", "whatsapp": "WhatsApp", "telegram": "Telegram", "linkedin": "LinkedIn"}
LISTENING_MODES = ("tagged_only", "silent", "proactive")
SINCE = {"24h": timedelta(hours=24), "7d": timedelta(days=7), "30d": timedelta(days=30)}
RAW_CODE_RE = re.compile(r"^RAW-(\d+)$")


def iso(dt: datetime | None) -> str | None:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z") if dt else None


def parse_cursor(cursor: str | None) -> datetime | None:
    """Con trỏ phân trang kiểu `created_at < :c`: asyncpg suy ra kiểu tham số từ `CAST(:c AS timestamptz)` và từ
    chối bind một `str` ở đó (khác `psycopg`, vẫn chấp nhận) — luôn ép sang `datetime` trước khi bind, để SQL chỉ
    cần so sánh `:c` trực tiếp, không cần `CAST`."""
    return datetime.fromisoformat(cursor.replace("Z", "+00:00")) if cursor else None


def since_cutoff(since: str | None) -> datetime | None:
    if not since or since == "all":
        return None
    delta = SINCE.get(since)
    if delta is None:
        from gh.errors import field_errors

        raise field_errors({"since": "Chỉ nhận 24h, 7d, 30d, all"})
    return datetime.now(UTC) - delta


def raw_code(seq: int) -> str:
    return f"RAW-{seq:06d}"


def ref(id: Any, code: str | None, name: str | None) -> dict[str, Any] | None:
    if id is None:
        return None
    return {"id": str(id), "code": code, "name": name}


# Một dòng Kho thô kèm nhóm, người, trạng thái sàng lọc. Dùng chung cho danh sách, chi tiết, WebSocket, chứng cứ.
RAW_SELECT = """
SELECT e.id, e.seq, e.received_at, e.occurred_at, e.direction, e.kind, e.body_text, e.payload,
       c.type AS channel_type, c.name AS channel_name,
       g.id AS group_id, g.code AS group_code, g.name AS group_name,
       p.id AS person_id, p.code AS person_code, p.display_name AS person_name,
       s.state, s.label, s.confidence
FROM raw.events e
JOIN core.channels c ON c.id = e.channel_id
LEFT JOIN core.groups g ON g.id = e.group_id
LEFT JOIN core.person_identities pi ON pi.id = e.sender_identity_id
LEFT JOIN LATERAL (
  -- người sống sau hợp nhất: đi theo merged_into_id tới hồ sơ gốc
  WITH RECURSIVE up(id, merged_into_id, depth) AS (
    SELECT id, merged_into_id, 0 FROM core.persons WHERE id = pi.person_id
    UNION ALL SELECT q.id, q.merged_into_id, up.depth + 1 FROM core.persons q JOIN up ON q.id = up.merged_into_id
    WHERE up.depth < 10)
  SELECT id FROM up WHERE merged_into_id IS NULL LIMIT 1) live ON true
LEFT JOIN core.persons p ON p.id = live.id
LEFT JOIN refinery.event_state s ON s.event_id = e.id AND s.event_received_at = e.received_at
"""


def raw_item(r: Any, *, with_payload: bool = False) -> dict[str, Any]:
    out = {
        "id": str(r.id), "code": raw_code(r.seq), "received_at": iso(r.received_at),
        "occurred_at": iso(r.occurred_at),
        "channel": {"type": r.channel_type, "name": CHANNEL_NAME.get(r.channel_type, r.channel_name)},
        "group": ref(r.group_id, r.group_code, r.group_name),
        "person": ref(r.person_id, r.person_code, r.person_name),
        "direction": r.direction, "kind": r.kind, "text": r.body_text,
        "label": r.label, "confidence": float(r.confidence) if r.confidence is not None else None,
        "state": r.state or "pending",
    }
    if with_payload:
        out["payload"] = r.payload
    return out


async def fetch_raw(db: AsyncSession, event_id: uuid.UUID) -> Any:
    return (await db.execute(text(RAW_SELECT + " WHERE e.id = :i"), {"i": event_id})).one_or_none()


async def org_settings(db: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    return (await db.execute(text("SELECT settings FROM core.organizations WHERE id = :o"),
                             {"o": org_id})).scalar_one() or {}


async def live_person(db: AsyncSession, person_id: uuid.UUID) -> uuid.UUID:
    """Hồ sơ đang sống của một người (đi theo merged_into_id)."""
    seen = 0
    while seen < 10:
        nxt = (await db.execute(text("SELECT merged_into_id FROM core.persons WHERE id = :i"),
                                {"i": person_id})).scalar_one_or_none()
        if nxt is None:
            return person_id
        person_id, seen = nxt, seen + 1
    return person_id


# Khoá cứng 8: ẩn dữ liệu nhạy cảm khỏi vai trò dưới Owner (số tài khoản / thẻ / giấy tờ, số điện thoại đầy đủ).
_RE_LONGNUM = re.compile(r"(?<!\d)(\d[\d .-]{7,22}\d)(?!\d)")


def mask_text(text_: str | None, is_owner: bool) -> str | None:
    if text_ is None or is_owner:
        return text_

    def sub(m: re.Match[str]) -> str:
        digits = re.sub(r"\D", "", m.group(1))
        return m.group(1) if len(digits) < 8 else "•" * (len(digits) - 3) + digits[-3:]

    return _RE_LONGNUM.sub(sub, text_)
