"""/refinery/triage — cấu hình + số liệu lọc đầu Hộp thư (v0.1.25, Đợt C1; logic ở gh.refinery.triage).

- `GET /refinery/triage/settings` — ai đăng nhập cũng đọc được (Hộp thư cần biết có bật lọc và ngưỡng điểm).
- `PATCH /refinery/triage/settings` — CHỈ Owner; ghi Action Log `refinery.triage_settings_changed`.
- `GET /refinery/triage/summary` — số đếm (trùng/rác/điểm thấp/chờ lọc + Jev: số lượt, độ trễ, độ khớp quy tắc);
  quyền `queue.read` — Gen đọc qua tool `refinery.summary`.
"""

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import service
from gh.auth.deps import current_user, require, require_owner
from gh.chassis import actionlog
from gh.db import DB
from gh.refinery import triage

router = APIRouter(prefix="/refinery/triage", tags=["refinery"])


@router.get("/settings")
async def get_settings(user: service.CurrentUser = Depends(current_user), db: AsyncSession = DB) -> dict[str, Any]:
    return await triage.get_settings(db, user.org_id)


class TriageSettingsPatch(BaseModel):
    enabled: bool | None = None
    min_score: int | None = Field(default=None, ge=triage.MIN_SCORE_RANGE[0], le=triage.MIN_SCORE_RANGE[1])
    use_jev: bool | None = None


@router.patch("/settings")
async def patch_settings(body: TriageSettingsPatch, user: service.CurrentUser = Depends(require_owner),
                         db: AsyncSession = DB) -> dict[str, Any]:
    cfg = await triage.get_settings(db, user.org_id)
    changes = {k: v for k, v in body.model_dump(exclude_none=True).items() if cfg.get(k) != v}
    if changes:
        before = {k: cfg.get(k) for k in changes}
        cfg.update(changes)
        await triage.save_settings(db, user.org_id, cfg)
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="refinery.triage_settings_changed", target_type="settings",
                               target_id="triage", detail={"before": before, "after": changes}, ip=user.ip)
    return cfg


@router.get("/summary")
async def get_summary(days: int = Query(7, ge=1, le=90), user: service.CurrentUser = Depends(require("queue.read")),
                      db: AsyncSession = DB) -> dict[str, Any]:
    return await triage.summary(db, user.org_id, days)
