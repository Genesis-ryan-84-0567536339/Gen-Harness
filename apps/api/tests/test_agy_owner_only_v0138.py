# ruff: noqa: F811 — fixture `clis` nhập từ test_cli_models_v0131 (tham số test trùng tên là cách pytest dùng fixture)
"""v0.1.38 (F-22) — LUẬT CỨNG: Antigravity CLI chỉ dùng cho Gen của Sếp.

agy 1.2.9 không có cờ tắt công cụ đọc tệp/chạy lệnh và chạy cùng uid với api/worker → nội dung của khách (sàng lọc tin,
trực việc, dịch/soạn lại nháp…) không bao giờ được đưa vào agy. Không phải tuỳ chọn QD-12: không có công tắc nào tắt.
"""

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from gh.db import admin_sessionmaker, sessionmaker
from gh.gen import store
from gh.gen.engine import AGY_STAFF
from gh.providers.clients import Message
from gh.providers.router import AGY_OWNER_ONLY_REASON, ModelUnavailable
from tests.conftest import Api
from tests.test_cli_models_v0131 import (
    _login,
    _provider,
    clis,  # noqa: F401 — fixture dùng chung
)
from tests.test_rbac_api import login_as
from tests.test_ux_v0128 import _provider as _key_provider


def _calls(clis: dict[str, Any]) -> list[dict[str, Any]]:
    log = Path(clis["agy_home"]).parent.parent / "agy-calls.log"
    return [json.loads(x) for x in log.read_text().splitlines()] if log.exists() else []


async def _agy_only(api: Api) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    """Đăng nhập agy (CLI giả), lưu model gemini-3.1-pro, chỉ bật nguồn agy. → (org, provider, model)."""
    await _login(api, "antigravity_cli", "4/an")
    p = await _provider(api, "antigravity_cli")
    r = await api.send("POST", f"/providers/{p['id']}/models", {"model_name": "gemini-3.1-pro", "make_default": True})
    assert r.status_code == 201, r.text
    pid = uuid.UUID(p["id"])
    async with sessionmaker()() as db:
        org = (await db.execute(text("SELECT org_id FROM agent.providers WHERE id = :i"), {"i": pid})).scalar_one()
        mid = (await db.execute(text("SELECT id FROM agent.models WHERE provider_id = :p AND model_name = :m"),
                                {"p": pid, "m": "gemini-3.1-pro"})).scalar_one()
        await db.execute(text("UPDATE agent.providers SET is_enabled = (kind = 'antigravity_cli') WHERE org_id = :o"),
                         {"o": org})
        await db.commit()
    return org, pid, mid


# ─── (1) bộ định tuyến mặc định từ chối agy ──────────────────────────────

@pytest.mark.parametrize("agent_key,purpose", [("core.refinery", "refinery.extract"), ("agent:{id}", "duty_decide"),
                                               ("core.gen", "draft_translate")])
async def test_router_refuses_agy_unless_allowed(owner_api, app, clis, agent_key, purpose) -> None:  # type: ignore[no-untyped-def]
    org, _pid, mid = await _agy_only(owner_api)
    async with sessionmaker()() as db:   # kể cả khi khoá đó đang gán thẳng model agy (bản cài cũ)
        await db.execute(text("""INSERT INTO agent.bindings (org_id, agent_key, model_id, context_tokens)
                                 VALUES (:o, 'core.refinery', :m, 4000)
                                 ON CONFLICT (org_id, agent_key) DO UPDATE SET model_id = :m"""), {"o": org, "m": mid})
        await db.commit()
    n = len(_calls(clis))
    key = agent_key.format(id=uuid.uuid4())
    with pytest.raises(ModelUnavailable) as ei:
        await app.state.model_router.generate(org, agent_key=key, purpose=purpose,
                                              messages=[Message("user", "nội dung của khách")], json_mode=False)
    assert AGY_OWNER_ONLY_REASON in ei.value.reasons and ei.value.no_chain is False
    assert len(_calls(clis)) == n                      # CLI giả KHÔNG được gọi
    # Chỉ lượt Gen của Owner (allow_agy=True) mới dùng được agy.
    out = await app.state.model_router.generate(org, agent_key="core.gen", purpose="gen.turn",
                                                messages=[Message("user", "hi")], json_mode=False, allow_agy=True)
    assert out.text == "whoami:an@example.vn" and len(_calls(clis)) == n + 1


