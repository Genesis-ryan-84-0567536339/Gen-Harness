"""Đăng nhập, phiên, PIN (ARCHITECTURE §8.1–8.2)."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.chassis import actionlog
from gh.config import get_settings
from gh.crypto import hash_secret, new_token, token_digest, verify_secret

SESSION_COOKIE = "gh_session"
CSRF_COOKIE = "gh_csrf"

# Thao tác cần phiên PIN (một chỗ duy nhất; backend kiểm, UI chỉ bật hộp nhập).
PIN_OPERATIONS: dict[str, str] = {
    "channel.logout": "Đăng xuất kênh",
    "channel.login": "Đăng nhập kênh (quét QR)",
    "cli.switch_account": "Đổi tài khoản Antigravity CLI",
    "plugin.install": "Cài plugin",
    "plugin.uninstall": "Gỡ plugin",
    "plugin.toggle": "Bật/tắt plugin",
    "roles.change": "Đổi quyền",
    "secret.reveal": "Xem khoá API",
    "identity.merge": "Gộp / tách danh tính",
    "data.export": "Xuất dữ liệu thô",
    "draft.decide": "Duyệt / huỷ bản nháp",
    "mcp.expose": "Mở tool MCP",
    "policy.change": "Đổi mức tự trị, ngưỡng tiền, ranh giới",
    "data.export_delete": "Xuất / xoá dữ liệu",
    "people_review.read": "Xem dữ liệu đánh giá nhân sự",
    "pin.change": "Đổi mã PIN",
}


def now() -> datetime:
    return datetime.now(UTC)


@dataclass
class CurrentUser:
    id: uuid.UUID
    org_id: uuid.UUID
    email: str
    display_name: str
    role_code: str
    role_name: str
    role_id: uuid.UUID
    team_id: uuid.UUID | None
    session_id: uuid.UUID
    pin_verified_until: datetime | None
    addressing: dict[str, Any]
    permissions: dict[str, str] = field(default_factory=dict)
    ip: str | None = None

    @property
    def actor_id(self) -> str:
        return f"user:{self.id}"

    def pin_active(self) -> bool:
        return self.pin_verified_until is not None and self.pin_verified_until > now()


@dataclass
class NewSession:
    token: str
    csrf: str
    expires_at: datetime


async def create_session(db: AsyncSession, user_id: uuid.UUID, *, ip: str | None, user_agent: str | None,
                         pin_verified: bool = False) -> NewSession:
    s = get_settings()
    token, csrf = new_token(), new_token(16)
    expires = now() + timedelta(hours=s.session_ttl_hours)
    await db.execute(text("""
        INSERT INTO core.sessions (user_id, token_hash, csrf_hash, ip, user_agent, expires_at, last_seen_at,
                                   pin_verified_until)
        VALUES (:uid, :th, :ch, CAST(:ip AS inet), :ua, :exp, now(), :pin)"""),
        {"uid": user_id, "th": token_digest(token), "ch": token_digest(csrf), "ip": ip, "ua": user_agent,
         "exp": expires, "pin": now() + timedelta(minutes=s.pin_session_minutes) if pin_verified else None})
    await db.execute(text("UPDATE core.users SET last_login_at = now() WHERE id = :uid"), {"uid": user_id})
    return NewSession(token=token, csrf=csrf, expires_at=expires)


async def login(db: AsyncSession, email: str, password: str) -> dict[str, Any] | None:
    row = (await db.execute(text("""
        SELECT id, org_id, password_hash FROM core.users
        WHERE email = :e AND is_active AND deleted_at IS NULL"""), {"e": email.strip()})).one_or_none()
    if row is None or not verify_secret(row.password_hash, password):
        return None
    return {"id": row.id, "org_id": row.org_id}


async def load_session(db: AsyncSession, token: str) -> CurrentUser | None:
    row = (await db.execute(text("""
        SELECT s.id AS sid, s.pin_verified_until, u.id, u.org_id, u.email, u.display_name, u.addressing,
               r.id AS role_id, r.code AS role_code, r.name AS role_name, ur.team_id
        FROM core.sessions s
        JOIN core.users u ON u.id = s.user_id
        JOIN core.user_roles ur ON ur.user_id = u.id
        JOIN core.roles r ON r.id = ur.role_id
        WHERE s.token_hash = :h AND s.revoked_at IS NULL AND s.expires_at > now()
          AND u.is_active AND u.deleted_at IS NULL
        ORDER BY r.code LIMIT 1"""), {"h": token_digest(token)})).one_or_none()
    if row is None:
        return None
    perms = {r.permission_code: r.scope for r in (await db.execute(text(
        "SELECT permission_code, scope FROM core.role_permissions WHERE role_id = :r"), {"r": row.role_id})).all()}
    pin_until = row.pin_verified_until
    # Phiên PIN trượt: hết hạn sau 30 phút KHÔNG thao tác.
    if pin_until is not None and pin_until > now():
        new_until = now() + timedelta(minutes=get_settings().pin_session_minutes)
        if (new_until - pin_until).total_seconds() > 60:
            await db.execute(text("UPDATE core.sessions SET pin_verified_until = :p, last_seen_at = now() "
                                  "WHERE id = :sid"), {"p": new_until, "sid": row.sid})
            pin_until = new_until
    return CurrentUser(id=row.id, org_id=row.org_id, email=row.email, display_name=row.display_name,
                       role_code=row.role_code, role_name=row.role_name, role_id=row.role_id, team_id=row.team_id,
                       session_id=row.sid, pin_verified_until=pin_until, addressing=row.addressing or {},
                       permissions=perms)


async def csrf_matches(db: AsyncSession, session_id: uuid.UUID, csrf: str) -> bool:
    h = (await db.execute(text("SELECT csrf_hash FROM core.sessions WHERE id = :s"), {"s": session_id})).scalar()
    return h is not None and bytes(h) == token_digest(csrf)


async def revoke_session(db: AsyncSession, session_id: uuid.UUID) -> None:
    await db.execute(text("UPDATE core.sessions SET revoked_at = now() WHERE id = :s"), {"s": session_id})


# ─── PIN ────────────────────────────────────────────────────────────────────

def valid_pin(pin: str) -> bool:
    return len(pin) == 6 and pin.isdigit()


@dataclass
class PinResult:
    ok: bool
    attempts_left: int = 0
    locked_until: datetime | None = None
    pin_verified_until: datetime | None = None
    just_locked: bool = False


async def verify_pin(db: AsyncSession, user: CurrentUser, pin: str) -> PinResult:
    s = get_settings()
    row = (await db.execute(text(
        "SELECT pin_hash, pin_failed, pin_locked_until FROM core.users WHERE id = :u FOR UPDATE"),
        {"u": user.id})).one()
    if row.pin_locked_until is not None and row.pin_locked_until > now():
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="auth.pin_attempt_while_locked", result="blocked", ip=user.ip)
        return PinResult(ok=False, locked_until=row.pin_locked_until)
    if verify_secret(row.pin_hash, pin):
        until = now() + timedelta(minutes=s.pin_session_minutes)
        await db.execute(text("UPDATE core.users SET pin_failed = 0, pin_locked_until = NULL WHERE id = :u"),
                         {"u": user.id})
        await db.execute(text("UPDATE core.sessions SET pin_verified_until = :p WHERE id = :s"),
                         {"p": until, "s": user.session_id})
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="auth.pin_verified", ip=user.ip)
        return PinResult(ok=True, pin_verified_until=until)
    failed = row.pin_failed + 1
    if failed >= s.pin_max_attempts:
        locked = now() + timedelta(minutes=s.pin_lock_minutes)
        await db.execute(text("UPDATE core.users SET pin_failed = 0, pin_locked_until = :l WHERE id = :u"),
                         {"l": locked, "u": user.id})
        await db.execute(text("UPDATE core.sessions SET pin_verified_until = NULL WHERE user_id = :u"),
                         {"u": user.id})
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="auth.pin_locked", result="blocked",
                               detail={"locked_until": locked.isoformat()}, ip=user.ip)
        return PinResult(ok=False, locked_until=locked, just_locked=True)
    await db.execute(text("UPDATE core.users SET pin_failed = :f WHERE id = :u"), {"f": failed, "u": user.id})
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="auth.pin_failed", result="failed",
                           detail={"attempts_left": s.pin_max_attempts - failed}, ip=user.ip)
    return PinResult(ok=False, attempts_left=s.pin_max_attempts - failed)


async def set_pin(db: AsyncSession, user_id: uuid.UUID, pin: str) -> None:
    await db.execute(text("UPDATE core.users SET pin_hash = :h, pin_failed = 0, pin_locked_until = NULL "
                          "WHERE id = :u"), {"h": hash_secret(pin), "u": user_id})
