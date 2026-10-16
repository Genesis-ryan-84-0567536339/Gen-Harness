"""Làm mới cache tín hiệu của Gen hướng dẫn (v0.1.59, g6) — thẻ "Hôm nay của Sếp" đọc lại NGAY sau khi Sếp đổi cấu hình.

`signals.collect` cache tín hiệu một tổ chức 60 giây (`CACHE_KEY`). Mọi nơi vừa làm đổi thứ thẻ đó đọc (gọi thử nguồn
AI, lưu / gán model, kiểm "Việc Sếp cần làm") gọi `invalidate` sau khi ĐÃ commit để lượt mở thẻ kế tiếp dựng lại từ
CSDL — nếu không, thẻ còn báo "Gen chưa có model" tới 60 giây dù Sếp vừa Kiểm tra xanh.

Chỉ XOÁ khoá, không đọc / ghi nội dung. Redis vắng hoặc lỗi thì bỏ qua (cache tự hết hạn sau 60 giây): làm mới thẻ là
việc phụ, không bao giờ được làm hỏng thao tác chính của Sếp.
"""

import logging
import uuid
from typing import Any

from gh.gen.coach.signals import CACHE_KEY

log = logging.getLogger("gh.gen.coach")


async def invalidate(redis: Any, org_id: uuid.UUID) -> None:
    """Xoá cache tín hiệu coach của `org_id`. `redis` None hoặc lỗi ⇒ bỏ qua + ghi cảnh báo, không ném."""
    if redis is None:
        return
    try:
        await redis.delete(CACHE_KEY.format(org_id))
    except Exception:  # noqa: BLE001 — cache chỉ là tối ưu; lỗi Redis không được chặn thao tác của Sếp
        log.warning("Không làm mới được cache Gen hướng dẫn (%s)", org_id, exc_info=True)
