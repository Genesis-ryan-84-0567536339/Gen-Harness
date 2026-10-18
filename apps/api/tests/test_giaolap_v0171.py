# ruff: noqa: F811 — fixture `world` nhập từ test_p3_market
"""v0.1.71 — lỗi tìm thấy khi giả lập toàn luồng trên v0.1.70 (ke-hoach/review/giaolap-v0170.md). Mỗi mục một khối,
đỏ trước khi sửa, xanh sau."""

import datetime as dt
from typing import Any

from sqlalchemy import text

from gh.biz.queue import jobs as queue_jobs
from gh.db import sessionmaker
from tests.phase2 import listen, msg, org_id, put
from tests.test_p3_market import world  # noqa: F401 — fixture
from tests.test_p3_queue import _person_of, _unit

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


