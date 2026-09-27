"""Test chạy trên PostgreSQL 16 + Redis thật (không mock DB).

Biến môi trường: GH_TEST_PG (mặc định postgresql://postgres:postgres@localhost:5432), GH_TEST_REDIS
(mặc định redis://localhost:6379/15), GH_TEST_TEMPLATE (tên CSDL mẫu, mặc định gh_test_template). Chạy song song
nhiều bộ test trên cùng máy: mỗi bộ đặt GH_TEST_TEMPLATE và số db Redis riêng. Một CSDL mẫu được migrate một
lần; mỗi test cần DB sạch nhận một bản sao.

`GH_TEST_APP_ROLE=1` (mục v0.1.1/1a): chạy TOÀN BỘ bộ test dưới role ứng dụng `gh_app` (không superuser,
không BYPASSRLS — migration 0014) thay vì `postgres`, để bắt sớm mọi GRANT còn thiếu. Migrate vẫn luôn chạy
bằng superuser (`GH_ADMIN_DATABASE_URL` trỏ CSDL đang test) — đúng hợp đồng chung (docs/reports/HANDOFF-v0.1.1.md):
GH_DATABASE_URL → gh_app, GH_ADMIN_DATABASE_URL → superuser, rỗng ⇒ dùng GH_DATABASE_URL. Xem Makefile mục
`api-test-app-role`. `GH_APP_DB_PASSWORD` (mặc định cố định chỉ dùng cho test) luôn được đặt để migration 0014
tạo role `gh_app` LOGIN được ngay cả khi không bật GH_TEST_APP_ROLE — vô hại, chỉ ảnh hưởng vai trò test.
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
TEMPLATE = os.environ.get("GH_TEST_TEMPLATE", "gh_test_template")

os.environ.setdefault("GH_ENV", "test")
os.environ["GH_COOKIE_SECURE"] = "false"
os.environ["GH_REDIS_URL"] = REDIS_URL
os.environ.setdefault("GH_MASTER_KEY", "")

# gh_app (migration 0014) — mật khẩu test cố định, KHÔNG dùng ngoài môi trường test. Luôn đặt (kể cả khi
# GH_TEST_APP_ROLE tắt) để role gh_app có LOGIN sẵn nếu một test nào đó cần SET ROLE gh_app thủ công.
GH_APP_DB_PASSWORD = os.environ.setdefault("GH_APP_DB_PASSWORD", "gh-app-test-only-pw-1")
APP_ROLE = os.environ.get("GH_TEST_APP_ROLE") == "1"
APP_PG = os.environ.get("GH_TEST_APP_PG", f"postgresql://gh_app:{GH_APP_DB_PASSWORD}@localhost:5432")


def _admin(sql: str) -> None:
    with psycopg.connect(f"{PG}/postgres", autocommit=True) as c:
        c.execute(sql)


def _async_url(db: str, base: str = PG) -> str:
    return f"{base.replace('postgresql://', 'postgresql+asyncpg://')}/{db}"


@pytest.fixture(scope="session")
def template_db() -> str:
    _admin(f"DROP DATABASE IF EXISTS {TEMPLATE} WITH (FORCE)")
    _admin(f"CREATE DATABASE {TEMPLATE}")
    # Migrate = DDL → luôn superuser, dù GH_TEST_APP_ROLE=1 (gh_app chỉ có quyền DML từ migration 0014).
    # GH_ADMIN_DATABASE_URL ép rỗng để không kế thừa giá trị của test trước đó (env tiến trình con là bản sao).
    env = {**os.environ, "GH_DATABASE_URL": _async_url(TEMPLATE), "GH_ADMIN_DATABASE_URL": ""}
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "heads"], cwd=API_DIR, env=env, check=True)
    return TEMPLATE


def _use_db(name: str) -> None:
    from gh.config import get_settings

    if APP_ROLE:
        # Runtime (fixture app/client, và mọi test dùng session `db` thẳng) kết nối bằng gh_app — không
        # superuser, không BYPASSRLS. DDL/backup/bảo trì phân vùng (gh/db.py::admin_sessionmaker) vẫn qua
        # superuser thật của CSDL này để lộ sớm bất kỳ chỗ nào lỡ cần vượt quyền GRANT của migration 0014.
        os.environ["GH_ADMIN_DATABASE_URL"] = _async_url(name)
        os.environ["GH_DATABASE_URL"] = _async_url(name, base=APP_PG)
    else:
        os.environ["GH_DATABASE_URL"] = _async_url(name)
        os.environ.pop("GH_ADMIN_DATABASE_URL", None)
    get_settings.cache_clear()


@pytest.fixture
async def fresh_db(template_db: str) -> AsyncIterator[str]:
    from gh import db as dbmod

    name = f"{TEMPLATE}_{uuid.uuid4().hex[:10]}"
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
