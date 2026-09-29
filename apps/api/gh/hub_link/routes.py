"""/hub — liên kết Gen-hub + đọc Kho Ryan (v0.1.26, docs/design/gen-hub-link.md §3.1).

- `GET /hub/link` — trạng thái (không bao giờ có token) · `system.read`.
- `PATCH /hub/link` — địa chỉ, token (chỉ ghi), ngày hết hạn, mạng công cộng, tắt · Owner + PIN `hub.link`.
- `POST /hub/link/test` — khám phá, mở + cấp `core.gen` đúng tool đọc Kho, gọi `kho_tom_tat` · Owner + PIN.
- `GET /hub/kho/summary|search|records/{ma}` — đọc Kho (đã che, đệm 5 phút) · CHỈ Owner (quyết định Boss #1).
"""

from datetime import datetime
from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import require, require_owner, require_pin
from gh.db import DB
from gh.errors import field_errors
from gh.hub_link import service as hub

router = APIRouter(prefix="/hub", tags=["hub"])
READ = require("system.read", rbac.ALL)
MANAGE = require("system.manage", rbac.ALL)


def _client(request: Request) -> Any:
    return hub.client_for(getattr(request.app.state, "mcp_transport", None))


@router.get("/link")
async def get_link(user: service.CurrentUser = Depends(READ), db: AsyncSession = DB) -> dict[str, Any]:
    return hub.link_out(await hub.load(db, user.org_id))


class LinkPatch(BaseModel):
    endpoint: str | None = Field(default=None, min_length=1, max_length=2000)
    token: str | None = Field(default=None, max_length=4000)
    token_expires_at: datetime | None = None
    allow_public_network: bool | None = None
    enabled: bool | None = None


@router.patch("/link")
async def patch_link(body: LinkPatch, request: Request, _m: service.CurrentUser = Depends(MANAGE),
                     _o: service.CurrentUser = Depends(require_owner),
                     user: service.CurrentUser = Depends(require_pin("hub.link")),
                     db: AsyncSession = DB) -> dict[str, Any]:
    errors: dict[str, str] = {}
    endpoint = body.endpoint.strip() if body.endpoint is not None else None
    if endpoint is not None:
        u = urlparse(endpoint)
        if u.scheme not in ("https", "http") or not u.hostname:
            errors["endpoint"] = "Địa chỉ phải dạng https://<máy chủ Gen-hub>/mcp"
        elif u.scheme == "http" and body.allow_public_network:
            errors["endpoint"] = "Gen-hub ở mạng công cộng phải dùng https://"
    token = body.token.strip() if body.token is not None else None
    if body.token is not None and (not token or len(token) < 8):
        errors["token"] = "Token quá ngắn — dán đúng token agent tạo trong Gen-hub"
    if body.enabled is True:
        errors["enabled"] = "Bấm \"Kiểm tra\" để bật liên kết"
    if body.token_expires_at is not None and body.token_expires_at.tzinfo is None:
        errors["token_expires_at"] = "Cần kèm múi giờ (ISO 8601)"
    if errors:
        raise field_errors(errors)
    row = await hub.upsert(db, request.app.state.redis, user=user, endpoint=endpoint, token=token or None,
                           token_expires_at=body.token_expires_at,
                           set_expiry="token_expires_at" in body.model_fields_set,
                           allow_public_network=body.allow_public_network, disable=body.enabled is False)
    return hub.link_out(row)


@router.post("/link/test")
async def test_link(request: Request, _m: service.CurrentUser = Depends(MANAGE),
                    _o: service.CurrentUser = Depends(require_owner),
                    user: service.CurrentUser = Depends(require_pin("hub.link")),
                    db: AsyncSession = DB) -> dict[str, Any]:
    return await hub.test_link(db, request.app.state.redis, _client(request), user=user)


# ─── đọc Kho: chỉ Owner ────────────────────────────────────────────────────────

@router.get("/kho/summary")
async def kho_summary(request: Request, so_phien: int | None = Query(None, ge=1, le=5),
                      _r: service.CurrentUser = Depends(READ), user: service.CurrentUser = Depends(require_owner),
                      db: AsyncSession = DB) -> dict[str, Any]:
    args: dict[str, Any] = {"so_phien": so_phien} if so_phien else {}
    return await hub.call_kho(db, request.app.state.redis, _client(request), user=user, suffix="kho_tom_tat",
                              args=args)


@router.get("/kho/search")
async def kho_search(request: Request, q: str = Query(min_length=1, max_length=200),
                     bang: str | None = Query(None, max_length=40), _r: service.CurrentUser = Depends(READ),
                     user: service.CurrentUser = Depends(require_owner), db: AsyncSession = DB) -> dict[str, Any]:
    args: dict[str, Any] = {"text": q.strip()}
    if bang and bang.strip():
        args["bang"] = bang.strip()
    return await hub.call_kho(db, request.app.state.redis, _client(request), user=user, suffix="kho_search",
                              args=args)


@router.get("/kho/records/{ma}")
async def kho_record(ma: str, request: Request, _r: service.CurrentUser = Depends(READ),
                     user: service.CurrentUser = Depends(require_owner), db: AsyncSession = DB) -> dict[str, Any]:
    code = ma.strip().upper()
    if not hub.RECORD_RE.fullmatch(code):
        raise field_errors({"ma": "Mã bản ghi dạng VIEC-12, QD-3, PHIEN-1"})
    return await hub.call_kho(db, request.app.state.redis, _client(request), user=user, suffix="kho_find_by_id",
                              args={"id": code})


__all__ = ["router"]
