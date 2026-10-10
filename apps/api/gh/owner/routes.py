"""/owner — API Mặt tiền Owner (v0.1.55, gói G5). CHỈ ĐỌC, CHỈ Owner (vai trò khác → 403 FORBIDDEN).

- `GET /today` — Hôm nay: Cần Sếp duyệt (≤ 10), 4 số, Bản tin mới nhất, giá trị bộ lọc, gợi ý, tiến độ việc bắt buộc.
- `GET /relations?list=hot|cooling|bridges|matches&limit=20` — Quan hệ: 4 danh sách, mỗi dòng mở Hồ sơ sống
  (limit chặn ≤ 50).
- `GET /tasks` — Việc: Hộp thư đã lọc, Bàn làm việc, Việc & Nhắc hẹn (đếm + vài dòng + link sâu).

KHÔNG có POST/PUT/PATCH/DELETE: mọi thao tác ghi đi qua luồng sẵn có (duyệt nháp, đề xuất Gen + mã PIN, Bộ não AI) —
test `test_owner_v0155` kiểm không có decorator ghi nào trong tệp này. Không gọi model, không ghi Action Log.
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import service
from gh.auth.deps import require_owner
from gh.db import DB
from gh.owner import service as svc

router = APIRouter(prefix="/owner", tags=["owner"])


@router.get("/today")
async def get_today(user: service.CurrentUser = Depends(require_owner), db: AsyncSession = DB) -> dict[str, Any]:
    return await svc.today(db, user.org_id, user.id)


@router.get("/relations")
async def get_relations(list: Literal["hot", "cooling", "bridges", "matches"] = Query("hot"),  # noqa: A002
                        limit: int = Query(svc.DEFAULT_LIMIT, description="Chặn trong [1, 50]"),
                        user: service.CurrentUser = Depends(require_owner), db: AsyncSession = DB) -> dict[str, Any]:
    return await svc.relations(db, user.org_id, list, svc.clamp_limit(limit))


@router.get("/tasks")
async def get_tasks(user: service.CurrentUser = Depends(require_owner), db: AsyncSession = DB) -> dict[str, Any]:
    return await svc.tasks(db, user.org_id)
