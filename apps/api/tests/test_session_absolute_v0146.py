"""v0.1.46: phiên hết hạn tuyệt đối 30 ngày kể từ created_at, dù trượt."""

from sqlalchemy import text

from gh.auth import service
from gh.db import admin_sessionmaker
from tests.conftest import Api


async def _set_age(days: float) -> None:
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE core.sessions SET created_at = now() - make_interval(secs => :s), "
                              "expires_at = now() + interval '1 hour' WHERE revoked_at IS NULL"),
                         {"s": days * 86400})
        await db.commit()


async def test_session_older_than_30_days_rejected(owner_api: Api) -> None:
    await _set_age(31)
    assert (await owner_api.get("/auth/me")).status_code == 401


async def test_session_renewal_capped_at_absolute(owner_api: Api) -> None:
    await _set_age(29.9)
    assert (await owner_api.get("/auth/me")).status_code == 200
    async with admin_sessionmaker()() as db:
        row = (await db.execute(text(
            "SELECT expires_at <= created_at + interval '30 days' AS ok, expires_at > now() AS live "
            "FROM core.sessions WHERE revoked_at IS NULL"))).one()
    assert row.ok and row.live


async def test_load_session_without_renew_also_rejects(owner_api: Api) -> None:
    token = owner_api.c.cookies.get("gh_session")
    assert token
    async with admin_sessionmaker()() as db:
        assert await service.load_session(db, token, renew=False) is not None
    await _set_age(31)
    async with admin_sessionmaker()() as db:
        assert await service.load_session(db, token, renew=False) is None
