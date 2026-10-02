"""GET /system/health — thẻ "Sức khoẻ hệ thống" (Điều khiển hệ thống › Dữ liệu & lưu trữ) và dải "Cần Sếp xử lý".

v0.1.36 (F-6): đọc thuần — không gửi chuông (chuông do vòng theo dõi `gh.health.watch_loop` và các sự kiện gửi).
KHÔNG thuộc `/ready`: genh dùng `/ready` để quyết rollback khi cập nhật.

v0.1.41 (F-84): `/system/ai-cost` — "Chi phí AI hôm nay" theo agent (giờ VN), bảng giá theo model (VND / 1 triệu
token) và "Trần chi phí mỗi ngày" (gh/ai_cost.py). Đọc cần `system.read`; đổi giá/trần cần `system.manage`.
"""

import uuid
from datetime import date
from typing import Any

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from gh import ai_cost, health
from gh.auth import rbac, service
from gh.auth.deps import require
from gh.chassis import actionlog
from gh.db import DB
from gh.errors import not_found

router = APIRouter(tags=["system"])


@router.get("/system/health")
async def system_health(request: Request, db: AsyncSession = DB,
                        user: service.CurrentUser = Depends(require("system.read"))) -> dict[str, Any]:
    """Bộ xử lý nền, trình duyệt nền, hàng đợi lỗi, lịch chạy, sao lưu, cập nhật, ổ đĩa và các sự cố đang mở."""
    return await health.collect(db, request.app.state.redis, user.org_id,
                                started_at=getattr(request.app.state, "health_started_at", None),
                                is_owner=user.role_code == rbac.OWNER)


@router.get("/system/ai-cost")
async def get_ai_cost(day: date | None = Query(None, alias="date"), db: AsyncSession = DB,
                      user: service.CurrentUser = Depends(require("system.read"))) -> dict[str, Any]:
    """Chi phí AI của ngày `date` (YYYY-MM-DD, giờ VN; mặc định hôm nay) theo agent, giá từng model, 7 ngày gần nhất,
    đánh giá Hữu ích 7 ngày."""
    return await ai_cost.summary(db, user.org_id, day)


class BudgetIn(BaseModel):
    daily_budget_vnd: int | None = Field(default=None, ge=0, le=ai_cost.MAX_BUDGET_VND)


@router.put("/system/ai-cost/budget")
async def put_ai_budget(body: BudgetIn, db: AsyncSession = DB,
                        user: service.CurrentUser = Depends(require("system.manage"))) -> dict[str, Any]:
    """Đặt/bỏ "Trần chi phí mỗi ngày" (null = bỏ trần). Chuông vượt trần do vòng theo dõi sức khoẻ gửi."""
    before = await ai_cost.get_budget(db, user.org_id)
    await ai_cost.set_budget(db, user.org_id, body.daily_budget_vnd)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="ai.budget_changed", target_type="settings", target_id="ai_cost",
                           detail={"from": before, "to": body.daily_budget_vnd}, ip=user.ip)
    return await ai_cost.summary(db, user.org_id)


class PriceIn(BaseModel):
    in_vnd_per_mtok: float | None = Field(default=None, ge=0, le=ai_cost.MAX_PRICE_PER_MTOK)
    out_vnd_per_mtok: float | None = Field(default=None, ge=0, le=ai_cost.MAX_PRICE_PER_MTOK)


@router.put("/system/ai-cost/prices/{model_id}")
async def put_ai_price(model_id: uuid.UUID, body: PriceIn, db: AsyncSession = DB,
                       user: service.CurrentUser = Depends(require("system.manage"))) -> dict[str, Any]:
    """Giá model (VND / 1 triệu token vào/ra). Cả hai null ⇒ xoá giá (model về "chưa có giá"). Giá áp lại cho cả
    lịch sử (tính lúc đọc)."""
    if not await ai_cost.model_in_org(db, user.org_id, model_id):
        raise not_found("Model")
    await ai_cost.set_price(db, user.org_id, model_id, body.in_vnd_per_mtok, body.out_vnd_per_mtok, user.id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="ai.price_changed", target_type="model", target_id=str(model_id),
                           detail={"in_vnd_per_mtok": body.in_vnd_per_mtok,
                                   "out_vnd_per_mtok": body.out_vnd_per_mtok}, ip=user.ip)
    return await ai_cost.summary(db, user.org_id)
