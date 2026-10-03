"""v0.1.46: giới hạn đăng nhập sai (10 lần / 15 phút theo IP và email), argon2 giả, fail-open khi Redis lỗi."""

import hashlib
from typing import Any

import httpx
import pytest
from redis.asyncio import Redis
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy import text

from gh.auth import login_guard
from gh.db import admin_sessionmaker
from tests.conftest import OWNER, Api, verify_pin

IP_A = {"X-Forwarded-For": "203.0.113.7"}
IP_B = {"X-Forwarded-For": "203.0.113.8"}


async def _login(app: object, email: str, password: str, headers: dict[str, str] | None = None) -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:  # type: ignore[arg-type]
        return await c.post("/api/v1/auth/login", json={"email": email, "password": password}, headers=headers or {})


async def _count(redis: Redis, key: str) -> int:
    v = await redis.get(key)
    return int(v) if v is not None else 0


async def test_eleventh_attempt_blocked_even_with_correct_password(owner_api: Api, app: object) -> None:
    for _ in range(10):
        assert (await _login(app, OWNER["email"], "sai-mat-khau", IP_A)).status_code == 401
    r = await _login(app, OWNER["email"], OWNER["password"], IP_A)
    assert r.status_code == 429, r.text
    body = r.json()
    assert body["code"] == "LOGIN_RATE_LIMITED" and body["retry_after_s"] > 0
    assert isinstance(body["detail"], str)


async def test_ip_limit_across_unknown_emails(owner_api: Api, app: object) -> None:
    for i in range(10):
        assert (await _login(app, f"khong{i}@example.vn", "x" * 12, IP_A)).status_code == 401
    r = await _login(app, "khong10@example.vn", "x" * 12, IP_A)
    assert r.status_code == 429 and r.json()["code"] == "LOGIN_RATE_LIMITED"


async def test_email_limit_holds_across_ips(owner_api: Api, app: object) -> None:
    for _ in range(10):
        await _login(app, OWNER["email"], "sai-mat-khau", IP_A)
    r = await _login(app, OWNER["email"], OWNER["password"], IP_B)
    assert r.status_code == 429


async def test_success_clears_email_counter_not_ip(owner_api: Api, app: object, redis: Redis) -> None:
    for _ in range(5):
        assert (await _login(app, OWNER["email"], "sai-mat-khau", IP_A)).status_code == 401
    assert await _count(redis, login_guard.email_key(OWNER["email"])) == 5
    assert (await _login(app, OWNER["email"], OWNER["password"], IP_A)).status_code == 200
    assert await _count(redis, login_guard.email_key(OWNER["email"])) == 0
    assert await _count(redis, login_guard.ip_key("203.0.113.7")) == 5


async def test_unknown_email_still_runs_verify_secret(owner_api: Api, app: object,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    from gh.auth import service

    calls: list[tuple[Any, ...]] = []
    real = service.verify_secret

    def spy(stored: str | None, value: str) -> bool:
        calls.append((stored, value))
        return real(stored, value)

    monkeypatch.setattr("gh.auth.service.verify_secret", spy)
    r = await _login(app, "khong-co@example.vn", "mat-khau-bat-ky-1")
    assert r.status_code == 401 and len(calls) == 1 and calls[0][0]


async def test_inactive_user_still_runs_verify_secret(owner_api: Api, app: object,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE core.users SET is_active = false"))
        await db.commit()
    calls: list[str] = []
    from gh.auth import service

    real = service.verify_secret

    def spy(stored: str | None, value: str) -> bool:
        calls.append(value)
        return real(stored, value)

    monkeypatch.setattr("gh.auth.service.verify_secret", spy)
    r = await _login(app, OWNER["email"], OWNER["password"])
    assert r.status_code == 401 and len(calls) == 1


async def test_redis_down_fails_open(owner_api: Api, app: object) -> None:
    class Broken:
        async def get(self, *a: Any, **k: Any) -> Any:
            raise RedisConnectionError("down")

        incr = ttl = expire = delete = set = get

    real = app.state.redis  # type: ignore[attr-defined]
    app.state.redis = Broken()  # type: ignore[attr-defined]
    try:
        assert (await _login(app, OWNER["email"], OWNER["password"])).status_code == 200
        assert (await _login(app, OWNER["email"], "sai-mat-khau")).status_code == 401
    finally:
        app.state.redis = real  # type: ignore[attr-defined]


async def test_redis_keys_hold_no_raw_email(owner_api: Api, app: object, redis: Redis) -> None:
    await _login(app, "Nguoi.La@Example.vn ", "x" * 12, IP_A)
    keys = [k.decode() for k in await redis.keys("gh:login:*")]
    assert keys and all("example" not in k.lower() and "nguoi" not in k.lower() for k in keys)
    digest = hashlib.sha256(b"nguoi.la@example.vn").hexdigest()[:32]
    assert f"gh:login:fail:email:{digest}" in keys


async def test_owner_reset_password_clears_staff_counter(owner_api: Api, app: object, redis: Redis) -> None:
    await verify_pin(owner_api)
    r = await owner_api.send("POST", "/users", {"display_name": "Lan", "email": "lan@example.vn", "role": "operator"})
    assert r.status_code == 201, r.text
    uid = r.json()["user"]["id"]
    for _ in range(3):
        await _login(app, "lan@example.vn", "sai-mat-khau", IP_A)
    assert await _count(redis, login_guard.email_key("lan@example.vn")) == 3
    r = await owner_api.send("POST", f"/users/{uid}/reset-password")
    assert r.status_code == 200, r.text
    assert await _count(redis, login_guard.email_key("lan@example.vn")) == 0


async def test_rate_limited_actionlog_single_row(owner_api: Api, app: object) -> None:
    for _ in range(10):
        await _login(app, OWNER["email"], "sai-mat-khau", IP_A)
    for _ in range(4):
        assert (await _login(app, OWNER["email"], "sai-mat-khau", IP_A)).status_code == 429
    async with admin_sessionmaker()() as db:
        n = (await db.execute(text("SELECT count(*) FROM ops.action_log WHERE action = 'auth.login_rate_limited'"))
             ).scalar()
    assert n == 1