# ─── (2) lượt Gen: Owner dùng được, nhân viên thì không ──────────────────

async def _turn(api: Api, q: str) -> dict[str, Any]:
    r = await api.send("POST", "/gen/turns", {"text": q, "context": {"route": "/overview", "screen_key": "overview"}})
    assert r.status_code == 202, r.text
    tid = r.json()["turn_id"]
    for _ in range(300):
        t: dict[str, Any] = (await api.get(f"/gen/turns/{tid}")).json()
        if t["status"] != "running":
            return t
        await asyncio.sleep(0.05)
    raise AssertionError("lượt Gen không kết thúc")


def _says(t: dict[str, Any]) -> list[str]:
    return [s["step"]["text"] for s in t["steps"] if s["step"]["kind"] == "say"]


async def test_gen_turn_owner_uses_agy_staff_does_not(owner_api, client, db, clis) -> None:  # type: ignore[no-untyped-def]
    org, _pid, _mid = await _agy_only(owner_api)
    n = len(_calls(clis))
    t = await _turn(owner_api, "Sáng nay có gì?")
    assert len(_calls(clis)) > n and _calls(clis)[-1]["via_stdin"] is True     # Owner: agy được gọi (qua stdin)
    assert AGY_STAFF.split("{addr}")[0] not in " ".join(_says(t))

    cfg = await store.get_settings(db, org)
    await store.save_settings(db, org, {**cfg, "enabled": True, "roles": ["owner", "manager"]})
    await db.commit()
    manager = await login_as(client, db, "manager")
    try:
        n = len(_calls(clis))
        t = await _turn(manager, "Hôm nay có gì?")
        assert len(_calls(clis)) == n                                             # nhân viên: KHÔNG gọi agy
        assert any("chỉ dùng cho Gen của Sếp" in s for s in _says(t)), t
        async with admin_sessionmaker()() as adb:
            rows = (await adb.execute(text("""SELECT detail FROM ops.action_log WHERE action = 'gen.answer'
                                               AND result = 'failed' ORDER BY at DESC, id DESC"""))).scalars().all()
        assert rows and AGY_OWNER_ONLY_REASON in rows[0]["reasons"]
    finally:
        await manager.c.aclose()


# ─── (3)(4) gán model cho agent ──────────────────────────────────────────

async def test_binding_agy_only_for_gen(owner_api, clis) -> None:  # type: ignore[no-untyped-def]
    api = owner_api
    org, _pid, mid = await _agy_only(api)
    r = await api.send("PUT", "/agents/bindings/core.refinery", {"model_id": str(mid)})
    assert r.status_code == 409, r.text
    body = r.json()
    assert body["code"] == "AGY_OWNER_GEN_ONLY" and "chỉ dùng được cho Gen của Sếp" in body["title"]
    assert "sàng lọc tin" in body["title"] and "trực việc" in body["title"]
    r = await api.send("PUT", f"/agents/bindings/agent:{uuid.uuid4()}", {"model_id": str(mid)})
    assert r.status_code in (404, 409)
    r = await api.send("PUT", "/agents/bindings/core.gen", {"model_id": str(mid)})
    assert r.status_code == 200, r.text
    assert r.json()["binding"]["blocked_reason"] is None

    # Bản cài cũ đã gán agy cho sàng lọc tin → GET trả lý do bị chặn (Console hiển thị).
    async with sessionmaker()() as db:
        await db.execute(text("""INSERT INTO agent.bindings (org_id, agent_key, model_id, context_tokens)
                                 VALUES (:o, 'core.refinery', :m, 4000)
                                 ON CONFLICT (org_id, agent_key) DO UPDATE SET model_id = :m"""), {"o": org, "m": mid})
        await db.commit()
    items = {i["agent_key"]: i for i in (await api.get("/agents/bindings")).json()["items"]}
    assert items["core.refinery"]["binding"]["blocked_reason"] == AGY_OWNER_ONLY_REASON
    assert items["core.gen"]["binding"]["blocked_reason"] is None


