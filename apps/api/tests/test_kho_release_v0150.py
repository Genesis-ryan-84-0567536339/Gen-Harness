"""v0.1.50 (F-87, QD-18) — Gen đề xuất ghi một Phiên vào Kho Ryan mỗi khi máy chủ lên bản mới (cron `gen_kho_release`).

Mỗi (tổ chức, phiên bản) ĐÚNG MỘT lần (bảng agent.hub_release_proposals); chỉ khi Gen-hub đã cấp quyền ghi Kho; job chỉ
ĐỀ XUẤT (0 lời gọi ghi) — ghi khi Owner bấm Xác nhận + PIN; Owner thứ hai xác nhận cùng bản → 409. Migration 0032
chạy lại an toàn."""

import asyncio
import uuid
from typing import Any

import orjson
import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import gh
from gh.crypto import hash_secret
from gh.db import admin_sessionmaker, sessionmaker
from gh.gen import kho_release, proposals
from gh.hub_link import kho_write
from gh.worker import JOB_LABELS, WorkerSettings
from tests.conftest import PG, Api
from tests.phase2 import org_id
from tests.test_gen_proposals import _log
from tests.test_hub_kho_write_v0150 import PREFIX, FakeHub, _linked, _pin, fake_hub  # noqa: F401
from tests.test_rbac_api import PASSWORD
from tests.test_rls import _as_low_priv

REPO = "Genesis-ryan-84-0567536339/Gen-Harness"
TITLE = "Gen đề xuất ghi Kho · Phiên {v}"


async def _run(redis: Any, now: Any = None) -> dict[str, Any]:
    return await kho_release.run(sessionmaker(), redis, now)


async def _rows() -> list[Any]:
    async with admin_sessionmaker()() as db:
        return (await db.execute(text("""SELECT org_id, version, status, proposal_ids, kho_ma, created_at, decided_at,
                                                decided_by FROM agent.hub_release_proposals
                                         ORDER BY version"""))).all()


async def _count(sql: str) -> int:
    async with admin_sessionmaker()() as db:
        return int((await db.execute(text(sql))).scalar_one())


async def _release_proposal(api: Api, version: str = "v0.1.50") -> dict[str, Any]:
    """Thẻ đề xuất của hội thoại 'Gen đề xuất ghi Kho · Phiên {version}' của chính người đang đăng nhập."""
    convs = [c for c in (await api.get("/gen/conversations")).json() if c["title"] == TITLE.format(v=version)]
    assert len(convs) == 1, convs
    msgs = (await api.get(f"/gen/conversations/{convs[0]['id']}/messages")).json()
    assert len(msgs) == 1 and msgs[0]["role"] == "assistant"
    steps = msgs[0]["content"]["steps"]
    assert [s["kind"] for s in steps] == ["say", "proposal"]
    p: dict[str, Any] = steps[1]["proposal"]
    return p


async def _add_owner(db: Any, email: str = "owner2@example.vn") -> Api:
    org = await org_id(db)
    uid = (await db.execute(text("""INSERT INTO core.users (org_id, email, display_name, password_hash, pin_hash)
                                    VALUES (:o, :e, 'Owner hai', :p, :pin) RETURNING id"""),
                            {"o": org, "e": email, "p": hash_secret(PASSWORD), "pin": hash_secret("112233")})
                           ).scalar_one()
    await db.execute(text("""INSERT INTO core.user_roles (user_id, role_id)
                             SELECT :u, id FROM core.roles WHERE code = 'owner'"""), {"u": uid})
    await db.commit()
    return uid  # type: ignore[no-any-return]


async def _login(client: Any, email: str) -> Api:
    api = Api(client.__class__(transport=client._transport, base_url="http://test"))
    r = await api.send("POST", "/auth/login", {"email": email, "password": PASSWORD})
    assert r.status_code == 200, r.text
    return api


# ─── 1. Mỗi (tổ chức, phiên bản) đúng một lần ────────────────────────────────────────────────────────────────────

