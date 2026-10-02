"""F-22 (v0.1.38): phiên Claude Code tách khỏi HOME của Antigravity CLI.

≤ v0.1.37: GH_CLAUDE_HOME=/var/lib/gh/agy/claude/.claude nằm TRONG HOME của agy (/var/lib/gh/agy) ⇒ agy (có công cụ
đọc tệp) đọc được `.credentials.json` của Claude. v0.1.38: volume claude_state riêng (/var/lib/gh/claude/.claude); api
tự chuyển tệp từ đường dẫn cũ khi khởi động (`restore_active` → `migrate_legacy_claude_home`)."""

import logging
import re
import stat
from pathlib import Path

import pytest
import yaml

from gh.config import get_settings
from gh.providers import cli as climod

REPO = Path(__file__).resolve().parents[3]
CRED = b'{"claudeAiOauth":{"accessToken":"gia-khong-that"}}'
STATE = b'{"oauthAccount":{"emailAddress":"gia@example.invalid"}}'


@pytest.fixture
def homes(tmp_path, monkeypatch):  # type: ignore[no-untyped-def]
    """HOME agy tạm (<tmp>/agy, GH_CLI_HOME=<tmp>/agy/.gemini/antigravity-cli) + GH_CLAUDE_HOME tách riêng."""
    agy_home = tmp_path / "agy"
    (agy_home / ".gemini" / "antigravity-cli").mkdir(parents=True)
    target = tmp_path / "claude" / ".claude"
    monkeypatch.setenv("GH_CLI_HOME", str(agy_home / ".gemini" / "antigravity-cli"))
    monkeypatch.setenv("GH_CLAUDE_HOME", str(target))
    get_settings.cache_clear()
    legacy = agy_home / "claude" / ".claude"
    monkeypatch.setenv("GH_CLAUDE_LEGACY_HOME", str(legacy))  # như api.Dockerfile
    get_settings.cache_clear()
    legacy.mkdir(parents=True)
    (legacy / ".credentials.json").write_bytes(CRED)
    (legacy / ".claude.json").write_bytes(STATE)
    (agy_home / "claude" / "work").mkdir()
    yield agy_home, legacy, target
    get_settings.cache_clear()


def _mode(p: Path) -> int:
    return stat.S_IMODE(p.stat().st_mode)


async def test_api_moves_legacy_session_and_is_idempotent(homes) -> None:  # type: ignore[no-untyped-def]
    agy_home, legacy, target = homes
    await climod.restore_active(None)
    assert (target / ".credentials.json").read_bytes() == CRED
    assert (target / ".claude.json").read_bytes() == STATE
    assert _mode(target / ".credentials.json") == 0o600
    assert _mode(target / ".claude.json") == 0o600
    assert not (agy_home / "claude").exists()  # gồm cả claude/work
    await climod.restore_active(None)  # chạy lại an toàn
    assert (target / ".credentials.json").read_bytes() == CRED
    assert climod.migrate_legacy_claude_home() == 0


async def test_newer_target_session_not_overwritten(homes) -> None:  # type: ignore[no-untyped-def]
    agy_home, legacy, target = homes
    target.mkdir(parents=True)
    (target / ".credentials.json").write_bytes(b'{"moi":1}')
    (legacy / "projects").mkdir()
    (legacy / "projects" / "x.txt").write_bytes(b"x")
    await climod.restore_active(None)
    assert (target / ".credentials.json").read_bytes() == b'{"moi":1}'
    assert (target / ".claude.json").read_bytes() == STATE
    assert (target / "projects" / "x.txt").read_bytes() == b"x"
    assert _mode(target / "projects") == 0o700
    assert not (agy_home / "claude").exists()


async def test_never_touches_siblings_of_legacy(homes) -> None:  # type: ignore[no-untyped-def]
    """Review blocker: chỉ xoá đúng `.claude` cũ và `work`; thư mục khác cạnh nó (dự án của người dùng) giữ nguyên."""
    agy_home, legacy, target = homes
    (agy_home / "claude" / "other").mkdir()
    (agy_home / "claude" / "src").mkdir()
    (agy_home / "claude" / "src" / "main.py").write_text("print(1)\n")
    await climod.restore_active(None)
    assert (target / ".credentials.json").read_bytes() == CRED
    assert not legacy.exists() and not (agy_home / "claude" / "work").exists()
    assert (agy_home / "claude" / "other").is_dir()
    assert (agy_home / "claude" / "src" / "main.py").read_text() == "print(1)\n"


