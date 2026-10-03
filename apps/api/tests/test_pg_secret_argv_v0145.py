"""v0.1.45 (F-54) — mật khẩu superuser KHÔNG lên argv của pg_dump/pg_restore (ai trên máy cũng đọc được qua `ps`).

URL libpq trên argv bỏ mật khẩu; mật khẩu (đã unquote) đi qua PGPASSWORD trong env của tiến trình con; thông báo lỗi
pg_* đã che mật khẩu trước khi ném/log.
"""

import asyncio
import os
from pathlib import Path
from typing import Any

import pytest

from gh import backup, bundle
from gh.chassis import objects as objects_mod
from gh.chassis.objects import LocalObjectStore
from gh.config import get_settings

RAW_PASSWORD = "S3cr@t/pw:xy"  # có '@', '/', ':' — trên URL phải viết %40, %2F, %3A
ADMIN_URL = "postgresql+asyncpg://gh:S3cr%40t%2Fpw%3Axy@db:5432/gen_harness?sslmode=disable"


class _Proc:
    def __init__(self, rc: int, err: bytes) -> None:
        self.returncode = rc
        self._err = err

    async def communicate(self) -> tuple[bytes, bytes]:
        return b"", self._err

    async def wait(self) -> int:
        return self.returncode

    def kill(self) -> None:
        pass


class _Recorder:
    """Thay asyncio.create_subprocess_exec: ghi lại argv + env, giả pg_dump ghi tệp dump."""

    def __init__(self, *, rc: int = 0, err: bytes = b"") -> None:
        self.calls: list[tuple[list[str], dict[str, str] | None]] = []
        self.rc, self.err = rc, err

    async def __call__(self, *cmd: str, **kw: Any) -> _Proc:
        argv = [str(c) for c in cmd]
        self.calls.append((argv, kw.get("env")))
        if argv[0] == "pg_dump" and self.rc == 0:
            fd = os.open(argv[argv.index("--file") + 1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            os.write(fd, b"PGDMP-gia-lap")
            os.close(fd)
        return _Proc(self.rc, self.err)

    def pg_calls(self) -> list[tuple[list[str], dict[str, str] | None]]:
        return [c for c in self.calls if c[0][0] in ("pg_dump", "pg_restore")]


def _assert_no_secret_on_argv(rec: _Recorder, *, expect: tuple[str, ...]) -> None:
    calls = rec.pg_calls()
    assert [c[0][0] for c in calls] == list(expect)
    for argv, env in calls:
        for a in argv:
            assert RAW_PASSWORD not in a and "S3cr%40t" not in a and "S3cr" not in a, argv
        assert env is not None and env.get("PGPASSWORD") == RAW_PASSWORD
        dsn = next(a for a in argv if a.startswith("postgresql://"))
        assert dsn.startswith("postgresql://gh@db:5432/") and "sslmode=disable" in dsn


@pytest.fixture
def admin_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    monkeypatch.setenv("GH_ADMIN_DATABASE_URL", ADMIN_URL)
    monkeypatch.setenv("GH_OBJECTS_DIR", str(tmp_path / "objects"))
    get_settings.cache_clear()
    objects_mod.reset_object_store()
    rec = _Recorder()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", rec)
    yield rec
    get_settings.cache_clear()
    objects_mod.reset_object_store()


def test_libpq_conn_strips_password_and_unquotes() -> None:
    url, env = backup.libpq_conn(ADMIN_URL)
    assert url == "postgresql://gh@db:5432/gen_harness?sslmode=disable"
    assert env == {"PGPASSWORD": RAW_PASSWORD}
    url, env = backup.libpq_conn(ADMIN_URL, database="khac")
    assert url == "postgresql://gh@db:5432/khac?sslmode=disable" and env == {"PGPASSWORD": RAW_PASSWORD}
    url, env = backup.libpq_conn("postgresql://gh@db/gen")
    assert url == "postgresql://gh@db/gen" and env == {}
    url, env = backup.libpq_conn("postgresql://db/gen?user=u&password=p%26q")
    assert url == "postgresql://db/gen?user=u" and env == {"PGPASSWORD": "p&q"}


async def test_run_backup_and_restore_keep_password_off_argv(admin_env: _Recorder, tmp_path: Path,
                                                             monkeypatch: pytest.MonkeyPatch) -> None:
    recreated: list[str] = []
    monkeypatch.setattr(backup, "recreate_database", lambda url: recreated.append(url))
    store = LocalObjectStore(tmp_path / "store")
    entry = await backup.run_backup(store=store)
    await backup.restore_backup(entry.key, store=store, target_database="dich_thu")
    _assert_no_secret_on_argv(admin_env, expect=("pg_dump", "pg_restore"))
    restore_argv = admin_env.pg_calls()[1][0]
    assert "postgresql://gh@db:5432/dich_thu?sslmode=disable" in restore_argv
    # recreate_database chạy psycopg TRONG tiến trình — vẫn dùng URL đầy đủ (không lên argv).
    assert recreated == ["postgresql://gh:S3cr%40t%2Fpw%3Axy@db:5432/dich_thu?sslmode=disable"]


async def test_pg_error_message_is_redacted(admin_env: _Recorder, tmp_path: Path) -> None:
    admin_env.rc = 1
    admin_env.err = (b"pg_dump: error: connection to server failed: postgresql://gh:S3cr%40t%2Fpw%3Axy@db:5432/x "
                     b"password=" + RAW_PASSWORD.encode() + b" bad")
    with pytest.raises(RuntimeError) as exc:
        await backup.run_backup(store=LocalObjectStore(tmp_path / "store"))
    msg = str(exc.value)
    assert RAW_PASSWORD not in msg and "S3cr%40t" not in msg and "S3cr" not in msg
    assert "***" in msg and "pg_dump thất bại (mã 1)" in msg


async def test_bundle_pg_error_message_is_redacted(admin_env: _Recorder) -> None:
    admin_env.rc = 1
    admin_env.err = b"pg_restore: could not connect postgresql://gh:S3cr%40t%2Fpw%3Axy@db/x"
    _url, env = backup.libpq_conn(ADMIN_URL)
    with pytest.raises(RuntimeError) as exc:
        await bundle._run(["pg_restore", "--list", "x"], env=env)
    assert "S3cr" not in str(exc.value) and "***" in str(exc.value)


async def test_bundle_export_import_keep_password_off_argv(admin_env: _Recorder, tmp_path: Path,
                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GH_BUNDLE_PASSWORD", "mat-khau-goi-du-dai-123")
    monkeypatch.setattr(bundle, "_current_alembic_revision", lambda url: None)
    monkeypatch.setattr(bundle, "_check_revision_compatible", lambda a, b: None)
    monkeypatch.setattr(bundle, "recreate_database", lambda url: None)

    async def _no_reencrypt(old: bytes) -> None:
        return None

    monkeypatch.setattr(bundle, "_reencrypt_secrets", _no_reencrypt)
    out = tmp_path / "x.ghbundle"
    await bundle._export(str(out))
    await bundle._import(str(out))
    _assert_no_secret_on_argv(admin_env, expect=("pg_dump", "pg_restore"))