async def test_job_proposes_once_per_version(owner_api: Api, fake_hub: FakeHub, db: Any, redis: Any,  # noqa: F811
                                             monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    fake_hub.calls.clear()
    first = await _run(redis)
    org = str(await org_id(db))
    assert first["version"] == "v0.1.50" and first[org] == "proposed"
    second = await _run(redis)
    assert second[org] == "already_proposed"
    rows = await _rows()
    assert len(rows) == 1 and rows[0].version == "v0.1.50" and rows[0].status == "pending"
    assert len(rows[0].proposal_ids) == 1 and rows[0].kho_ma is None and rows[0].decided_at is None
    # Đúng 1 hội thoại + 1 đề xuất + 1 chuông cho Owner; 0 lời gọi ghi (job không gọi Gen-hub).
    p = await _release_proposal(owner_api)
    assert fake_hub.calls == []
    assert await _count("SELECT count(*) FROM agent.gen_conversations WHERE title LIKE 'Gen đề xuất ghi Kho%'") == 1
    bells = (await owner_api.get("/notifications")).json()["items"]
    bell = [b for b in bells if b["kind"] == "gen.kho_proposal"]
    assert len(bell) == 1 and bell[0]["title"] == TITLE.format(v="v0.1.50")
    convs = (await owner_api.get("/gen/conversations")).json()
    cid = next(c["id"] for c in convs if c["title"] == TITLE.format(v="v0.1.50"))
    assert bell[0]["link"] == f"/overview?gen={cid}"
    # Thẻ đề xuất do HỆ THỐNG dựng.
    assert p["id"] == str(rows[0].proposal_ids[0]) and p["type"] == "kho_create" and p["status"] == "pending"
    assert set(p) == {"id", "type", "fields", "summary", "labels", "target", "requires_pin", "status"}
    today = kho_write.vn_today().isoformat()
    assert p["fields"] == {"bang": "Phiên", "record": {
        "Chủ đề": "Gen-Harness lên bản v0.1.50", "Ngày": today,
        "Đã chốt": ("Máy chủ Gen-Harness đã nâng lên v0.1.50. Ghi chú phát hành: "
                    f"https://github.com/{REPO}/releases/tag/v0.1.50")}}
    assert p["requires_pin"] is True and p["target"] == "hub.kho_write:Phiên"
    assert p["labels"] == {"bang": "Phiên", "target": "Tạo mới ở bảng Phiên", "write_scope": "ok"}
    assert p["summary"].endswith("Chỉ ghi khi Sếp bấm Xác nhận và nhập mã PIN (qua Gen-hub).")
    # Redis: sống 7 ngày, mang khoá meta release_version (không thuộc fields).
    stored = await proposals.load(redis, p["id"])
    assert stored is not None and stored["release_version"] == "v0.1.50" and "release_version" not in stored["fields"]
    assert 6 * 86400 < await redis.ttl(proposals.key(p["id"])) <= 7 * 86400
    # Action Log hệ thống.
    log = await _log("gen.kho_release_proposed")
    assert len(log) == 1 and log[0].actor_type == "system" and log[0].detail["version"] == "v0.1.50"
    assert log[0].detail["proposal_ids"] == [p["id"]] and log[0].detail["owners"] == 1
    # Phiên bản mới ⇒ thêm đúng một lần nữa.
    monkeypatch.setattr(gh, "__version__", "v0.1.51")
    assert (await _run(redis))[org] == "proposed"
    assert [r.version for r in await _rows()] == ["v0.1.50", "v0.1.51"]
    p51 = await _release_proposal(owner_api, "v0.1.51")
    assert p51["fields"]["record"]["Chủ đề"] == "Gen-Harness lên bản v0.1.51"
    assert fake_hub.writes() == []


async def test_dev_and_prerelease_versions_are_skipped(owner_api: Api, fake_hub: FakeHub, redis: Any,  # noqa: F811
                                                       monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    for raw in ("0.0.0-dev", "dev", "0.1.50-rc1", "", "v0.1"):
        monkeypatch.setattr(gh, "__version__", raw)
        out = await _run(redis)
        assert out["skipped"] == "dev_version" and out["version"] is None, raw
    assert await _rows() == [] and fake_hub.writes() == []
    # Không có 'v' ở đầu vẫn chuẩn hoá thành vX.Y.Z.
    monkeypatch.setattr(gh, "__version__", "0.1.50")
    await _run(redis)
    assert [r.version for r in await _rows()] == ["v0.1.50"]
    assert kho_release.version_of("1.2.3") == "v1.2.3" and kho_release.version_of("v10.20.30") == "v10.20.30"


async def test_not_eligible_inserts_nothing_then_retries(owner_api: Api, fake_hub: FakeHub, db: Any,  # noqa: F811
                                                         redis: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    org = str(await org_id(db))
    assert (await _run(redis))[org] == "hub_off"                       # chưa nối Gen-hub
    fake_hub.drop = {"kho_update"}
    await _linked(owner_api)                                           # nối nhưng chưa đủ quyền ghi Kho
    assert (await _run(redis))[org] == "no_write_scope" and await _rows() == []
    fake_hub.drop = set()                                              # Sếp tick quyền rồi bấm Kiểm tra
    assert (await owner_api.send("POST", "/hub/link/test", {})).json()["write_scopes"] == {"kho": True}
    assert (await _run(redis))[org] == "proposed" and len(await _rows()) == 1
    # Gen tắt → không đề xuất cho bản kế.
    await db.execute(text("""UPDATE core.organizations SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb),
        '{gen}', COALESCE(settings->'gen', '{}'::jsonb) || '{"enabled": false}'::jsonb)"""))
    await db.commit()
    monkeypatch.setattr(gh, "__version__", "v0.1.51")
    assert (await _run(redis))[org] == "gen_off" and len(await _rows()) == 1
    assert fake_hub.writes() == []


async def test_concurrent_runs_propose_once(owner_api: Api, fake_hub: FakeHub, redis: Any,  # noqa: F811
                                            monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    outs = await asyncio.gather(_run(redis), _run(redis))
    kinds_ = sorted(next(v for k, v in o.items() if k not in ("version", "expired", "reset")) for o in outs)
    assert kinds_ == ["already_proposed", "proposed"]
    assert len(await _rows()) == 1
    assert await _count("SELECT count(*) FROM agent.gen_conversations WHERE title LIKE 'Gen đề xuất ghi Kho%'") == 1
    assert await _count("SELECT count(*) FROM core.notifications WHERE kind = 'gen.kho_proposal'") == 1


# ─── 2. Xác nhận + PIN → đúng MỘT lời gọi; Owner thứ hai → 409 ───────────────────────────────────────────────────

async def test_confirm_writes_phien_and_marks_written(owner_api: Api, fake_hub: FakeHub, db: Any,  # noqa: F811
                                                      redis: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    await _run(redis)
    p = await _release_proposal(owner_api)
    fake_hub.calls.clear()
    await _pin(owner_api)
    r = await owner_api.send("POST", f"/gen/proposals/{p['id']}/confirm", {})
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "confirmed" and r.json()["result"]["code"] == "PHIEN-12"
    assert fake_hub.calls == [PREFIX + "kho_create"]
    assert fake_hub.args[-1] == {"bang": "Phiên", "fields": p["fields"]["record"]}
    row = (await _rows())[0]
    assert row.status == "written" and row.kho_ma == "PHIEN-12" and row.decided_at is not None
    me = (await owner_api.get("/auth/me")).json()
    assert str(row.decided_by) == me["id"]
    conf = await _log("gen.proposal_confirmed")
    assert len(conf) == 1 and conf[0].detail["release_version"] == "v0.1.50"
    assert len(await _log("hub.kho_written")) == 1
    # Job chạy lại không dựng lại bản đã ghi; xác nhận lại → 409.
    assert (await _run(redis))[str(await org_id(db))] == "already_proposed"
    again = await owner_api.send("POST", f"/gen/proposals/{p['id']}/confirm", {})
    assert again.status_code == 409 and again.json()["code"] == "GEN_PROPOSAL_DECIDED"
    assert fake_hub.writes() == [PREFIX + "kho_create"]


async def test_second_owner_cannot_write_same_version(owner_api: Api, fake_hub: FakeHub, db: Any,  # noqa: F811
                                                      client: Any, redis: Any,
                                                      monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    await _add_owner(db)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    await _run(redis)
    assert await _count("SELECT count(*) FROM agent.gen_conversations WHERE title LIKE 'Gen đề xuất ghi Kho%'") == 2
    assert await _count("SELECT count(*) FROM core.notifications WHERE kind = 'gen.kho_proposal'") == 2
    row = (await _rows())[0]
    assert len(row.proposal_ids) == 2 and (await _log("gen.kho_release_proposed"))[0].detail["owners"] == 2
    b = await _login(client, "owner2@example.vn")
    try:
        pa, pb = await _release_proposal(owner_api), await _release_proposal(b)
        assert pa["id"] != pb["id"] and {pa["id"], pb["id"]} == {str(x) for x in row.proposal_ids}
        fake_hub.calls.clear()
        await _pin(owner_api)
        assert (await owner_api.send("POST", f"/gen/proposals/{pa['id']}/confirm", {})).status_code == 200
        assert (await b.send("POST", "/auth/pin/verify", {"pin": "112233"})).status_code == 200
        r = await b.send("POST", f"/gen/proposals/{pb['id']}/confirm", {})
        assert r.status_code == 409 and r.json()["code"] == "GEN_PROPOSAL_DECIDED"
        assert r.json()["title"] == "Bản này đã được ghi vào Kho hoặc đã huỷ"
        assert fake_hub.writes() == [PREFIX + "kho_create"]                              # vẫn đúng một lời gọi
        # Thẻ của Owner hai vẫn 'pending' trong Redis (không bị đánh dấu đã ghi) nhưng không ghi được nữa.
        assert (await proposals.load(redis, pb["id"]))["status"] == "pending"
    finally:
        await b.c.aclose()
    assert (await _rows())[0].status == "written"


async def test_failed_write_returns_to_pending_and_can_retry(owner_api: Api, fake_hub: FakeHub,  # noqa: F811
                                                             redis: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    await _run(redis)
    p = await _release_proposal(owner_api)
    await _pin(owner_api)
    fake_hub.mode = "write_timeout"
    r = await owner_api.send("POST", f"/gen/proposals/{p['id']}/confirm", {})
    assert r.status_code == 502 and r.json()["code"] == "HUB_WRITE_UNCERTAIN"
    row = (await _rows())[0]
    assert row.status == "pending" and row.kho_ma is None and row.decided_at is None
    fake_hub.mode = "ok"
    async for k in redis.scan_iter(match="gh:hub:brk:*"):
        await redis.delete(k)
    r = await owner_api.send("POST", f"/gen/proposals/{p['id']}/confirm", {})
    assert r.status_code == 200, r.text
    assert (await _rows())[0].status == "written" and (await _rows())[0].kho_ma == "PHIEN-12"
    assert len(fake_hub.writes()) == 2                                       # 1 lần timeout + 1 lần ghi được


async def test_cancel_cancels_version_for_everyone(owner_api: Api, fake_hub: FakeHub, db: Any,  # noqa: F811
                                                   client: Any, redis: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    await _add_owner(db)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    await _run(redis)
    b = await _login(client, "owner2@example.vn")
    try:
        pa, pb = await _release_proposal(owner_api), await _release_proposal(b)
        fake_hub.calls.clear()
        r = await owner_api.send("POST", f"/gen/proposals/{pa['id']}/cancel", {})
        assert r.status_code == 200 and r.json()["status"] == "cancelled"
        row = (await _rows())[0]
        assert row.status == "cancelled" and row.decided_at is not None
        await b.send("POST", "/auth/pin/verify", {"pin": "112233"})
        r = await b.send("POST", f"/gen/proposals/{pb['id']}/confirm", {})
        assert r.status_code == 409 and r.json()["code"] == "GEN_PROPOSAL_DECIDED"
        assert fake_hub.writes() == []
    finally:
        await b.c.aclose()
    # Đã huỷ thì job không dựng lại bản này.
    assert (await _run(redis))[str(await org_id(db))] == "already_proposed"


# ─── 3. Dọn: hết hạn / kẹt 'writing' ──────────────────────────────────────────────────────────────────────────────

async def test_expired_and_stuck_rows_are_cleaned(owner_api: Api, fake_hub: FakeHub, db: Any,  # noqa: F811
                                                  redis: Any, monkeypatch: pytest.MonkeyPatch) -> None:
    await _linked(owner_api)
    monkeypatch.setattr(gh, "__version__", "v0.1.50")
    await _run(redis)
    p = await _release_proposal(owner_api)
    old = "UPDATE agent.hub_release_proposals SET created_at = now() - interval '8 days'"
    async with admin_sessionmaker()() as adm:
        await adm.execute(text(old))
        await adm.commit()
    # Đề xuất Redis còn sống ⇒ vẫn 'pending'.
    out = await _run(redis)
    assert out["expired"] == 0 and (await _rows())[0].status == "pending"
    # Đề xuất Redis hết hạn (7 ngày) mà vẫn 'pending' ⇒ 'expired'.
    await redis.delete(proposals.key(p["id"]))
    out = await _run(redis)
    assert out["expired"] == 1 and (await _rows())[0].status == "expired"
    assert (await _rows())[0].decided_at is not None
    # 'writing' mà không còn khoá đang-ghi (tiến trình ghi chết giữa chừng) ⇒ trả về 'pending'.
    async with admin_sessionmaker()() as adm:
        await adm.execute(text("UPDATE agent.hub_release_proposals SET status = 'writing'"))
        await adm.commit()
    await redis.set(proposals.key(p["id"]), orjson.dumps({"id": p["id"], "status": "pending"}))
    await redis.set(proposals.claim_key(p["id"]), "1", ex=60)                         # đang ghi thật ⇒ giữ nguyên
    assert (await _run(redis))["reset"] == 0 and (await _rows())[0].status == "writing"
    await redis.delete(proposals.claim_key(p["id"]))
    assert (await _run(redis))["reset"] == 1 and (await _rows())[0].status == "pending"


# ─── 4. Cron + migration ──────────────────────────────────────────────────────────────────────────────────────────

def test_cron_registered() -> None:
    cj = next(c for c in WorkerSettings.cron_jobs if c.name == "cron:gen_kho_release")
    assert cj.minute == {7, 37} and cj.hour is None
    assert JOB_LABELS["gen_kho_release"] == "Đề xuất ghi Phiên vào Kho"
    assert any(getattr(f, "__name__", "") == "gen_kho_release" for f in WorkerSettings.functions)


async def test_migration_0032_is_rerunnable_and_constrained(owner_api: Api, fresh_db: str, db: Any) -> None:
    from migrations import sqlfile  # type: ignore[import-not-found]

    sql = (sqlfile.sql_dir() / "0032_v0150_gen_memory_kho_write.sql").read_text(encoding="utf-8")
    with psycopg.connect(f"{PG}/{fresh_db}", autocommit=True) as c:        # đã migrate một lần; chạy thêm hai lần nữa
        c.execute(sql)  # type: ignore[arg-type]
        c.execute(sql)  # type: ignore[arg-type]
    org = await org_id(db)
    ok_cases = [
        "INSERT INTO agent.hub_release_proposals (org_id, version, status) VALUES (:o, 'v0.1.50', 'pending')",
        "INSERT INTO agent.gen_memory_notes (org_id, text, source) VALUES (:o, 'a', 'gen')",
    ]
    for sql_ in ok_cases:
        await db.execute(text(sql_), {"o": org})
    await db.commit()
    bad_cases = [
        "INSERT INTO agent.hub_release_proposals (org_id, version, status) VALUES (:o, 'v1.2', 'pending')",
        "INSERT INTO agent.hub_release_proposals (org_id, version, status) VALUES (:o, 'v0.1.51', 'done')",
        "INSERT INTO agent.hub_release_proposals (org_id, version, status) VALUES (:o, 'v0.1.50', 'pending')",  # PK
        "INSERT INTO agent.gen_memory_notes (org_id, text, source) VALUES (:o, '', 'gen')",
        f"INSERT INTO agent.gen_memory_notes (org_id, text, source) VALUES (:o, '{'x' * 281}', 'gen')",
        "INSERT INTO agent.gen_memory_notes (org_id, text, source) VALUES (:o, 'b', 'khach')",
        f"INSERT INTO agent.gen_memory_notes (org_id, text, reason, source) VALUES (:o, 'c', '{'y' * 201}', 'gen')",
    ]
    for sql_ in bad_cases:
        with pytest.raises(DBAPIError):
            await db.execute(text(sql_), {"o": org})
        await db.rollback()
    # proposal_id UNIQUE: một đề xuất chỉ lưu một ghi chú.
    pid = uuid.uuid4()
    await db.execute(text("INSERT INTO agent.gen_memory_notes (org_id, text, source, proposal_id) "
                          "VALUES (:o, 'd', 'gen', :p)"), {"o": org, "p": pid})
    with pytest.raises(DBAPIError):
        await db.execute(text("INSERT INTO agent.gen_memory_notes (org_id, text, source, proposal_id) "
                              "VALUES (:o, 'e', 'gen', :p)"), {"o": org, "p": pid})
    await db.rollback()


@pytest.mark.parametrize(("table", "insert"), [
    ("agent.gen_memory_notes", "INSERT INTO agent.gen_memory_notes (org_id, text, source) VALUES (:o, 'n', 'owner')"),
    ("agent.hub_release_proposals",
     "INSERT INTO agent.hub_release_proposals (org_id, version, status) VALUES (:o, 'v0.1.50', 'pending')"),
])
async def test_new_tables_rls_isolate_orgs(app: Any, db: Any, table: str, insert: str) -> None:
    org_a = await org_id(db)
    org_b = (await db.execute(text(
        "INSERT INTO core.organizations (name) VALUES ('Tổ chức B (RLS 0032)') RETURNING id"))).scalar_one()
    org_c = (await db.execute(text(
        "INSERT INTO core.organizations (name) VALUES ('Tổ chức C (RLS 0032)') RETURNING id"))).scalar_one()
    for org in (org_a, org_b):
        await db.execute(text(insert), {"o": org})
    await _as_low_priv(db, table)
    await db.execute(text("SELECT set_config('app.org_id', :o, true)"), {"o": str(org_a)})
    assert (await db.execute(text(f"SELECT org_id FROM {table}"))).scalars().all() == [org_a]  # noqa: S608
    with pytest.raises(Exception, match="row-level security|row_level_security"):
        await db.execute(text(insert), {"o": org_c})
