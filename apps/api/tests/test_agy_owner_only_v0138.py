# ruff: noqa: F811 — fixture `clis` nhập từ test_cli_models_v0131 (tham số test trùng tên là cách pytest dùng fixture)
"""v0.1.38 (F-22) — LUẬT CỨNG: Antigravity CLI chỉ dùng cho Gen của Sếp.

agy 1.2.9 không có cờ tắt công cụ đọc tệp/chạy lệnh và chạy cùng uid với api/worker → nội dung của khách (sàng lọc tin,
trực việc, dịch/soạn lại nháp…) không bao giờ được đưa vào agy. Không phải tuỳ chọn QD-12: không có công tắc nào tắt.
"""

import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text

from gh.db import admin_sessionmaker, sessionmaker
from gh.gen import store
from gh.gen.engine import AGY_STAFF
from gh.providers.clients import Message
from gh.providers.router import AGY_OWNER_ONLY_REASON, ModelRouter, ModelUnavailable, Routed
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


def _uis(t: dict[str, Any]) -> list[dict[str, Any]]:
    return [{k: v for k, v in s["step"]["action"].items() if k in ("type", "screen", "target")}
            for s in t["steps"] if s["step"]["kind"] == "ui"]


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
    assert body["code"] == "AGY_OWNER_GEN_ONLY" and body["title"] == AGY_OWNER_ONLY_REASON
    assert "chỉ dùng cho Gen — trợ lý quản trị (Gen của Sếp)" in body["title"] and "phải dùng" in body["title"]
    assert "Sàng lọc tin" in body["title"] and "trực việc" in body["title"]
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


# ─── (5) Hướng dẫn bước 4 ───────────────────────────────────────

async def _bound(org: uuid.UUID) -> dict[str, str]:
    async with sessionmaker()() as db:
        return dict((await db.execute(text("""SELECT b.agent_key, m.model_name FROM agent.bindings b
                                               JOIN agent.models m ON m.id = b.model_id WHERE b.org_id = :o"""),
                                      {"o": org})).all())


async def test_setup_step4_with_agy_only_completes_without_bindings(owner_api, db, clis) -> None:  # type: ignore[no-untyped-def]
    """v0.1.55 (G2): bước 4 KHÔNG ghi `agent.bindings` — hồ sơ tiêu chuẩn (gh.defaults.profiles) tự chọn model theo vai,
    và luật "agy chỉ cho Gen của Owner" nằm ở hồ sơ + ModelRouter (test_defaults_v0155: việc nền không bao giờ agy)."""
    api = owner_api
    org, pid, _mid = await _agy_only(api)
    r = await api.send("PUT", "/setup/steps/4", {"provider_ids": [str(pid)]})
    assert r.status_code == 200, r.text                      # chỉ có agy vẫn hoàn tất được (Owner dùng Gen)
    assert await _bound(org) == {}

    key = await _key_provider(api, db, "Khoá API", ok=True, tested=["qwen2.5-7b"])
    r = await api.send("PUT", "/setup/steps/4", {"provider_ids": [str(pid), key]})
    assert r.status_code == 200, r.text
    assert await _bound(org) == {}


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


# ─── (7) review F-22: chuỗi chỉ có agy → cảnh báo/lỗi nói đúng nguyên nhân ─────

async def test_agy_only_chain_raises_own_alert_not_p1(owner_api, app, db, clis) -> None:  # type: ignore[no-untyped-def]
    from gh.providers.router import AGY_ADD_SOURCE

    org, _pid, _mid = await _agy_only(owner_api)
    for _ in range(2):
        with pytest.raises(ModelUnavailable):
            await app.state.model_router.generate(org, agent_key="core.refinery", purpose="refinery.extract",
                                                  messages=[Message("user", "x")], json_mode=False)
    rows = (await db.execute(text("""SELECT alert_type, priority, title, suggested_action FROM biz.alerts
                                     WHERE org_id = :o AND alert_type LIKE 'model_chain%'"""), {"o": org})).all()
    assert len(rows) == 1, rows                                        # một lần, không dội chuông mỗi giờ
    a = rows[0]
    assert a.alert_type == "model_chain_agy_only" and a.priority == "P2"
    assert a.title == "Sàng lọc tin chưa có nguồn AI phù hợp" and a.suggested_action == AGY_ADD_SOURCE
    assert "đăng nhập lại" not in a.suggested_action


