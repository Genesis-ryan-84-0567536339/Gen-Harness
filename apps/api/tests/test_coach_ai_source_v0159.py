# ruff: noqa: F811 — fixture `clis` nhập từ test_cli_models_v0131 (tham số test trùng tên là cách pytest dùng fixture)
"""v0.1.59 (g6) — thẻ "Hôm nay của Sếp" đọc lại NGAY sau khi Owner kiểm nguồn AI, không chờ cache 60 giây.

Máy Owner v0.1.58: "Kiểm tra kết nối" của Antigravity CLI xanh, Gen trả lời được, nhưng thẻ vẫn báo "Gen chưa có model
để trả lời" và "Đã đạt 0/1 việc bắt buộc", đòi bấm Kiểm tra lần nữa. Hai gốc rễ:
(1) `signals.collect` cache tín hiệu 60 giây (`CACHE_KEY`) mà không ai xoá khi trạng thái đổi;
(2) `POST /providers/{pid}/test` không ghi `ops.boss_checks` ⇒ dòng bắt buộc "ai" chưa đạt.

Bản v0.1.59: lượt gọi thử CLI XANH ghi `ai_source` + `agy_call` (hoặc `claude_call`); mọi nơi đổi thứ thẻ đọc gọi
`coach_cache.invalidate` SAU khi đã commit. CLI giả: tests/fixtures/fake_agy_multi.py (fixture `clis`).
"""

import logging
import uuid
from typing import Any

import httpx
from sqlalchemy import text

from gh.db import sessionmaker
from gh.gen.coach import cache as coach_cache
from gh.gen.coach import signals as sg
from tests.conftest import Api, verify_pin
from tests.test_cli_models_v0131 import _login, _provider, clis  # noqa: F401 — fixture dùng chung

AGY = "antigravity_cli"
CLAUDE = "claude_code_cli"
TODAY = "/gen/coach/today"
MODEL_MISSING_TITLE = "Gen chưa có model để trả lời"


def _keys(card: dict[str, Any]) -> list[str]:
    return [t["key"] for t in card["todos"]]


def _row(ov: dict[str, Any], key: str) -> dict[str, Any]:
    return next(r for r in ov["rows"] if r["key"] == key)


async def _org_of(pid: str) -> uuid.UUID:
    async with sessionmaker()() as db:
        return (
            await db.execute(text("SELECT org_id FROM agent.providers WHERE id = :i"), {"i": uuid.UUID(pid)})
        ).scalar_one()


async def _cli_without_models(api: Api, kind: str, code: str) -> tuple[uuid.UUID, str]:
    """Đăng nhập CLI giả, tắt nguồn khác, xoá mọi model: đúng trạng thái "chưa có model" trước khi bấm Kiểm tra."""
    await _login(api, kind, code)
    pid = (await _provider(api, kind))["id"]
    org = await _org_of(pid)
    async with sessionmaker()() as db:
        await db.execute(
            text("UPDATE agent.providers SET is_enabled = (kind = :k) WHERE org_id = :o"), {"k": kind, "o": org}
        )
        await db.execute(text("DELETE FROM agent.models WHERE provider_id = :p"), {"p": uuid.UUID(pid)})
        await db.commit()
    return org, pid


async def _api_source(api: Api) -> tuple[uuid.UUID, str, str]:
    """Nguồn khoá API (openai_compat, có một model) → (org, provider_id, model_id)."""
    await verify_pin(api)
    r = await api.send(
        "POST",
        "/providers",
        {
            "kind": "openai_compat",
            "name": "Nguồn khoá v0159",
            "endpoint": "https://127.0.0.1:9/v1",
            "keys": ["sk-test-key-v0159-4321"],
            "models": ["m1"],
        },
    )
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    org = await _org_of(pid)
    async with sessionmaker()() as db:
        mid = (
            await db.execute(text("SELECT id FROM agent.models WHERE provider_id = :p"), {"p": uuid.UUID(pid)})
        ).scalar_one()
    return org, pid, str(mid)


async def _warm(app: Any, org: uuid.UUID) -> None:
    """Giả lập cache tín hiệu vừa được dựng (đúng khoá như `signals.collect`, còn hạn 60 giây)."""
    await app.state.redis.set(sg.CACHE_KEY.format(org), b"{}", ex=60)


