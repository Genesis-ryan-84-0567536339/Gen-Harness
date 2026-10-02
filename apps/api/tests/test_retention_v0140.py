"""v0.1.40 (F-2): hạn lưu dữ liệu THẬT (gh/retention.py).

- Bảng phân vùng: PATCH đặt `partman.part_config.retention` (+ `retention_keep_table = false`) theo MAX qua mọi tổ
  chức; tổ chức chưa đặt ⇒ giữ mãi (NULL).
- ops.action_log: "Không áp dụng" — PATCH keep_days ⇒ 422 tiếng Việt; GET luôn keep_days null.
- Xoá theo lô: memory.entries (đã nén, quá hạn, không ghim), browser_jobs.result 14 ngày, tệp đính kèm mồ côi; gom
  hội thoại Gen + chuông vào `retention_sweep`; ghi `gh:retention:last`; một phần lỗi không chặn phần khác.
"""

from collections import Counter
from pathlib import Path
from typing import Any

import orjson
import psycopg
import pytest
from redis.asyncio import Redis
from sqlalchemy import event, text

from gh import retention
from gh.chassis import objects
from gh.db import admin_sessionmaker, get_engine
from gh.memory import notebook
from tests.conftest import PG, Api, verify_pin
from tests.phase2 import org_id

SQL_0026 = Path(__file__).resolve().parents[3] / "db" / "sql" / "0026_v0140_retention_jobs.sql"


async def test_migration_0026_is_rerunnable(fresh_db: str) -> None:
    """Migration 0026 chạy lại (lần 2, lần 3 sau khi alembic đã chạy lần 1) không lỗi, không nhân đôi policy/chỉ mục."""
    sql = SQL_0026.read_text(encoding="utf-8")
    with psycopg.connect(f"{PG}/{fresh_db}", autocommit=True) as c:
        c.execute(sql)  # type: ignore[call-overload]
        c.execute(sql)  # type: ignore[call-overload]
        pol = c.execute("""SELECT count(*) FROM pg_policies
                           WHERE schemaname = 'ops' AND tablename = 'job_watermarks'""").fetchone()
        idx = c.execute("""SELECT count(*) FROM pg_indexes WHERE indexname IN ('persons_lower_name_trgm_idx',
                           'browser_jobs_finished_result_idx', 'memory_entries_archived_idx',
                           'attachments_event_received_idx')""").fetchone()
    assert pol is not None and pol[0] == 1
    assert idx is not None and idx[0] == 4


async def _part_config(table: str) -> Any:
    async with admin_sessionmaker()() as adb:
        return (await adb.execute(text("""SELECT retention, retention_keep_table FROM partman.part_config
                                          WHERE parent_table = :t"""), {"t": table})).one()


async def _patch(api: Api, dataset: str, keep: int | None) -> Any:
    return await api.send("PATCH", "/retention-policies", {"dataset": dataset, "keep_days": keep})


@pytest.mark.parametrize("dataset", ["raw.events", "clean.meaning_units", "agent.model_calls"])
async def test_patch_syncs_partman(owner_api: Api, db, dataset: str) -> None:  # type: ignore[no-untyped-def]
    api = owner_api
    await verify_pin(api)
    r = await _patch(api, dataset, 30)
    assert r.status_code == 200, r.text
    row = next(x for x in r.json() if x["dataset"] == dataset)
    assert row["keep_days"] == 30 and row["partman_synced"] is True and row["mode"] == "partition"
    pc = await _part_config(dataset)
    assert pc.retention == "30 days" and pc.retention_keep_table is False

    r = await _patch(api, dataset, None)
    assert r.status_code == 200, r.text
    pc = await _part_config(dataset)
    assert pc.retention is None and pc.retention_keep_table is False

    # Hai tổ chức 30 và 90 ⇒ hạn hiệu lực 90 (MAX); tổ chức thứ hai chưa đặt ⇒ giữ mãi.
    org2 = (await db.execute(text("INSERT INTO core.organizations (name) VALUES ('Tổ chức 2') RETURNING id"))
            ).scalar_one()
    await db.commit()
    r = await _patch(api, dataset, 30)
    assert r.status_code == 200
    assert (await _part_config(dataset)).retention is None
    await db.execute(text("""INSERT INTO ops.retention_policies (org_id, dataset, keep_days) VALUES (:o, :d, 90)"""),
                     {"o": org2, "d": dataset})
    await db.commit()
    await retention.sync_partman_now()
    assert (await _part_config(dataset)).retention == "90 days"


