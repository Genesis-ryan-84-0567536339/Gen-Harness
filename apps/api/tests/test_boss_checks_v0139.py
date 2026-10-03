"""v0.1.39 — bảng kết quả kiểm thật "Việc Sếp cần làm" (ops.boss_checks, migration 0025) + /boss-checks.

Gen-hub giả bằng `httpx.MockTransport` (token đặc trưng để dò rò rỉ), Jev giả qua `model_router.transport`, Facebook
qua worker trình duyệt GIẢ của test_social (không có Facebook thật). Kiểm: chỉ Owner, PIN cho hub/agy_switch, lỗi
nghiệp vụ vẫn 200 + 'fail' kèm mã lỗi thống nhất, không bí mật/email đầy đủ trong CSDL, quy tắc 'done' từng dòng."""

import uuid
from pathlib import Path
from typing import Any

import httpx
import orjson
import psycopg
import pytest
from redis.asyncio import Redis
from sqlalchemy import text

from gh.boss_checks import service as boss
from gh.db import admin_sessionmaker
from tests.conftest import PG, Api, verify_pin
from tests.phase2 import org_id
from tests.test_rbac_api import login_as
from tests.test_social import _add as social_add
from tests.test_social import _login as social_login

SQL_FILE = Path(__file__).resolve().parents[3] / "db" / "sql" / "0025_v0139_boss_checks.sql"
CANARY = "gh-tok-CANARY-123456"
ENDPOINT = "http://127.0.0.1:9911/mcp"
PREFIX = "mcp-58450__"


class CanaryHub:
    """Gen-hub `/mcp` giả với token đặc trưng; `mode`: ok | 401 | echo (lỗi lặp lại header Authorization)."""

    def __init__(self) -> None:
        self.mode = "ok"

    def handle(self, req: httpx.Request) -> httpx.Response:
        body = orjson.loads(req.content)
        auth = req.headers.get("authorization")
        if auth != f"Bearer {CANARY}" or self.mode == "401":
            return httpx.Response(401, text=f"unauthorized: {auth}")
        if self.mode == "echo" and body["method"] == "tools/call":
            return httpx.Response(500, text=f"boom authorization={auth} token={CANARY}")
        if body["method"] == "tools/list":
            ro = {"readOnlyHint": True}
            return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"], "result": {"tools": [
                {"name": PREFIX + n, "description": n, "inputSchema": {}, "annotations": ro}
                for n in ("kho_tom_tat", "kho_search", "kho_get", "kho_find_by_id", "kho_list")]}})
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": body["id"],
                                         "result": {"content": [{"type": "text", "text": "VIEC-1 xong"}]}})


@pytest.fixture
def canary_hub(app: Any) -> CanaryHub:
    h = CanaryHub()
    app.state.mcp_transport = httpx.MockTransport(h.handle)
    return h


async def _db_text(sql: str) -> str:
    async with admin_sessionmaker()() as db:
        return orjson.dumps((await db.execute(text(sql))).all(), default=str).decode()


async def _run(api: Api, key: str, body: dict[str, Any] | None = None) -> httpx.Response:
    return await api.send("POST", f"/boss-checks/{key}/run", body or {})


# ─── (a) migration ──────────────────────────────────────────────────────────

async def test_migration_0025_is_rerunnable(fresh_db: str) -> None:
    sql = SQL_FILE.read_text(encoding="utf-8")
    with psycopg.connect(f"{PG}/{fresh_db}", autocommit=True) as c:
        c.execute(sql)  # type: ignore[call-overload]
        c.execute(sql)  # type: ignore[call-overload]
        n = c.execute("SELECT count(*) FROM pg_policies WHERE tablename = 'boss_checks'").fetchone()
        idx = c.execute("SELECT count(*) FROM pg_indexes WHERE indexname = 'boss_checks_key_idx'").fetchone()
    assert n is not None and n[0] == 1
    assert idx is not None and idx[0] == 1


# ─── (b) Gen-hub ────────────────────────────────────────────────────────────