async def _cached(app: Any, org: uuid.UUID) -> bool:
    return bool(await app.state.redis.exists(sg.CACHE_KEY.format(org)))


async def _rows(check_key: str, org: uuid.UUID) -> list[Any]:
    async with sessionmaker()() as db:
        return list(
            (
                await db.execute(
                    text("""SELECT status, detail FROM ops.boss_checks
                                              WHERE org_id = :o AND check_key = :k"""),
                    {"o": org, "k": check_key},
                )
            ).all()
        )


async def _card(api: Api) -> dict[str, Any]:
    r = await api.get(TODAY)
    assert r.status_code == 200, r.text
    body: dict[str, Any] = r.json()
    return body


# ─── (a)–(d): đúng luồng Owner ───────────────────────────────────────────────────────────────────────────────────


async def test_green_test_button_refreshes_card_and_boss_row_at_once(owner_api: Api, app: Any, clis: Any) -> None:
    api = owner_api
    org, pid = await _cli_without_models(api, AGY, "4/an")
    # (a) lượt mở thẻ khi CHƯA có model: có việc model.missing, và cache tín hiệu đã được dựng.
    card = await _card(api)
    assert "model.missing" in _keys(card)
    assert next(t for t in card["todos"] if t["key"] == "model.missing")["title"] == MODEL_MISSING_TITLE
    assert await _cached(app, org)
    # (b) Kiểm tra kết nối Antigravity giả → xanh.
    t = (await api.send("POST", f"/providers/{pid}/test")).json()
    assert t["ok"] is True, t
    # (c) dòng "ai" của Việc Sếp cần làm đạt ngay, và lượt CLI xanh được ghi đúng hai bằng chứng.
    ov = (await api.get("/boss-checks")).json()
    assert _row(ov, "ai")["done"] is True and ov["required_done"] == 1
    assert ov["results"]["ai_source"]["status"] == "pass" and ov["results"]["agy_call"]["status"] == "pass"
    assert [r.status for r in await _rows("ai_source", org)] == ["pass"]
    assert [r.status for r in await _rows("agy_call", org)] == ["pass"]
    assert set((await _rows("agy_call", org))[0].detail) >= {"probe_model", "models_count", "latency_ms"}
    # (d) thẻ Hôm nay đọc lại NGAY (cache đã bị xoá, không chờ 60 giây): hết model.missing, không boss.ai.
    card = await _card(api)
    assert "model.missing" not in _keys(card) and "boss.ai" not in _keys(card)
    assert card["progress"]["required_done"] == 1


async def test_claude_cli_green_test_records_ai_source_and_claude_call(owner_api: Api, app: Any, clis: Any) -> None:
    api = owner_api
    await _login(api, CLAUDE, "c/boss")
    p = await _provider(api, CLAUDE)
    org = await _org_of(p["id"])
    t = (await api.send("POST", f"/providers/{p['id']}/test")).json()
    assert t["ok"] is True, t
    assert [r.status for r in await _rows("ai_source", org)] == ["pass"]
    assert [r.status for r in await _rows("claude_call", org)] == ["pass"]
    assert _row((await api.get("/boss-checks")).json(), "claude")["done"] is True
    assert await _rows("agy_call", org) == []  # chỉ Antigravity mới ghi agy_call


async def test_failed_cli_test_writes_no_evidence_but_still_refreshes_card(
    owner_api: Api, app: Any, clis: Any, monkeypatch: Any
) -> None:
    api = owner_api
    org, pid = await _cli_without_models(api, AGY, "4/an")
    await _card(api)
    assert await _cached(app, org)

    async def red(_provider_id: uuid.UUID) -> dict[str, Any]:
        return {
            "ok": False,
            "error": "CLI chưa đăng nhập",
            "error_code": "AGY_NOT_LOGGED_IN",
            "models": [],
            "latency_ms": 3,
        }

    monkeypatch.setattr(app.state.model_router, "test_provider", red)
    t = (await api.send("POST", f"/providers/{pid}/test")).json()
    assert t["ok"] is False
    assert await _rows("ai_source", org) == [] and await _rows("agy_call", org) == []
    assert _row((await api.get("/boss-checks")).json(), "ai")["done"] is False
    assert not await _cached(app, org)  # trạng thái nguồn đã đổi ⇒ vẫn làm mới thẻ


