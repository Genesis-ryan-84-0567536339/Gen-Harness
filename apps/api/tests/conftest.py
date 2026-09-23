"""Test chạy trên PostgreSQL 16 + Redis thật (không mock DB).

Biến môi trường: GH_TEST_PG (mặc định postgresql://postgres:postgres@localhost:5432), GH_TEST_REDIS
(mặc định redis://localhost:6379/15). Một CSDL mẫu được migrate một lần; mỗi test cần DB sạch nhận một bản sao.
"""

import asyncio
import os
import subprocess
import sys
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import psycopg
import pytest
from redis.asyncio import Redis

API_DIR = Path(__file__).resolve().parents[1]
PG = os.environ.get("GH_TEST_PG", "postgresql://postgres:postgres@localhost:5432")
REDIS_URL = os.environ.get("GH_TEST_REDIS", "redis://localhost:6379/15")
TEMPLATE = "gh_test_template"

os.environ.setdefault("GH_ENV", "test")
os.environ["GH_COOKIE_SECURE"] = "false"
os.environ["GH_REDIS_URL"] = REDIS_URL
os.environ.setdefault("GH_MASTER_KEY", "")


def _admin(sql: str) -> None:
    with psycopg.connect(f"{PG}/postgres", autocommit=True) as c:
        c.execute(sql)


def _async_url(db: str) -> str:
    return f"{PG.replace('postgresql://', 'postgresql+asyncpg://')}/{db}"


@pytest.fixture(scope="session")
def template_db() -> str:
    _admin(f"DROP DATABASE IF EXISTS {TEMPLATE} WITH (FORCE)")
    _admin(f"CREATE DATABASE {TEMPLATE}")
    env = {**os.environ, "GH_DATABASE_URL": _async_url(TEMPLATE)}
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=API_DIR, env=env, check=True)
    return TEMPLATE


def _use_db(name: str) -> None:
    from gh.config import get_settings

    os.environ["GH_DATABASE_URL"] = _async_url(name)
    get_settings.cache_clear()


@pytest.fixture
async def fresh_db(template_db: str) -> AsyncIterator[str]:
    from gh import db as dbmod

    name = f"gh_test_{uuid.uuid4().hex[:10]}"
    await asyncio.to_thread(_admin, f"CREATE DATABASE {name} TEMPLATE {template_db}")
    _use_db(name)
    await dbmod.dispose_engine()
    try:
        yield name
    finally:
        await dbmod.dispose_engine()
        await asyncio.to_thread(_admin, f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


@pytest.fixture
async def db(fresh_db: str) -> AsyncIterator[object]:
    from gh.db import sessionmaker

    async with sessionmaker()() as session:
        yield session
        await session.rollback()


@pytest.fixture
async def redis() -> AsyncIterator[Redis]:
    r = Redis.from_url(REDIS_URL)
    await r.flushdb()
    yield r
    await r.flushdb()
    await r.aclose()


@pytest.fixture
async def app(fresh_db: str, redis: Redis) -> AsyncIterator[object]:
    from gh.app import create_app

    os.environ["GH_SETUP_TOKEN"] = "test-setup-token"
    from gh.config import get_settings

    get_settings.cache_clear()
    application = create_app()
    async with application.router.lifespan_context(application):
        yield application
    os.environ.pop("GH_SETUP_TOKEN", None)
    get_settings.cache_clear()


@pytest.fixture
async def client(app: object) -> AsyncIterator[httpx.AsyncClient]:
    transport = httpx.ASGITransport(app=app)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


class Api:
    """Client có CSRF tự động."""

    def __init__(self, c: httpx.AsyncClient):
        self.c = c

    def _headers(self) -> dict[str, str]:
        csrf = self.c.cookies.get("gh_csrf")
        return {"X-CSRF-Token": csrf} if csrf else {}

    async def get(self, url: str, **kw: object) -> httpx.Response:
        return await self.c.get(f"/api/v1{url}", **kw)  # type: ignore[arg-type]

    async def send(self, method: str, url: str, json: object = None) -> httpx.Response:
        return await self.c.request(method, f"/api/v1{url}", json=json, headers=self._headers())


OWNER = {"display_name": "Anh Cơ", "email": "owner@example.vn", "password": "mat-khau-rat-dai-123",
         "pin": "246810", "pin_confirm": "246810"}


async def do_setup(api: Api) -> None:
    r = await api.send("PUT", "/setup/steps/1", {"token": "test-setup-token", "language": "vi", "mode": "empty"})
    assert r.status_code == 200, r.text
    r = await api.send("PUT", "/setup/steps/2", {"token": "test-setup-token", **OWNER})
    assert r.status_code == 200, r.text
    r = await api.send("PUT", "/setup/steps/3", {"org_name": "Genesis Việt", "timezone": "Asia/Ho_Chi_Minh",
                                                  "currency": "VND", "self_name": "Anh",
                                                  "bot_calls_me": "Sếp"})
    assert r.status_code == 200, r.text


@pytest.fixture
async def owner_api(client: httpx.AsyncClient) -> Api:
    api = Api(client)
    await do_setup(api)
    return api