async def test_hub_run_pass_fail_and_token_never_stored(owner_api: Api, canary_hub: CanaryHub) -> None:
    # Chưa cấu hình → vẫn 200, 'fail' với mã của dịch vụ.
    await verify_pin(owner_api)
    r = await _run(owner_api, "hub")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "fail" and r.json()["error_code"] == "HUB_LINK_NOT_CONFIGURED"
    r = await owner_api.send("PATCH", "/hub/link", {"endpoint": ENDPOINT, "token": CANARY})
    assert r.status_code == 200, r.text
    r = await _run(owner_api, "hub")
    out = r.json()
    assert r.status_code == 200 and out["status"] == "pass", out
    assert out["error_code"] is None and out["detail"]["exposed_tools"] == 5 and out["detail"]["missing_tools"] == []
    assert isinstance(out["detail"]["latency_ms"], int) and out["runs"] == 2
    canary_hub.mode = "401"
    out = (await _run(owner_api, "hub")).json()
    assert out["status"] == "fail" and out["error_code"] == "HUB_TOKEN_REJECTED"
    assert out["message"].startswith("401: Token Gen-hub")
    canary_hub.mode = "echo"
    out = (await _run(owner_api, "hub")).json()
    assert out["status"] == "fail" and CANARY not in orjson.dumps(out).decode()
    assert CANARY not in await _db_text("SELECT message, detail::text FROM ops.boss_checks")
    assert CANARY not in await _db_text("SELECT * FROM ops.action_log")
    assert CANARY not in (await owner_api.get("/boss-checks")).text


# ─── (c) quyền ──────────────────────────────────────────────────────────────

async def test_pin_owner_only_and_unknown_key(owner_api: Api, client: httpx.AsyncClient, db: Any) -> None:
    for key in ("hub", "agy_switch"):
        r = await _run(owner_api, key, {"profile_id": str(uuid.uuid4())})
        assert r.status_code == 423 and r.json()["code"] == "PIN_REQUIRED", r.text
    r = await _run(owner_api, "agy_login")
    assert r.status_code == 404 and r.headers["content-type"].startswith("application/problem+json")
    assert (await _run(owner_api, "khong_co")).status_code == 404
    await verify_pin(owner_api)
    r = await _run(owner_api, "agy_switch", {})
    assert r.status_code == 422
    for role in ("operator", "manager"):
        api = await login_as(client, db, role)
        assert (await api.get("/boss-checks")).status_code == 403
        assert (await _run(api, "jev")).status_code == 403
    assert await _db_text("SELECT id FROM ops.boss_checks") == "[]"      # 403/404/422/423 không ghi gì


# ─── (d) Jev ────────────────────────────────────────────────────────────────

async def test_jev_not_configured_error_and_pass(owner_api: Api, app: Any) -> None:
    out = (await _run(owner_api, "jev")).json()
    assert out["status"] == "fail" and out["error_code"] == "JEV_NOT_CONFIGURED" and "Jev" in out["message"]
    await verify_pin(owner_api)
    r = await owner_api.send("POST", "/providers", {"kind": "system_one", "name": "Jev (System One)",
                                                    "keys": ["sk-or-v1-khoa-thu-nghiem-jev"]})
    assert r.status_code == 201, r.text
    app.state.model_router.transport = httpx.MockTransport(lambda req: httpx.Response(500, text="hỏng"))
    out = (await _run(owner_api, "jev")).json()
    assert out["status"] == "fail" and out["error_code"] == "JEV_ERROR", out
    assert "account" not in out
    app.state.model_router.transport = httpx.MockTransport(lambda req: httpx.Response(200, json={
        "choices": [{"message": {"content": '{"choice": "có", "confidence": 0.97}'}}]}))
    out = (await _run(owner_api, "jev")).json()
    assert out["status"] == "pass" and out["error_code"] is None and out["runs"] == 3, out
    assert "sk-or-v1-khoa" not in await _db_text("SELECT message, detail::text FROM ops.boss_checks")
    ov = (await owner_api.get("/boss-checks")).json()
    assert next(r for r in ov["rows"] if r["key"] == "jev")["done"] is True
    assert ov["required_done"] == 0                                    # Jev không bắt buộc


# ─── (e) Facebook ───────────────────────────────────────────────────────────

