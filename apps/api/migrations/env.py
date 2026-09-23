"""Alembic chạy đồng bộ bằng psycopg; schema viết bằng SQL thuần ở db/sql (xem docs/handoff/03)."""

from alembic import context
from sqlalchemy import create_engine, pool

from gh.config import get_settings


def sync_url() -> str:
    return get_settings().database_url.replace("+asyncpg", "+psycopg")


def run_migrations_offline() -> None:
    context.configure(url=sync_url(), literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(sync_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, transaction_per_migration=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