def test_agy_only_alert_title_names_the_source() -> None:
    """Review: cảnh báo nói đúng việc gặp lỗi (Gen nhân viên, dịch/tạo lại nháp, thử agent…), không luôn "Sàng lọc"."""
    from gh.providers.router import AGY_ALERT_TITLE, agy_only_alert_title

    assert agy_only_alert_title("core.gen", "gen.turn").startswith("Gen của nhân viên")
    assert agy_only_alert_title("agent:x", "draft_translate") == "Dịch bản nháp chưa có nguồn AI phù hợp"
    assert agy_only_alert_title("agent:x", "draft_regenerate") == "Tạo lại bản nháp chưa có nguồn AI phù hợp"
    assert agy_only_alert_title("agent:x", "setup_agent_try") == "Trò chuyện thử agent chưa có nguồn AI phù hợp"
    assert agy_only_alert_title("agent:x", "duty") == "Agent trực việc chưa có nguồn AI phù hợp"
    assert agy_only_alert_title("core.reply", "khac") == AGY_ALERT_TITLE


def test_agy_only_web_markers_match_server() -> None:
    """Web nhận diện lỗi "chỉ có Antigravity CLI" theo đầu câu máy chủ — đổi chữ ở đây thì đổi cả web."""
    from gh.providers.router import AGY_ONLY_HINT, AGY_ONLY_TITLE

    web = (Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "lib" / "friendlyError.ts").read_text("utf-8")
    title_prefix = re.search(r"AGY_ONLY_TITLE_PREFIX = '([^']+)'", web)
    mark = re.search(r"AGY_ONLY_MARK = '([^']+)'", web)
    assert title_prefix and mark
    assert AGY_ONLY_TITLE.startswith(title_prefix.group(1))
    assert AGY_ONLY_HINT.startswith(mark.group(1)) and AGY_OWNER_ONLY_REASON.startswith(mark.group(1))
    assert "Hướng dẫn bước 4" not in AGY_ONLY_HINT  # bước 4 hiện agy "sẵn sàng" ⇒ Owner đi vòng


