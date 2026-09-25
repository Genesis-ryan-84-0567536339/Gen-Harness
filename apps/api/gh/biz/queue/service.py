"""Nền dùng chung của cụm Hàng đợi & Hành động: hình dạng, phạm vi, phân loại tab, im lặng có chủ đích.

`biz.inbox_items` (view, `db/sql/0005_p3_queue.sql`) hợp nhất đơn vị ý nghĩa mới + cảnh báo đang mở + bản nháp
chờ duyệt. Việc (`biz.tasks`) có màn riêng nên không nằm trong view này; khối "Đến hạn" của Tổng quan được ghép
thêm bằng một truy vấn riêng (`routes.py: _queue_widget`).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.biz.core.scope import Scope
from gh.data.common import iso


def when(value: Any) -> datetime | None:
    """asyncpg đòi kiểu Python gốc cho tham số so sánh/ép `timestamptz` — không nhận chuỗi ISO trực tiếp
    (`CAST(:x AS timestamptz)` với `:x` là `str` làm asyncpg suy ra kiểu tham số là `timestamptz` và từ chối
    chuỗi ở bước bind, khác hẳn cách driver `psycopg` vẫn chấp nhận)."""
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))

# Nhãn tiếng Việt cho event_type (spec G3) — dùng làm tiêu đề thẻ ở Hộp thư / Tổng quan.
EVENT_LABELS = {
    "AskedPrice": "Hỏi giá", "OfferedSupply": "Chào bán", "RequestedPartnership": "Đề nghị hợp tác",
    "Complained": "Than phiền", "PromisedDelivery": "Cam kết giao hàng", "ScheduledMeeting": "Hẹn gặp",
    "SentQuotation": "Đã gửi báo giá", "MentionsCompetitor": "Nhắc đối thủ", "WentSilent": "Im lặng bất thường",
}
ALERT_TYPE_LABELS = {
    "customer_cooling": "Khách đang lạnh / sắp mất", "slow_response": "Phản hồi chậm bất thường",
    "repeated_complaint": "Than phiền lặp lại", "unclaimed_opportunity": "Cơ hội nóng chưa ai nhận",
    "competitor": "Đối thủ xuất hiện", "forgotten_deadline": "Deadline bị bỏ quên",
    "data_conflict": "Dữ liệu mâu thuẫn", "model_quota_low": "Hạn mức model sắp hết",
    "model_chain_exhausted": "Hết chuỗi model",
}
# Đơn vị ý nghĩa nào rơi vào tab nào của Hộp thư (mục "Chỗ tự quyết" trong docs/api/phase-3-queue.md).
OPPORTUNITY_EVENTS = frozenset({"AskedPrice", "OfferedSupply", "RequestedPartnership"})
REPLY_EVENTS = frozenset({"Complained", "ScheduledMeeting", "SentQuotation", "PromisedDelivery"})
TABS = ("all", "opportunity", "alert", "approval", "reply", "candidate")
ITEM_TYPES = ("unit", "alert", "draft")


def item_scope_sql(sc: Scope, alias: str = "i") -> tuple[str, dict[str, Any]]:
    """Một dòng `biz.inbox_items` thấy được khi đối tượng nó gắn vào trong phạm vi, hoặc chính item được giao
    thẳng cho mình / team mình (`core.assignments(subject_type='queue')`, dùng khi giao mà không cần sở hữu
    người/nhóm — ví dụ Operator được giao xử lý một cảnh báo cụ thể)."""
    if sc.is_all:
        return "TRUE", {}
    sw, sp = sc.subject_sql(f"{alias}.subject_type", f"{alias}.subject_id")
    q = (f"EXISTS (SELECT 1 FROM core.assignments qa WHERE qa.subject_type = 'queue' "
         f"AND qa.subject_id = {alias}.item_id AND qa.active_to IS NULL AND qa.user_id = ANY(:scope_users))")
    return f"({sw} OR {q})", sp


def not_silenced_sql(alias: str = "i") -> str:
    return (f"NOT EXISTS (SELECT 1 FROM biz.queue_silences qs WHERE qs.item_type = {alias}.item_type "
            f"AND qs.item_id = {alias}.item_id AND (qs.until IS NULL OR qs.until > now()))")


def tab_of(item_type: str, event_type: str | None, person_type: str | None) -> str:
    if item_type == "alert":
        return "alert"
    if item_type == "draft":
        return "approval"
    if person_type == "candidate":
        return "candidate"
    if event_type in OPPORTUNITY_EVENTS:
        return "opportunity"
    if event_type in REPLY_EVENTS:
        return "reply"
    return "other"


def person_ref(r: Any, prefix: str = "p") -> dict[str, Any] | None:
    pid = getattr(r, f"{prefix}_id", None)
    if pid is None:
        return None
    return {"id": str(pid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "type": getattr(r, f"{prefix}_type", None), "org_name": getattr(r, f"{prefix}_org", None)}


def group_ref(r: Any, prefix: str = "g") -> dict[str, Any] | None:
    gid = getattr(r, f"{prefix}_id", None)
    if gid is None:
        return None
    return {"id": str(gid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "channel": getattr(r, f"{prefix}_channel", None)}


def subject_ref(r: Any) -> dict[str, Any] | None:
    return person_ref(r, "p") or group_ref(r, "g")


CONFIDENCE_BAND_HIGH, CONFIDENCE_BAND_MED = 0.8, 0.6


def confidence_band(v: float | None) -> str | None:
    if v is None:
        return None
    if v >= CONFIDENCE_BAND_HIGH:
        return "cao"
    if v >= CONFIDENCE_BAND_MED:
        return "trung bình"
    return "thấp"


async def silence(db: AsyncSession, org_id: uuid.UUID, item_type: str, item_id: uuid.UUID, *, user_id: uuid.UUID,
                  reason: str | None, until: str | None) -> None:
    await db.execute(text("""
        INSERT INTO biz.queue_silences (org_id, item_type, item_id, reason, until, silenced_by)
        VALUES (:o, :t, :i, :r, :u, :by)
        ON CONFLICT (item_type, item_id) DO UPDATE
          SET reason = EXCLUDED.reason, until = EXCLUDED.until, silenced_by = EXCLUDED.silenced_by,
              silenced_at = now()"""),
        {"o": org_id, "t": item_type, "i": item_id, "r": reason, "u": when(until), "by": user_id})


async def assign(db: AsyncSession, org_id: uuid.UUID, item_type: str, item_id: uuid.UUID, *, to_user: uuid.UUID,
                 by_user: uuid.UUID) -> None:
    await db.execute(text("""UPDATE core.assignments SET active_to = now()
                             WHERE subject_type = 'queue' AND subject_id = :i AND active_to IS NULL"""),
                     {"i": item_id})
    await db.execute(text("""INSERT INTO core.assignments (org_id, user_id, subject_type, subject_id, created_by)
                             VALUES (:o, :u, 'queue', :i, :by)"""),
                     {"o": org_id, "u": to_user, "i": item_id, "by": by_user})
    _ = item_type  # giữ tham số cho chữ ký đối xứng với silence(); id đã đủ duy nhất toàn hệ thống


def iso_or_none(v: Any) -> str | None:
    return iso(v) if hasattr(v, "astimezone") else v
