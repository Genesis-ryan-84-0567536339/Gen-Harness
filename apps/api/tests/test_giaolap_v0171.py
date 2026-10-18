# ruff: noqa: F811 — fixture `world` nhập từ test_p3_market
"""v0.1.71 — lỗi tìm thấy khi giả lập toàn luồng trên v0.1.70 (ke-hoach/review/giaolap-v0170.md). Mỗi mục một khối,
đỏ trước khi sửa, xanh sau."""

import datetime as dt
import uuid
from typing import Any

from sqlalchemy import text

from gh.auth import rbac, service
from gh.biz.queue import jobs as queue_jobs
from gh.chassis.masking import mask_for_prompt
from gh.db import sessionmaker
from gh.gen import briefing
from gh.gen.tools import ToolRunner
from gh.providers.clients import Message
from gh.refinery.runner import Refinery
from tests.phase2 import FakeRouter, install_presets, listen, msg, org_id, put
from tests.test_p3_market import world  # noqa: F401 — fixture
from tests.test_p3_queue import _person_of, _unit
from tests.test_refinery import by_text

NOW = dt.datetime.now(dt.UTC)


def ts(hours_ago: float) -> str:
    return (NOW - dt.timedelta(hours=hours_ago)).isoformat()


# ─── P2-2 — chứng cứ loại raw của cảnh báo «Phản hồi chậm» ────────────────────────────────────────────────────────

async def test_slow_response_alert_explains_with_its_raw_evidence(app, db, redis, owner_api) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await listen(db, org, "g1")
    [raw] = await put(sessionmaker(), org, {**msg("Cần 3 container thép, giá bao nhiêu?", sender="u1", name="Chị Lan"),
                                            "occurred_at": ts(4)})
    lan = await _person_of(db, raw)
    unit = await _unit(db, org, person_id=lan, event_type="AskedPrice", conclusion="Hỏi giá", raw_id=raw)
    await db.commit()
    await queue_jobs.early_warning_scan({"redis_bus": redis})
    alert = (await db.execute(text("SELECT id, evidence FROM biz.alerts WHERE alert_type = 'slow_response'"))).one()
    assert alert.evidence == [{"type": "raw", "id": str(raw)}]          # chứng cứ loại raw (không phải meaning_unit)
    r = await owner_api.get(f"/explain/alert/{alert.id}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert [u["id"] for u in body["units"]] == [str(unit)], body          # đơn vị chứa tin bị bỏ quên + trích dẫn
    assert "Chưa có chứng cứ" not in body["statement"]
    assert body["units"][0]["quotes"][0]["raw_id"] == str(raw)
    inbox: Any = await owner_api.get(f"/inbox/{alert.id}")                   # chi tiết trong Hộp thư cũng thấy
    assert inbox.status_code == 200, inbox.text
    assert [u["id"] for u in inbox.json()["units"]] == [str(unit)]


# ─── P2-3 — OTP / mật khẩu / số điện thoại không vào prompt model nguyên văn ────────────────────────────

SECRET_MSG = ("Em cần 3 container thép giá 25.000.000 đồng, OTP của em là 482913, mật khẩu wifi: abc12345xyz, "
              "gọi em số 0912 345 678, STK 1234 5678 9012 3456")


def _no_secret(s: str) -> None:
    for leak in ("482913", "abc12345xyz", "0912 345 678", "0912345678", "1234 5678 9012", "912 345 678"):
        assert leak not in s, leak


def test_mask_for_prompt_hides_secrets_and_phones_but_keeps_money_dates_and_ids() -> None:
    out = mask_for_prompt(SECRET_MSG)
    _no_secret(out)
    assert "25.000.000" in out                              # số tiền để model còn trích value_vnd
    assert "•••••••678" in out                              # SĐT: che phần giữa, giữ 3 số cuối (đủ để hiểu là SĐT)
    uid = str(uuid.uuid4())
    keep = f"{uid} 2026-10-18T10:20:30.123456+07:00 18.10.2026 PER-ZL-0001234 giá 1,200,000,000 và 250000000"
    assert mask_for_prompt(keep) == keep
    nested = mask_for_prompt({"password": "abc", "n": 5, "rows": [{"text": "gọi 0987654321"}]})
    assert nested == {"password": "[đã che]", "n": 5, "rows": [{"text": "gọi •••••••321"}]}


async def test_refinery_prompt_masks_outsider_text(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await install_presets(db, org)
    await listen(db, org, "g1")
    await put(sessionmaker(), org, msg(SECRET_MSG, sender="u9", name="Chị Lan 0988777666"))
    router: FakeRouter = by_text()
    await Refinery(sessionmaker(), redis, router).run(org, "manual")  # type: ignore[arg-type]
    assert router.calls, "phải có lượt gọi model"
    prompt = "\n".join(m.content for m in router.calls[0])
    _no_secret(prompt)
    assert "0988777666" not in prompt and "25.000.000" in prompt


async def test_duty_context_line_masks_outsider_text() -> None:
    from gh.biz.duty.context import Item

    it = Item("C1", "trigger", {"type": "meaning_unit", "id": str(uuid.uuid4())}, "x",
              {"conclusion": SECRET_MSG, "quotes": [SECRET_MSG], "observed_at": dt.datetime.now(dt.UTC)})
    line = it.line()
    _no_secret(line)
    assert "25.000.000" in line and line.startswith("C1 ")


async def test_briefing_summary_prompt_masks_outsider_lines(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    seen: list[list[Message]] = []

    class _R:
        async def generate(self, org_id_: Any, **kw: Any) -> Any:
            seen.append(kw["messages"])
            return type("Routed", (), {"text": "tóm tắt"})()

    out = await briefing._summarize(_R(), org,  # type: ignore[arg-type]
                                    [{"title": "Cơ hội", "count": "1", "lines": [SECRET_MSG]}])
    assert out == "tóm tắt" and seen
    _no_secret("\n".join(m.content for m in seen[0]))
    assert "25.000.000" in seen[0][-1].content


async def test_gen_tool_results_to_model_are_masked_but_ids_survive(app, db, redis, owner_api) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await listen(db, org, "g1")
    [raw] = await put(sessionmaker(), org, msg("Cần container", sender="u1", name="Chị Lan"))
    lan = await _person_of(db, raw)
    unit = await _unit(db, org, person_id=lan, event_type="AskedPrice", conclusion=SECRET_MSG, raw_id=raw)
    await db.commit()
    token = owner_api.c.cookies.get(service.SESSION_COOKIE)
    me = service.CurrentUser(id=uuid.uuid4(), org_id=org, email="", display_name="", role_code="owner", role_name="",
                             role_id=uuid.uuid4(), team_id=None, session_id=uuid.uuid4(), pin_verified_until=None,
                             addressing={}, permissions=dict(rbac.DEFAULT_MATRIX["owner"]))
    run = ToolRunner(owner_api.c._transport.app, me, token)  # type: ignore[attr-defined]
    res = await run.run("queue.list", {"tab": "all"})
    assert res.ok and str(unit) in res.text and str(unit) in run.seen_ids       # id còn nguyên cho validator
    _no_secret(res.text)


