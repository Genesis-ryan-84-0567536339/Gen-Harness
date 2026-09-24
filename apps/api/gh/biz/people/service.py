"""Nền dùng chung của cụm Con người & Chất lượng (docs/api/phase-3-people.md): hình dạng dòng, board của Đánh
giá con người, cách ghép "tin đến → tin đi cùng luồng" dùng chung cho lưới phản hồi (`care`) và điểm hiệu suất
tự động (`people`).

`core.persons.person_type` đã có sẵn (`customer | partner | staff | candidate | learner | supplier | unknown`,
`docs/handoff/schema.sql`); F2 §6 gọi 4 board bằng tên khác — `BOARD_PERSON_TYPE` ánh xạ qua lại.
"""

import uuid
from typing import Any

TRENDS = ("up", "down", "flat")
DISPUTE_STATUSES = ("open", "resolved", "rejected")

# F2 §6 "Đánh giá con người": 4 board riêng — tên hiển thị khác `person_type` gốc.
BOARD_PERSON_TYPE = {"employee": "staff", "customer": "customer", "candidate": "candidate", "student": "learner"}

# Khung giờ phản hồi bắt buộc của PLAN §3.12: <15 / 15–60 / >60 phút.
FAST_MAX_MIN, NORMAL_MAX_MIN = 15, 60
ABANDON_HOURS = 24        # "khách bị bỏ rơi": tin đến chưa có tin đi cùng luồng sau ngần ấy giờ
REPEAT_THRESHOLD = 2      # từ 2 lần trở lên trong kỳ mới coi là "lặp lại" (không phải một lần lỡ tay)


def person_ref(r: Any, prefix: str = "p") -> dict[str, Any] | None:
    pid = getattr(r, f"{prefix}_id", None)
    if pid is None:
        return None
    return {"id": str(pid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "type": getattr(r, f"{prefix}_type", None), "org_name": getattr(r, f"{prefix}_org", None)}


def user_ref(id_: Any, name: str | None, role: str | None = None) -> dict[str, Any] | None:
    if id_ is None:
        return None
    return {"id": str(id_), "name": name, "role": role}


def uid_or_none(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


# LATERAL đúng một dòng vai trò của người dùng (cùng mẫu `gh.biz.market.service.USER_ROLE_JOIN`).
USER_ROLE_JOIN = """LEFT JOIN LATERAL (SELECT r2.code FROM core.user_roles ur2 JOIN core.roles r2
                                        ON r2.id = ur2.role_id WHERE ur2.user_id = {alias}.id LIMIT 1) {out} ON true"""


# ─── ghép "tin đến → tin đi cùng luồng" ─────────────────────────────────────────
#
# Cùng cách `gh.biz.queue.jobs._scan_slow_response` đã ghép (kênh + nhóm giống nhau, `direction`) để sinh cảnh
# báo `slow_response`: một luồng là (channel_id, group_id) — `group_id IS NOT DISTINCT FROM` để tin 1-1
# (`group_id IS NULL`) cũng ghép được với chính nó. Mỗi tin đến ghép với tin đi **sớm nhất** sau nó trên cùng
# luồng (LATERAL); không có tin đi nào sau → NULL (chưa trả lời — "khách bị bỏ rơi").
PAIR_CTE = """
WITH inbound AS (
  SELECT e.id, e.channel_id, e.group_id, e.occurred_at, cp.id AS customer_id
  FROM raw.events e
  JOIN core.channels ch ON ch.id = e.channel_id
  LEFT JOIN core.person_identities cpi ON cpi.id = e.sender_identity_id
  LEFT JOIN core.persons cp ON cp.id = cpi.person_id AND cp.deleted_at IS NULL AND cp.merged_into_id IS NULL
  WHERE ch.org_id = :o AND e.direction = 'inbound' AND e.occurred_at >= :df AND e.occurred_at <= :dt
),
paired AS (
  SELECT i.id, i.occurred_at AS asked_at, i.customer_id, o.occurred_at AS replied_at, o.staff_id
  FROM inbound i
  LEFT JOIN LATERAL (
    SELECT e2.occurred_at, sp.id AS staff_id
    FROM raw.events e2
    LEFT JOIN core.person_identities spi ON spi.id = e2.sender_identity_id
    LEFT JOIN core.persons sp ON sp.id = spi.person_id AND sp.person_type = 'staff'
    WHERE e2.channel_id = i.channel_id AND e2.group_id IS NOT DISTINCT FROM i.group_id
      AND e2.direction = 'outbound' AND e2.occurred_at > i.occurred_at
    ORDER BY e2.occurred_at LIMIT 1
  ) o ON true
)
"""

# 4 cột đếm theo khung giờ, tính trực tiếp trên `paired` (hoặc một CTE khác có cùng tên cột `asked_at`/
# `replied_at`) — dùng chung ở cả `care/response-times` lẫn job tính điểm hiệu suất.
BUCKET_SELECT = f"""
    count(*) FILTER (WHERE replied_at IS NOT NULL AND replied_at - asked_at < interval '{FAST_MAX_MIN} min')
      AS fast,
    count(*) FILTER (WHERE replied_at IS NOT NULL AND replied_at - asked_at >= interval '{FAST_MAX_MIN} min'
      AND replied_at - asked_at < interval '{NORMAL_MAX_MIN} min') AS normal,
    count(*) FILTER (WHERE replied_at IS NOT NULL AND replied_at - asked_at >= interval '{NORMAL_MAX_MIN} min')
      AS slow,
    count(*) FILTER (WHERE replied_at IS NULL) AS unanswered,
    avg(EXTRACT(EPOCH FROM (replied_at - asked_at))) FILTER (WHERE replied_at IS NOT NULL) AS avg_seconds
"""