# ─── (5) Hướng dẫn bước 4 / tự gán ───────────────────────────────────────

async def _bound(org: uuid.UUID) -> dict[str, str]:
    async with sessionmaker()() as db:
        return dict((await db.execute(text("""SELECT b.agent_key, m.model_name FROM agent.bindings b
                                               JOIN agent.models m ON m.id = b.model_id WHERE b.org_id = :o"""),
                                      {"o": org})).all())


async def test_setup_step4_binds_agy_only_to_gen(owner_api, db, clis) -> None:  # type: ignore[no-untyped-def]
    api = owner_api
    org, pid, _mid = await _agy_only(api)
    r = await api.send("PUT", "/setup/steps/4", {"provider_ids": [str(pid)]})
    assert r.status_code == 200, r.text                      # chỉ có agy vẫn hoàn tất được (Owner dùng Gen)
    bound = await _bound(org)
    assert bound == {"core.gen": "gemini-3.1-pro"}             # sàng lọc tin, trực việc… để trống

    # Thêm nguồn khoá API đã gọi thử OK → khoá lõi khác nhận model của nguồn đó, Gen vẫn giữ agy.
    key = await _key_provider(api, db, "Khoá API", ok=True, tested=["qwen2.5-7b"])
    r = await api.send("PUT", "/setup/steps/4", {"provider_ids": [str(pid), key]})
    assert r.status_code == 200, r.text
    bound = await _bound(org)
    assert bound["core.gen"] == "gemini-3.1-pro" and bound["core.refinery"] == "qwen2.5-7b"
    assert all(v == "qwen2.5-7b" for k, v in bound.items() if k != "core.gen")

    # Tự gán (auto_assign_tested_model) theo cùng luật.
    from gh.setup.routes import auto_assign_tested_model

    await db.execute(text("DELETE FROM agent.bindings WHERE org_id = :o"), {"o": org})
    await db.execute(text("UPDATE agent.providers SET is_enabled = true WHERE id = ANY(:ids)"),
                     {"ids": [pid, uuid.UUID(key)]})
    await db.execute(text("UPDATE agent.providers SET failover_rank = CASE WHEN id = :p THEN 1 ELSE 2 END "
                          "WHERE org_id = :o"), {"p": pid, "o": org})
    await db.commit()
    await auto_assign_tested_model(db, org)
    await db.commit()
    bound = await _bound(org)
    assert bound["core.gen"] == "gemini-3.1-pro" and bound["core.refinery"] == "qwen2.5-7b"


async def test_auto_assign_agy_only_leaves_other_slots_empty(owner_api, db, clis) -> None:  # type: ignore[no-untyped-def]
    org, _pid, _mid = await _agy_only(owner_api)
    from gh.setup.routes import auto_assign_tested_model

    await db.execute(text("DELETE FROM agent.bindings WHERE org_id = :o"), {"o": org})
    await db.commit()
    assert await auto_assign_tested_model(db, org) is not None
    await db.commit()
    assert await _bound(org) == {"core.gen": "gemini-3.1-pro"}


# ─── (6) tên model agy sai regex ─────────────────────────────────────────

async def test_add_agy_model_rejects_flag_like_name(owner_api, clis) -> None:  # type: ignore[no-untyped-def]
    api = owner_api
    await _login(api, "antigravity_cli", "4/an")
    p = await _provider(api, "antigravity_cli")
    n = len(_calls(clis))
    for bad in ("--x", "a b", "x" * 81):
        r = await api.send("POST", f"/providers/{p['id']}/models", {"model_name": bad})
        assert r.status_code == 422, r.text
        assert r.json()["errors"]["model_name"] == "Tên model chỉ gồm chữ, số và . _ : - (tối đa 80 ký tự)"
    assert len(_calls(clis)) == n                                # không gọi thử CLI