async def test_action_log_not_applicable(owner_api: Api) -> None:
    api = owner_api
    await verify_pin(api)
    r = await _patch(api, "ops.action_log", 10)
    assert r.status_code == 422, r.text
    body = r.json()
    assert body["code"] == "RETENTION_NOT_APPLICABLE"
    assert body["errors"]["keep_days"] == "Nhật ký hành động chưa áp dụng hạn lưu (chuỗi chống sửa)"
    r = await _patch(api, "ops.action_log", None)
    assert r.status_code == 200
    got = {x["dataset"]: x for x in (await api.get("/retention-policies")).json()}
    al = got["ops.action_log"]
    assert al["mode"] == "not_applicable" and al["keep_days"] is None and al["editable"] is False
    assert al["note"] == "Không áp dụng — nhật ký chống sửa được giữ nguyên"
    pc = await _part_config("ops.action_log")
    assert pc.retention is None


async def test_get_has_mode_note_and_browser_row(owner_api: Api, redis: Redis) -> None:
    api = owner_api
    rows = (await api.get("/retention-policies")).json()
    got = {x["dataset"]: x for x in rows}
    assert list(got)[:5] == ["raw.events", "clean.meaning_units", "ops.action_log", "memory.entries",
                             "agent.model_calls"]
    for x in rows:
        assert {"dataset", "keep_days", "anonymize_after_days", "mode", "editable", "note", "last_run_at",
                "last_deleted"} <= set(x)
        assert isinstance(x["note"], str) and x["note"]
    assert got["raw.events"]["note"] == "Xoá theo tháng: cả tháng quá hạn mới bị xoá"
    assert got["memory.entries"]["mode"] == "batch"
    assert got["memory.entries"]["note"] == "Chỉ xoá mục sổ tay đã nén; mục ghim giữ mãi"
    br = got["agent.browser_jobs.result"]
    assert br["keep_days"] == 14 and br["editable"] is False and br["mode"] == "batch"
    assert got["raw.events"]["last_run_at"] is None

    await redis.set(retention.LAST_KEY, orjson.dumps({"at": "2026-10-01T22:00:00Z", "datasets": {
        "memory.entries": {"mode": "batch", "deleted": 12}}}))
    got = {x["dataset"]: x for x in (await api.get("/retention-policies")).json()}
    assert got["memory.entries"]["last_run_at"] == "2026-10-01T22:00:00Z"
    assert got["memory.entries"]["last_deleted"] == 12
    assert got["raw.events"]["last_deleted"] is None


# ─── lượt dọn hằng ngày ─────────────────────────────────────────────────────────────────────────────────────

class _FakeStore:
    def __init__(self) -> None:
        self.deleted: list[str] = []

    async def put(self, key: str, data: bytes) -> None:
        return None

    async def get(self, key: str) -> bytes:
        return b""

    async def delete(self, key: str) -> None:
        self.deleted.append(key)


