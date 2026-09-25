"""Kết nối PostgreSQL (SQLAlchemy async). SSOT duy nhất của hệ thống."""

from collections.abc import AsyncIterator

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from gh.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


def sessionmaker() -> async_sessionmaker[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    return _sessionmaker


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
    _engine, _sessionmaker = None, None


async def get_db() -> AsyncIterator[AsyncSession]:
    """Dependency FastAPI: một transaction cho mỗi request, commit khi thành công.

    Luôn khai báo `DB`: commit xong rồi mới gửi phản hồi, để request kế tiếp
    của client (vd. thử lại sau khi nhập PIN) đọc được dữ liệu vừa ghi.
    """
    async with sessionmaker()() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


# Mặc định của FastAPI chạy phần sau `yield` SAU khi đã gửi phản hồi → client có thể đọc trước khi commit.
DB = Depends(get_db, scope="function")