async def test_facebook_no_account_pending_then_resolved(owner_api: Api, redis: Redis) -> None:
    out = (await _run(owner_api, "facebook")).json()
    assert out["status"] == "fail" and out["error_code"] == "SOCIAL_NO_ACCOUNT"
    assert out["message"].startswith("Chưa có tài khoản Facebook")
    acc = await social_add(owner_api)
    # Có tài khoản nhưng chưa đăng nhập → lỗi nghiệp vụ của dịch vụ, vẫn 200.
    out = (await _run(owner_api, "facebook")).json()
    assert out["status"] == "fail" and out["error_code"] == "SOCIAL_NOT_ACTIVE"
    await social_login(owner_api, redis, acc["id"])
    out = (await _run(owner_api, "facebook")).json()
    assert out["status"] == "pending" and out["detail"]["job_status"] == "queued", out
    ov = (await owner_api.get("/boss-checks")).json()
    assert ov["results"]["facebook"]["status"] == "pending"
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE agent.browser_jobs SET status = 'done', error = 'x' WHERE kind = 'read'"))
        await db.commit()
    ov = (await owner_api.get("/boss-checks")).json()
    fb = ov["results"]["facebook"]
    assert fb["status"] == "pass" and fb["detail"]["job_status"] == "done" and fb["error_code"] is None
    assert next(r for r in ov["rows"] if r["key"] == "facebook")["done"] is True
    # Bấm lại ngay (cách < 10 phút) → 429 SOCIAL_RATE_LIMIT là lỗi TẠM: trả về nhưng KHÔNG ghi, "Đạt" giữ nguyên.
    out = (await _run(owner_api, "facebook", {"account_id": acc["id"]})).json()
    assert out["status"] == "fail" and out["error_code"] == "SOCIAL_RATE_LIMIT" and out["transient"] is True, out
    ov = (await owner_api.get("/boss-checks")).json()
    assert ov["results"]["facebook"]["status"] == "pass" and ov["results"]["facebook"]["runs"] == 3
    assert next(r for r in ov["rows"] if r["key"] == "facebook")["done"] is True
    # Lượt đọc kế (lùi giờ lượt trước cho qua khoảng cách tối thiểu) → lỗi ở worker.
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE agent.browser_jobs SET created_at = now() - interval '2 days', "
                              "finished_at = now() - interval '2 days' WHERE kind = 'read'"))
        await db.commit()
    out = (await _run(owner_api, "facebook", {"account_id": acc["id"]})).json()
    assert out["status"] == "pending", out
    async with admin_sessionmaker()() as db:
        await db.execute(text("""UPDATE agent.browser_jobs SET status = 'failed', error = 'LỖI THÔ cookie=xs-123'
                                 WHERE kind = 'read' AND status = 'queued'"""))
        await db.commit()
    fb = (await owner_api.get("/boss-checks")).json()["results"]["facebook"]
    assert fb["status"] == "fail" and fb["error_code"] == "SOCIAL_READ_FAILED" and fb["runs"] == 4
    assert "cookie" not in fb["message"] and "LỖI THÔ" not in await _db_text("SELECT * FROM ops.boss_checks")
    # Việc đã biến mất (tài khoản bị gỡ) → SOCIAL_JOB_MISSING.
    async with admin_sessionmaker()() as db:
        org = await org_id(db)
        await boss.record(db, org, "facebook", "pending", ref_id=uuid.uuid4(), detail={"job_status": "queued"})
        assert await boss.resolve_pending(db, org) == 1
        await db.commit()
        latest = await boss.latest(db, org)
    assert latest["facebook"] is not None and latest["facebook"]["error_code"] == "SOCIAL_JOB_MISSING"


