"""Đăng nhập Antigravity CLI qua Console, với CLI giả mô phỏng hành vi đo thật của agy 1.2.9.
(tests/fixtures/fake_agy.py)

Hai lỗi thật trên máy Owner (v0.1.11, "Quá 10 phút chưa hoàn tất đăng nhập"):
1. CLI hỏi terminal (Device Attributes) rồi chờ; không ai trả lời → không bao giờ in link.
2. Link ~700 ký tự bị ngắt dòng; chỉ bắt dòng đầu → link cụt. Bản đầy đủ nằm trong hyperlink OSC 8.
"""

import asyncio
import sys
from pathlib import Path

from gh.providers import cli as climod
from tests.conftest import verify_pin

FAKE = Path(__file__).parent / "fixtures" / "fake_agy.py"


def test_terminal_replies_answer_device_attribute_queries() -> None:
    assert climod.terminal_replies(b"\x1b[>c\x1b_Ga=q;AAAA\x1b\\\x1b[c") == b"\x1b[>1;10;0c\x1b[?62;22c"
    assert climod.terminal_replies(b"plain text") == b""


def test_login_url_prefers_full_osc8_link_over_wrapped_text() -> None:
    full = "https://accounts.google.com/o/oauth2/auth?a=1&b=2&state=END"
    raw = f"Open:\r\nhttps://accounts.google.com/o/oau\r\nth2/auth?a=1\x1b]8;;{full}\x1b\\Click\x1b]8;;\x1b\\"
    assert climod.login_url(raw, "https://accounts.google.com/o/oau") == full
    assert climod.login_url("", "see https://x.test/a.") == "https://x.test/a"


async def test_console_login_with_real_cli_behaviour(owner_api, app, tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setenv("GH_CLI_HOME", str(tmp_path / ".gemini" / "antigravity-cli"))
    from gh.config import get_settings

    get_settings.cache_clear()
    logins = app.state.cli_logins
    logins.argv = [sys.executable, str(FAKE)]

    await verify_pin(owner_api)  # v0.1.45 (F-20): thêm tài khoản CLI cần PIN
    r = await owner_api.send("POST", "/cli/login")
    assert r.status_code == 202, r.text
    login_id = r.json()["login_id"]
    s = next(iter(logins.sessions.values()))
    for _ in range(100):
        if s.status != "starting":
            break
        await asyncio.sleep(0.1)
    assert s.status == "waiting_code", s.message
    assert s.url is not None and s.url.endswith("&state=END"), s.url

    r = await owner_api.send("POST", f"/cli/login/{login_id}/code", {"code": "4/abc"})
    assert r.status_code == 202, r.text
    for _ in range(100):
        if s.status in ("done", "failed"):
            break
        await asyncio.sleep(0.1)
    assert s.status == "done", s.message
    profiles = (await owner_api.get("/cli/profiles")).json()
    assert [p["email"] for p in profiles] == ["boss@example.vn"]
    get_settings.cache_clear()


async def test_without_terminal_replies_cli_never_shows_link(owner_api, app, tmp_path, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Tái hiện lỗi cũ: không trả lời truy vấn terminal thì CLI không in link, đăng nhập thất bại."""
    monkeypatch.setenv("GH_CLI_HOME", str(tmp_path / ".gemini" / "antigravity-cli"))
    monkeypatch.setattr(climod, "terminal_replies", lambda chunk: b"")
    from gh.config import get_settings

    get_settings.cache_clear()
    logins = app.state.cli_logins
    logins.argv = [sys.executable, str(FAKE)]
    await verify_pin(owner_api)  # v0.1.45 (F-20): thêm tài khoản CLI cần PIN
    r = await owner_api.send("POST", "/cli/login")
    assert r.status_code == 202, r.text
    s = next(iter(logins.sessions.values()))
    for _ in range(150):
        if s.status == "failed":
            break
        await asyncio.sleep(0.1)
    assert s.status == "failed" and s.url is None
    get_settings.cache_clear()