@pytest.fixture
async def swept(owner_api: Api, db, redis: Redis, monkeypatch):  # type: ignore[no-untyped-def]
    org = await org_id(db)
    uid = (await db.execute(text("SELECT id FROM core.users WHERE org_id = :o LIMIT 1"), {"o": org})).scalar_one()
    pid = (await db.execute(text("""INSERT INTO core.persons (org_id, code, display_name)
                                    VALUES (:o, 'PER-R1', 'Chị Mai') RETURNING id"""), {"o": org})).scalar_one()
    nb = await notebook.ensure(db, org, "person", pid)
    await db.execute(text("""INSERT INTO ops.retention_policies (org_id, dataset, keep_days)
                             VALUES (:o, 'memory.entries', 30), (:o, 'raw.events', 30)"""), {"o": org})
    await db.execute(text("""
        INSERT INTO memory.entries (notebook_id, section, body, author, is_pinned, archived_at)
        SELECT :nb, 'rolling_context', 'cũ ' || g, 'agent:test', false, now() - interval '40 days'
        FROM generate_series(1, 12005) g"""), {"nb": nb.id})
    await db.execute(text("""
        INSERT INTO memory.entries (notebook_id, section, body, author, is_pinned, archived_at) VALUES
          (:nb, 'rolling_context', 'ghim cũ', 'user:x', true, now() - interval '400 days'),
          (:nb, 'rolling_context', 'nén gần đây', 'agent:test', false, now() - interval '5 days'),
          (:nb, 'rolling_context', 'đang dùng', 'agent:test', false, NULL)"""), {"nb": nb.id})
    acc = (await db.execute(text("""INSERT INTO core.social_accounts (org_id, platform, label)
                                    VALUES (:o, 'facebook_personal', 'FB') RETURNING id"""), {"o": org})).scalar_one()
    jobs = {}
    for days in (15, 13):
        jobs[days] = (await db.execute(text("""
            INSERT INTO agent.browser_jobs (org_id, account_id, kind, status, result, finished_at)
            VALUES (:o, :a, 'read', 'done', '{"posts": ["x"]}', now() - make_interval(days => :d)) RETURNING id"""),
            {"o": org, "a": acc, "d": days})).scalar_one()
    gen_old = (await db.execute(text("""INSERT INTO agent.gen_conversations (org_id, user_id, last_at)
                                        VALUES (:o, :u, now() - interval '200 days') RETURNING id"""),
                                {"o": org, "u": uid})).scalar_one()
    await db.execute(text("""INSERT INTO core.notifications (org_id, user_id, kind, title, created_at)
                             VALUES (:o, :u, 'test.old', 'cũ', now() - interval '100 days')"""), {"o": org, "u": uid})
    await db.execute(text("""
        INSERT INTO raw.attachments (event_id, event_received_at, storage_key, mime, bytes, sha256) VALUES
          (core.uuid_v7(), now() - interval '60 days', 'att/old.bin', 'image/png', 1, '\\x00'),
          (core.uuid_v7(), now() - interval '2 days', 'att/new.bin', 'image/png', 1, '\\x00')"""))
    await db.commit()
    store = _FakeStore()
    monkeypatch.setattr(objects, "_store", store)
    return {"org": org, "nb": nb.id, "jobs": jobs, "gen_old": gen_old, "store": store}