async def test_facebook_stale_job_closed_and_cancelled_has_own_code(owner_api: Api, redis: Redis) -> None:
    """Việc đọc treo quá STALE_AFTER (worker trình duyệt chết/chưa chạy) → GET /boss-checks tự đóng việc (failed +
    WORKER_TIMEOUT) và chốt ô Facebook là lỗi, không kẹt "Đang chạy…" mãi. Việc bị huỷ lẻ → SOCIAL_READ_CANCELLED
    (không phải "Dừng tất cả")."""
    acc = await social_add(owner_api)
    await social_login(owner_api, redis, acc["id"])
    out = (await _run(owner_api, "facebook", {"account_id": acc["id"]})).json()
    assert out["status"] == "pending", out
    async with admin_sessionmaker()() as db:   # mới 10 phút: vẫn đang chạy
        await db.execute(text("UPDATE agent.browser_jobs SET status = 'running', "
                              "created_at = now() - interval '10 minutes' WHERE kind = 'read'"))
        await db.commit()
    fb = (await owner_api.get("/boss-checks")).json()["results"]["facebook"]
    assert fb["status"] == "pending" and fb["detail"]["job_status"] == "running"
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE agent.browser_jobs SET created_at = now() - interval '16 minutes' "
                              "WHERE kind = 'read'"))
        await db.commit()
    fb = (await owner_api.get("/boss-checks")).json()["results"]["facebook"]
    assert fb["status"] == "fail" and fb["error_code"] == "WORKER_TIMEOUT", fb
    assert fb["message"] == boss.SOCIAL_TIMEOUT_MSG and fb["detail"]["job_status"] == "failed"
    assert "WORKER_TIMEOUT" in await _db_text("SELECT status, error FROM agent.browser_jobs WHERE kind = 'read'")
    # Lượt mới (lùi giờ lượt trước cho qua khoảng cách tối thiểu) rồi bị huỷ lẻ.
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE agent.browser_jobs SET created_at = now() - interval '2 days', "
                              "finished_at = now() - interval '2 days' WHERE kind = 'read'"))
        await db.commit()
    out = (await _run(owner_api, "facebook", {"account_id": acc["id"]})).json()
    assert out["status"] == "pending", out
    async with admin_sessionmaker()() as db:
        await db.execute(text("UPDATE agent.browser_jobs SET status = 'cancelled' "
                              "WHERE kind = 'read' AND status = 'queued'"))
        await db.commit()
    fb = (await owner_api.get("/boss-checks")).json()["results"]["facebook"]
    assert fb["status"] == "fail" and fb["error_code"] == "SOCIAL_READ_CANCELLED", fb
    assert "Dừng tất cả" not in fb["message"]


# ─── (f) tổng quan + quy tắc 'done' ─────────────────────────────────────────

async def test_overview_rows_and_done_rules(owner_api: Api, db: Any) -> None:
    ov = (await owner_api.get("/boss-checks")).json()
    assert [r["row"] for r in ov["rows"]] == [1, 2, 3, 4, 5, 6]
    assert [r["key"] for r in ov["rows"]] == ["hub", "facebook", "agy", "claude", "jev", "telegram"]
    assert ov["rows"][2]["title"] == "Google / Antigravity" and ov["rows"][2]["checks"] == [
        "agy_login", "agy_call", "agy_switch"]
    # v0.1.44 (F-8c): dòng 6 Telegram (báo động & bản tin) — bắt buộc.
    assert ov["rows"][5]["title"] == "Telegram (báo động & bản tin)" and ov["rows"][5]["checks"] == ["telegram"]
    assert [r["optional"] for r in ov["rows"]] == [False, False, False, False, True, False]
    assert ov["required_total"] == 5 and ov["required_done"] == 0
    assert set(ov["results"]) == set(boss.CHECK_KEYS) and all(v is None for v in ov["results"].values())
    org = await org_id(db)

    async def rows() -> dict[str, bool]:
        body = (await owner_api.get("/boss-checks")).json()
        return {r["key"]: r["done"] for r in body["rows"]} | {"_n": body["required_done"]}

    await boss.record(db, org, "agy_call", "pass")
    await boss.record(db, org, "agy_switch", "pass")
    await db.commit()
    assert (await rows())["agy"] is False                               # mới đổi 1 lần
    await boss.record(db, org, "agy_switch", "fail", error_code="AGY_ACCOUNT_MISMATCH")
    await boss.record(db, org, "agy_switch", "pass")
    await db.commit()
    assert (await rows())["agy"] is True                                # đổi qua lại 2 lần đạt
    await boss.record(db, org, "agy_call", "fail", error_code="AUTH_EXPIRED")
    await db.commit()
    assert (await rows())["agy"] is False                               # lần gọi thử mới nhất lỗi
    await boss.record(db, org, "claude_login", "pass")
    await db.commit()
    assert (await rows())["claude"] is False
    await boss.record(db, org, "claude_call", "pass")
    await boss.record(db, org, "hub", "pass")
    await db.commit()
    got = await rows()
    assert got["claude"] is True and got["hub"] is True and got["facebook"] is False and got["_n"] == 2