async def test_no_legacy_setting_is_noop(homes, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Dev/pytest không đặt GH_CLAUDE_LEGACY_HOME ⇒ `~/claude/.claude` (có thể là dự án thật) không bị đụng tới."""
    agy_home, legacy, target = homes
    monkeypatch.delenv("GH_CLAUDE_LEGACY_HOME")
    get_settings.cache_clear()
    assert climod.migrate_legacy_claude_home() == 0
    await climod.restore_active(None)
    assert (legacy / ".credentials.json").read_bytes() == CRED
    assert (agy_home / "claude" / "work").is_dir()


def test_failed_item_keeps_legacy_then_retries(homes, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Lỗi giữa chừng (vd. ENOSPC) ⇒ đích không có bản dở, thư mục cũ giữ nguyên; lần sau chuyển nốt rồi mới xoá."""
    agy_home, legacy, target = homes
    real = climod.shutil.copy2

    def boom(src, dst, *a, **k):  # type: ignore[no-untyped-def]
        if str(src).endswith(".credentials.json"):
            Path(dst).write_bytes(b"do-dang")
            raise OSError(28, "No space left on device")
        return real(src, dst, *a, **k)

    monkeypatch.setattr(climod.shutil, "copy2", boom)
    assert climod.migrate_legacy_claude_home() == 1  # chỉ .claude.json
    assert not (target / ".credentials.json").exists()
    assert not list(target.glob("*.migrating"))
    assert (legacy / ".credentials.json").read_bytes() == CRED
    monkeypatch.setattr(climod.shutil, "copy2", real)
    assert climod.migrate_legacy_claude_home() == 1
    assert (target / ".credentials.json").read_bytes() == CRED
    assert not (agy_home / "claude").exists()


async def test_worker_does_not_migrate(homes) -> None:  # type: ignore[no-untyped-def]
    agy_home, legacy, target = homes
    await climod.restore_active(None, owns_logins=False)
    assert (legacy / ".credentials.json").read_bytes() == CRED
    assert not (target / ".credentials.json").exists()


async def test_claude_home_inside_agy_home_logs_error(tmp_path, monkeypatch, caplog) -> None:  # type: ignore[no-untyped-def]
    agy_home = tmp_path / "agy"
    (agy_home / ".gemini" / "antigravity-cli").mkdir(parents=True)
    monkeypatch.setenv("GH_CLI_HOME", str(agy_home / ".gemini" / "antigravity-cli"))
    monkeypatch.setenv("GH_CLAUDE_HOME", str(agy_home / "claude" / ".claude"))
    get_settings.cache_clear()
    try:
        with caplog.at_level(logging.ERROR, logger="gh.cli"):
            await climod.restore_active(None)
        assert "GH_CLAUDE_HOME nằm trong HOME của Antigravity CLI — agy có thể đọc phiên Claude" in [
            r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    finally:
        get_settings.cache_clear()


def test_compose_and_dockerfile_split_claude_volume() -> None:
    doc = yaml.safe_load((REPO / "deploy" / "compose.yaml").read_text(encoding="utf-8"))
    assert "claude_state" in doc["volumes"]
    assert "claude_state:/var/lib/gh/claude" in doc["services"]["api"]["volumes"]
    worker = [v for v in doc["services"]["worker"]["volumes"] if isinstance(v, dict) and v["source"] == "claude_state"]
    assert worker and worker[0]["target"] == "/var/lib/gh/claude" and worker[0]["volume"]["nocopy"] is True
    dockerfile = (REPO / "deploy" / "images" / "api.Dockerfile").read_text(encoding="utf-8")
    assert "GH_CLAUDE_HOME=/var/lib/gh/claude/.claude" in dockerfile
    homes = re.findall(r"GH_CLAUDE_HOME=(\S+)", dockerfile)
    assert homes and all(not h.startswith("/var/lib/gh/agy") for h in homes)
    assert "GH_CLAUDE_LEGACY_HOME=/var/lib/gh/agy/claude/.claude" in dockerfile


async def test_shared_home_opens_incident_then_clears(owner_api, app, tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Có sẵn gh.health (v0.1.36) ⇒ GH_CLAUDE_HOME trong HOME agy mở sự cố `cli.claude_home_shared`; tách thì đóng."""
    from sqlalchemy import text

    from gh.db import sessionmaker

    agy_home = tmp_path / "agy"
    (agy_home / ".gemini" / "antigravity-cli").mkdir(parents=True)
    monkeypatch.setenv("GH_CLI_HOME", str(agy_home / ".gemini" / "antigravity-cli"))
    monkeypatch.setenv("GH_CLAUDE_HOME", str(agy_home / "claude" / ".claude"))
    get_settings.cache_clear()
    sql = text("SELECT count(*) FROM ops.health_alerts WHERE key = 'cli.claude_home_shared' AND cleared_at IS NULL")
    try:
        await climod.restore_active(sessionmaker())
        async with sessionmaker()() as s:
            assert (await s.execute(sql)).scalar_one() == 1
        monkeypatch.setenv("GH_CLAUDE_HOME", str(tmp_path / "claude" / ".claude"))
        get_settings.cache_clear()
        await climod.restore_active(sessionmaker())
        async with sessionmaker()() as s:
            assert (await s.execute(sql)).scalar_one() == 0
    finally:
        get_settings.cache_clear()
