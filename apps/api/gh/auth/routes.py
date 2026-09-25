"""/auth — đăng nhập, đăng xuất, thông tin người dùng, PIN."""

from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import service
from gh.auth.deps import client_ip, current_user, require_pin
from gh.chassis import actionlog
from gh.config import get_settings
from gh.db import DB
from gh.errors import ApiError, field_errors

router = APIRouter(prefix="/auth", tags=["auth"])


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class PinIn(BaseModel):
    pin: str = Field(max_length=16)


class PinChangeIn(BaseModel):
    current_pin: str = Field(max_length=16)
    new_pin: str = Field(max_length=16)


def set_session_cookies(response: Response, s: service.NewSession) -> None:
    secure = get_settings().cookie_secure
    response.set_cookie(service.SESSION_COOKIE, s.token, expires=s.expires_at, httponly=True, secure=secure,
                        samesite="strict", path="/")
    response.set_cookie(service.CSRF_COOKIE, s.csrf, expires=s.expires_at, httponly=False, secure=secure,
                        samesite="strict", path="/")


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(service.SESSION_COOKIE, path="/")
    response.delete_cookie(service.CSRF_COOKIE, path="/")


async def me_payload(db: AsyncSession, user: service.CurrentUser) -> dict[str, Any]:
    org = (await db.execute(text("SELECT id, name, timezone, currency FROM core.organizations WHERE id = :o"),
                            {"o": user.org_id})).one()
    return {
        "id": str(user.id), "email": user.email, "display_name": user.display_name,
        "role": {"code": user.role_code, "name": user.role_name},
        "org": {"id": str(org.id), "name": org.name, "timezone": org.timezone, "currency": org.currency.strip()},
        "addressing": user.addressing,
        "pin_verified_until": _iso(user.pin_verified_until),
        "permissions": user.permissions,
    }


def _iso(dt: datetime | None) -> str | None:
    return dt.isoformat().replace("+00:00", "Z") if dt else None


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response,
                db: AsyncSession = DB) -> dict[str, Any]:
    found = await service.login(db, body.email, body.password)
    ip = client_ip(request)
    if found is None:
        org_id = (await db.execute(text("SELECT id FROM core.organizations ORDER BY created_at LIMIT 1"))).scalar()
        if org_id is not None:
            await actionlog.record(db, org_id=org_id, actor_type="system", actor_id="system:auth",
                                   action="auth.login_failed", result="failed",
                                   detail={"email": body.email.strip().lower()}, ip=ip)
            await db.commit()
        raise ApiError(401, "INVALID_CREDENTIALS", "Email hoặc mật khẩu không đúng")
    new = await service.create_session(db, found["id"], ip=ip, user_agent=request.headers.get("user-agent"))
    user = await service.load_session(db, new.token)
    assert user is not None
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="auth.login", ip=ip)
    set_session_cookies(response, new)
    return await me_payload(db, user)


@router.post("/logout", status_code=204)
async def logout(response: Response, user: service.CurrentUser = Depends(current_user),
                 db: AsyncSession = DB) -> Response:
    await service.revoke_session(db, user.session_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="auth.logout", ip=user.ip)
    response.status_code = 204
    clear_session_cookies(response)
    return response


@router.get("/me")
async def me(user: service.CurrentUser = Depends(current_user),
             db: AsyncSession = DB) -> dict[str, Any]:
    return await me_payload(db, user)


@router.post("/pin/verify")
async def pin_verify(body: PinIn, user: service.CurrentUser = Depends(current_user),
                     db: AsyncSession = DB) -> dict[str, Any]:
    result = await service.verify_pin(db, user, body.pin)
    if result.ok:
        return {"pin_verified_until": _iso(result.pin_verified_until)}
    await db.commit()  # số lần sai và dòng nhật ký phải được lưu dù trả lỗi
    if result.locked_until is not None:
        raise ApiError(423, "PIN_LOCKED", "Mã PIN đang bị khoá do nhập sai nhiều lần",
                       {"locked_until": _iso(result.locked_until)}, locked_until=_iso(result.locked_until))
    raise ApiError(401, "PIN_INVALID", "Mã PIN không đúng", attempts_left=result.attempts_left)


@router.put("/pin", status_code=204)
async def pin_change(body: PinChangeIn, response: Response,
                     user: service.CurrentUser = Depends(require_pin("pin.change")),
                     db: AsyncSession = DB) -> Response:
    if not service.valid_pin(body.new_pin):
        raise field_errors({"new_pin": "PIN gồm đúng 6 chữ số"})
    check = await service.verify_pin(db, user, body.current_pin)
    if not check.ok:
        await db.commit()
        if check.locked_until is not None:
            raise ApiError(423, "PIN_LOCKED", "Mã PIN đang bị khoá do nhập sai nhiều lần",
                           {"locked_until": _iso(check.locked_until)}, locked_until=_iso(check.locked_until))
        raise ApiError(401, "PIN_INVALID", "Mã PIN hiện tại không đúng", attempts_left=check.attempts_left)
    await service.set_pin(db, user.id, body.new_pin)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="auth.pin_changed", ip=user.ip)
    response.status_code = 204
    return response