async def test_mixed_chain_alert_drops_agy_relogin_advice(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    r = ModelRouter(sessionmaker(), redis)
    org = (await db.execute(text("SELECT id FROM core.organizations LIMIT 1"))).scalar_one()
    await r._chain_exhausted(org, [AGY_OWNER_ONLY_REASON, "alpha: 429"])
    a = (await db.execute(text("""SELECT alert_type, priority, suggested_action FROM biz.alerts
                                  WHERE alert_type LIKE 'model_chain%'"""))).one()
    assert a.alert_type == "model_chain_exhausted" and a.priority == "P1"
    assert "Antigravity" not in a.suggested_action


def test_model_unavailable_agy_only_says_real_cause() -> None:
    from gh.errors import MODEL_UNAVAILABLE_HINT, model_unavailable
    from gh.providers.router import AGY_ONLY_HINT, AGY_ONLY_TITLE

    e = model_unavailable("Chưa có model nào chạy được để thử trò chuyện", [AGY_OWNER_ONLY_REASON])
    assert e.title == AGY_ONLY_TITLE and e.detail == AGY_ONLY_HINT
    # Nhân viên: reasons đã lọc rỗng nhưng nguyên nhân vẫn đúng.
    e = model_unavailable("Chưa có model nào chạy được để dịch", [], chain_reasons=[AGY_OWNER_ONLY_REASON])
    assert e.title == AGY_ONLY_TITLE and e.extra["reasons"] == []
    e = model_unavailable("Chưa có model nào chạy được để dịch", [AGY_OWNER_ONLY_REASON, "alpha: 429"])
    assert e.title == "Chưa có model nào chạy được để dịch" and e.detail == MODEL_UNAVAILABLE_HINT


async def test_step8_try_with_agy_only_explains_rule(owner_api, app, db, clis) -> None:  # type: ignore[no-untyped-def]
    from gh.providers.router import AGY_ONLY_HINT

    org, _pid, _mid = await _agy_only(owner_api)
    await db.execute(text("UPDATE ops.setup_state SET completed = CAST(:c AS jsonb) WHERE org_id = :o"),
                     {"c": '{"steps": {"1": "done", "2": "done", "3": "done", "4": "done", "5": "done", '
                           '"6": "done", "7": "done"}}', "o": org})
    await db.commit()
    n = len(_calls(clis))
    r = await owner_api.send("PUT", "/setup/steps/8", {"name": "Trợ lý Mai", "role_desc": "Chăm sóc khách hàng",
                                                        "try_message": "Chào bạn"})
    assert r.status_code == 200, r.text
    agent = r.json()["agent"]
    assert agent["try_error"] == AGY_ONLY_HINT and agent["try_reasons"] == [AGY_OWNER_ONLY_REASON]
    assert len(_calls(clis)) == n


# ─── (8) review F-22: kết quả công cụ (nội dung khách) không bao giờ tới agy ─────

class _AgyRouter(ModelRouter):
    """ModelRouter thật về kiểu (engine truyền allow_agy), giả về hành vi: chuỗi chỉ có agy — allow_agy=False ⇒
    ModelUnavailable như bộ định tuyến thật; True ⇒ trả lần lượt các envelope kịch bản."""

    def __init__(self, replies: list[dict[str, Any]]):  # không gọi super(): không cần CSDL/Redis
        self.replies = list(replies)
        self.allow: list[bool] = []
        self.prompts: list[str] = []

    async def generate(self, org_id: Any, *, agent_key: str, purpose: str, messages: list[Message],
                       json_mode: bool = True, temperature: float = 0.2, allow_agy: bool = False) -> Routed:
        self.allow.append(allow_agy)
        if not allow_agy:
            raise ModelUnavailable([AGY_OWNER_ONLY_REASON], no_chain=False)
        self.prompts.append("\n".join(m.content for m in messages))
        r = self.replies.pop(0) if self.replies else {"steps": [{"kind": "done"}]}
        return Routed(json.dumps(r), "Antigravity CLI", "gemini-3.1-pro", 1, 1)


async def _turn_with(api: Api, app: Any, router: Any, q: str, conversation_id: str | None = None) -> dict[str, Any]:
    app.state.model_router = router
    r = await api.send("POST", "/gen/turns", {"text": q, "conversation_id": conversation_id,
                                              "context": {"route": "/overview", "screen_key": "overview"}})
    assert r.status_code == 202, r.text
    tid = r.json()["turn_id"]
    for _ in range(300):
        t: dict[str, Any] = (await api.get(f"/gen/turns/{tid}")).json()
        if t["status"] != "running":
            return t
        await asyncio.sleep(0.02)
    raise AssertionError("lượt Gen không kết thúc")


async def test_gen_tool_output_never_reaches_agy(owner_api, app) -> None:  # type: ignore[no-untyped-def]
    from gh.gen.engine import AGY_TAINTED, AGY_TAINTED_HISTORY

    router = _AgyRouter([{"steps": [{"kind": "tool", "name": "queue.list", "args": {"tab": "all"}}]}])
    t = await _turn_with(owner_api, app, router, "Hộp thư có gì?")
    assert router.allow == [True, False]                 # vòng 2 (có kết quả công cụ) KHÔNG được dùng agy
    assert len(router.prompts) == 1 and "[kết quả queue.list]" not in router.prompts[0]
    assert any(AGY_TAINTED.split("{addr}")[0] in s for s in _says(t)), t
    # Review: chuỗi chỉ có agy ⇒ vẫn dẫn Sếp tới màn API (dù chuỗi "chạy").
    assert {"type": "navigate", "screen": "api"} in _uis(t), t
    assert any(a.get("type") == "highlight" and a.get("target") == "api.bindings" for a in _uis(t)), t

    # Hỏi tiếp trong cùng hội thoại: lịch sử đã có kết quả công cụ bên ngoài ⇒ không gửi cho agy ngay từ vòng đầu, và
    # câu báo nói rõ do CUỘC TRÒ CHUYỆN (không phải câu hỏi này) + cách làm ngay: mở cuộc trò chuyện mới.
    router2 = _AgyRouter([])
    t2 = await _turn_with(owner_api, app, router2, "Xin chào", conversation_id=t["conversation_id"])
    assert router2.allow == [False] and router2.prompts == []
    says2 = _says(t2)
    assert any(AGY_TAINTED_HISTORY.split("{addr}")[0] in s and "mở cuộc trò chuyện mới" in s for s in says2), t2
    assert not any(AGY_TAINTED.split("{addr}")[0] in s for s in says2), t2
    assert {"type": "navigate", "screen": "api"} in _uis(t2), t2

    # Cuộc trò chuyện mới ⇒ agy dùng lại được ngay.
    router3 = _AgyRouter([{"steps": [{"kind": "say", "text": "Dạ."}, {"kind": "done"}]}])
    t3 = await _turn_with(owner_api, app, router3, "Xin chào")
    assert router3.allow == [True] and t3["status"] == "done"


async def test_gen_internal_tool_keeps_agy(owner_api, app) -> None:  # type: ignore[no-untyped-def]
    router = _AgyRouter([{"steps": [{"kind": "tool", "name": "screens.list", "args": {}}]},
                         {"steps": [{"kind": "say", "text": "Dạ."}, {"kind": "done"}]}])
    t = await _turn_with(owner_api, app, router, "Có những màn nào?")
    assert router.allow == [True, True] and t["status"] == "done"
    assert "[kết quả screens.list]" in router.prompts[1]