# ─── (e) nguồn khoá API: chỉ liệt kê model, KHÔNG ghi ai_source ─────────────────────────────────────────────────


async def test_api_key_source_green_test_records_no_ai_source(owner_api: Api, app: Any) -> None:
    api = owner_api
    org, pid, _mid = await _api_source(api)
    app.state.model_router.transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"data": [{"id": "m1"}]})
    )
    await _warm(app, org)
    t = (await api.send("POST", f"/providers/{pid}/test")).json()
    assert t["ok"] is True, t
    assert await _rows("ai_source", org) == []
    assert _row((await api.get("/boss-checks")).json(), "ai")["done"] is False
    assert not await _cached(app, org)


# ─── (f) invalidate: không ném lỗi; chỉ xoá khoá của đúng tổ chức ────────────────────────────────────────────────


async def test_invalidate_none_redis_never_raises(caplog: Any) -> None:
    with caplog.at_level(logging.WARNING, logger="gh.gen.coach"):
        await coach_cache.invalidate(None, uuid.uuid4())
    assert [r.levelno for r in caplog.records if r.name == "gh.gen.coach"] == [logging.WARNING]


async def test_invalidate_broken_redis_only_warns_and_hides_error_text(caplog: Any) -> None:
    class Broken:
        async def delete(self, *_a: Any) -> int:
            raise ConnectionError("redis down")

    with caplog.at_level(logging.WARNING, logger="gh.gen.coach"):
        await coach_cache.invalidate(Broken(), uuid.uuid4())
    msgs = [r.getMessage() for r in caplog.records if r.name == "gh.gen.coach"]
    assert len(msgs) == 1 and "ConnectionError" in msgs[0] and "redis down" not in msgs[0]


async def test_invalidate_deletes_only_this_orgs_key(redis: Any) -> None:
    a, b = uuid.uuid4(), uuid.uuid4()
    await redis.set(sg.CACHE_KEY.format(a), b"{}")
    await redis.set(sg.CACHE_KEY.format(b), b"{}")
    await coach_cache.invalidate(redis, a)
    assert not await redis.exists(sg.CACHE_KEY.format(a))
    assert await redis.exists(sg.CACHE_KEY.format(b))


# ─── mọi nơi đổi thứ thẻ đọc đều làm mới cache ngay (sau commit) ──────────────────────────────────────────────────


async def test_binding_put_and_delete_clear_card_cache(owner_api: Api, app: Any) -> None:
    org, _pid, mid = await _api_source(owner_api)
    await _warm(app, org)
    r = await owner_api.send("PUT", "/agents/bindings/core.refinery", {"model_id": mid})
    assert r.status_code == 200, r.text
    assert not await _cached(app, org)
    await _warm(app, org)
    r = await owner_api.send("DELETE", "/agents/bindings/core.refinery")
    assert r.status_code == 204, r.text
    assert not await _cached(app, org)


async def test_add_model_clears_card_cache(owner_api: Api, app: Any) -> None:
    org, pid, _mid = await _api_source(owner_api)
    await _warm(app, org)
    r = await owner_api.send("POST", f"/providers/{pid}/models", {"model_name": "m2"})
    assert r.status_code == 201, r.text
    assert not await _cached(app, org)


async def test_boss_check_run_clears_card_cache(owner_api: Api, app: Any) -> None:
    org, _pid, _mid = await _api_source(owner_api)
    app.state.model_router.transport = httpx.MockTransport(
        lambda req: httpx.Response(200, json={"data": [{"id": "m1"}]})
    )
    await _warm(app, org)
    r = await owner_api.send("POST", "/boss-checks/ai_source/run", {})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pass"
    assert not await _cached(app, org)


async def test_heal_agy_clears_card_cache_after_adopting_model(owner_api: Api, app: Any, clis: Any) -> None:
    org, pid = await _cli_without_models(owner_api, AGY, "4/an")
    await _warm(app, org)
    assert await app.state.model_router._heal_agy(org) is True
    assert not await _cached(app, org)
    async with sessionmaker()() as db:
        n = (
            await db.execute(text("SELECT count(*) FROM agent.models WHERE provider_id = :p"), {"p": uuid.UUID(pid)})
        ).scalar_one()
    assert n == 1