async def test_switch_counter_counts_real_switches_only(owner_api: Api, db: Any) -> None:
    """Bộ đếm "Đã đổi qua lại x/2" = `switch_passes`: không tính lượt lỗi, không tính đổi sang CHÍNH tài khoản vừa đổi
    tới; `results.agy_switch.runs` vẫn là tổng số bản ghi (cả lỗi)."""
    org = await org_id(db)
    a, b = str(uuid.uuid4()), str(uuid.uuid4())

    async def ov() -> dict[str, Any]:
        return (await owner_api.get("/boss-checks")).json()  # type: ignore[no-any-return]

    await boss.record(db, org, "agy_call", "pass")
    await boss.record(db, org, "agy_switch", "pass", detail={"target_profile": a})
    await boss.record(db, org, "agy_switch", "fail", error_code="AGY_ACCOUNT_MISMATCH", detail={"target_profile": b})
    await db.commit()
    got = await ov()
    assert got["switch_passes"] == 1 and got["results"]["agy_switch"]["runs"] == 2
    await boss.record(db, org, "agy_switch", "pass", detail={"target_profile": a})       # lại chính tài khoản a
    await db.commit()
    got = await ov()
    assert got["switch_passes"] == 1 and next(r for r in got["rows"] if r["key"] == "agy")["done"] is False
    await boss.record(db, org, "agy_switch", "pass", detail={"target_profile": b})
    await db.commit()
    got = await ov()
    assert got["switch_passes"] == 2 and next(r for r in got["rows"] if r["key"] == "agy")["done"] is True


# ─── (g) /system/health ─────────────────────────────────────────────────────

async def test_health_has_boss_checks_without_changing_overall(owner_api: Api, db: Any) -> None:
    before = (await owner_api.get("/system/health")).json()
    org = await org_id(db)
    await boss.record(db, org, "claude_call", "fail", error_code="AUTH_EXPIRED", message="hết hạn",
                      detail={"account_masked": "b***@example.vn"})
    await boss.record(db, org, "hub", "pass", detail={"latency_ms": 12})
    await db.commit()
    after = (await owner_api.get("/system/health")).json()
    assert after["overall"] == before["overall"]
    got = {c["key"]: c for c in after["boss_checks"]}
    assert set(got) == {"claude_call", "hub"}
    assert got["claude_call"]["status"] == "fail" and got["claude_call"]["error_code"] == "AUTH_EXPIRED"
    assert set(got["hub"]) == {"key", "status", "error_code", "checked_at"}     # không lộ detail cho system.read
    assert "b***@example.vn" not in (await owner_api.get("/system/health")).text


# ─── (h) bộ lọc bí mật + giữ 50 bản ─────────────────────────────────────────

async def test_record_whitelists_detail_redacts_message_and_trims(owner_api: Api, db: Any) -> None:
    org = await org_id(db)
    out = await boss.record(db, org, "jev", "fail", error_code="JEV_ERROR",
                            message="Jev: HTTP 401 khoá sk-abcdefghijklmnop1234 của binh@example.vn " + "x" * 400,
                            detail={"latency_ms": 5, "token": "bi-mat", "email": "binh@example.vn",
                                    "account_masked": "b***@example.vn"})
    await db.commit()
    assert out["detail"] == {"latency_ms": 5, "account_masked": "b***@example.vn"}
    blob = await _db_text("SELECT message, detail::text FROM ops.boss_checks")
    assert "sk-abcdefghijklmnop" not in blob and "bi-mat" not in blob and "binh@example.vn" not in blob
    assert len(out["message"]) <= 300
    with pytest.raises(ValueError):
        await boss.record(db, org, "khong_co", "pass")
    await db.rollback()
    for _ in range(boss.KEEP_PER_KEY + 3):
        await boss.record(db, org, "hub", "fail", error_code="HUB_ERROR")
    await db.commit()
    assert (await boss.latest(db, org))["hub"]["runs"] == boss.KEEP_PER_KEY  # type: ignore[index]
    assert boss.mask_email("binh@example.vn") == "b***@example.vn"
    assert boss.mask_email("không phải email") is None and boss.mask_email(None) is None
