"""GET /system/health — thẻ "Sức khoẻ hệ thống" (Điều khiển hệ thống › Dữ liệu & lưu trữ) và dải "Cần Sếp xử lý".

v0.1.36 (F-6): đọc thuần — không gửi chuông (chuông do vòng theo dõi `gh.health.watch_loop` và các sự kiện gửi).
KHÔNG thuộc `/ready`: genh dùng `/ready` để quyết rollback khi cập nhật.
"""

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from gh import health
from gh.auth import rbac, service
from gh.auth.deps import require
from gh.db import DB

router = APIRouter(tags=["system"])


@router.get("/system/health")
async def system_health(request: Request, db: AsyncSession = DB,
                        user: service.CurrentUser = Depends(require("system.read"))) -> dict[str, Any]:
    """Bộ xử lý nền, trình duyệt nền, hàng đợi lỗi, lịch chạy, sao lưu, cập nhật, ổ đĩa và các sự cố đang mở."""
    return await health.collect(db, request.app.state.redis, user.org_id,
                                started_at=getattr(request.app.state, "health_started_at", None),
                                is_owner=user.role_code == rbac.OWNER)