async def test_retention_sweep_batches_and_summary(swept, db, redis: Redis) -> None:  # type: ignore[no-untyped-def]
    seen: Counter[str] = Counter()

    def on_exec(conn: Any, cursor: Any, statement: str, *a: Any) -> None:
        if "DELETE FROM memory.entries" in statement:
            seen["memory"] += 1

    sync_engine = get_engine().sync_engine
    event.listen(sync_engine, "before_cursor_execute", on_exec)
    try:
        out = await retention.retention_sweep({"redis": redis})
    finally:
        event.remove(sync_engine, "before_cursor_execute", on_exec)

    ds = out["datasets"]
    assert ds["memory.entries"] == {"mode": "batch", "deleted": 12005, "ok": True}
    assert seen["memory"] >= 3                                          # 5000 + 5000 + 2005
    left = (await db.execute(text("SELECT body FROM memory.entries WHERE notebook_id = :n ORDER BY body"),
                             {"n": swept["nb"]})).scalars().all()
    assert left == ["ghim cũ", "nén gần đây", "đang dùng"]

    res = dict((await db.execute(text("SELECT id, result FROM agent.browser_jobs"))).all())
    assert res[swept["jobs"][15]] is None and res[swept["jobs"][13]] == {"posts": ["x"]}
    assert (await db.execute(text("SELECT count(*) FROM agent.browser_jobs"))).scalar_one() == 2  # giữ dòng việc
    assert ds["agent.browser_jobs.result"]["deleted"] == 1

    assert (await db.execute(text("SELECT count(*) FROM agent.gen_conversations WHERE id = :i"),
                             {"i": swept["gen_old"]})).scalar_one() == 0
    assert (await db.execute(text("SELECT count(*) FROM core.notifications WHERE kind = 'test.old'"))
            ).scalar_one() == 0
    assert ds["agent.gen_conversations"]["deleted"] >= 1 and ds["core.notifications"]["deleted"] >= 1

    keys = (await db.execute(text("SELECT storage_key FROM raw.attachments"))).scalars().all()
    assert keys == ["att/new.bin"] and swept["store"].deleted == ["att/old.bin"]
    assert ds["raw.attachments"]["deleted"] == 1

    assert ds["ops.action_log"]["mode"] == "not_applicable"
    assert ds["raw.events"]["mode"] == "partition" and ds["raw.events"]["ok"] is True
    pc = await _part_config("raw.events")
    assert pc.retention == "30 days" and pc.retention_keep_table is False   # sweep tự đồng bộ partman

    saved = orjson.loads(await redis.get(retention.LAST_KEY))
    assert saved["at"].endswith("Z") and saved["datasets"]["memory.entries"]["deleted"] == 12005
    assert 0 < await redis.ttl(retention.LAST_KEY) <= 14 * 86400


async def test_one_failing_part_does_not_block_others(swept, db, redis: Redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    async def boom(*a: Any, **kw: Any) -> int:
        raise RuntimeError("hỏng thử")

    monkeypatch.setattr(retention, "purge_memory_entries", boom)
    monkeypatch.setattr(retention, "sync_partman", boom)
    out = await retention.retention_sweep({"redis": redis})
    ds = out["datasets"]
    assert ds["memory.entries"]["ok"] is False and ds["raw.events"]["ok"] is False
    assert ds["agent.browser_jobs.result"] == {"mode": "batch", "deleted": 1, "ok": True}
    assert ds["agent.gen_conversations"]["ok"] is True and ds["core.notifications"]["ok"] is True
    assert ds["raw.attachments"]["deleted"] == 1                         # hạn raw.events đọc lại từ bảng chính sách
    assert (await db.execute(text("SELECT count(*) FROM memory.entries"))).scalar_one() == 12008
    assert orjson.loads(await redis.get(retention.LAST_KEY))["datasets"]["memory.entries"]["ok"] is False


async def test_worker_jobs_route_through_retention(swept, db, redis: Redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    from gh import worker

    calls: list[str] = []
    real_gen, real_notif, real_sess = retention.purge_gen, retention.purge_notifications, retention.purge_sessions

    async def spy_gen(d: Any) -> int:
        calls.append("gen")
        return await real_gen(d)

    async def spy_notif(d: Any) -> int:
        calls.append("notif")
        return await real_notif(d)

    async def spy_sess(d: Any) -> int:
        calls.append("sess")
        return await real_sess(d)

    monkeypatch.setattr(retention, "purge_gen", spy_gen)
    monkeypatch.setattr(retention, "purge_notifications", spy_notif)
    monkeypatch.setattr(retention, "purge_sessions", spy_sess)
    assert await worker.purge_gen_conversations({}) >= 1
    assert await worker.purge_notifications({}) >= 1
    assert await worker.expire_sessions({}) >= 0
    assert calls == ["gen", "notif", "sess"]
    summary = await worker.retention_sweep({"redis": redis})
    assert summary["datasets"]["memory.entries"]["deleted"] == 12005
