"""v0.1.35 (F-20): tạo / sửa nhà cung cấp AI, chuỗi chuyển hướng, thêm khoá API cần phiên PIN `ai.route_change`.

Mục tiêu: phiên Owner bị lấy (vd qua XSS) không thể âm thầm chuyển lưu lượng LLM ra máy chủ lạ. PIN kiểm SAU quyền:
vai trò thiếu `system.manage` vẫn nhận 403 (không lộ là route có PIN). Ngoài phạm vi (không 423): GET, DELETE nhà cung
cấp / khoá, /test (khoá chỉ thu hẹp hoặc kiểm đường đi, không mở đường mới).
"""

import secrets
import uuid

import pytest
from sqlalchemy import text

from gh import crypto
from gh.auth.service import PIN_OPERATIONS
from gh.providers.router import KEY_AAD
from tests.conftest import Api, verify_pin
from tests.phase2 import org_id
from tests.test_rbac_api import login_as


def _fake_key() -> str:
    # Khoá test sinh ngẫu nhiên — không bao giờ là khoá thật.
    return "sk-test-" + secrets.token_hex(12)


async def _seed_provider(db) -> uuid.UUID:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    pid = (await db.execute(text("""INSERT INTO agent.providers (org_id, kind, name, endpoint, failover_rank)
                                    VALUES (:o, 'openai_compat', 'Nguồn có sẵn', 'https://co-san.test/v1', 1)
                                    RETURNING id"""), {"o": org})).scalar_one()
    k = _fake_key()
    await db.execute(text("""INSERT INTO agent.provider_keys (provider_id, label, secret_enc, last4, rotation_order)
                             VALUES (:p, 'API-KEY-01', :s, :f, 0)"""),
                     {"p": pid, "s": crypto.encrypt(k.encode(), KEY_AAD), "f": k[-4:]})
    await db.commit()
    return pid


def _routes(pid: uuid.UUID) -> list[tuple[str, str, dict]]:  # type: ignore[type-arg]
    return [
        ("POST", "/providers", {"kind": "openai_compat", "name": "Máy chủ lạ", "endpoint": "https://la.test/v1",
                                "keys": [_fake_key()], "models": ["m-la"]}),
        ("PATCH", "/providers/chain", {"provider_ids": [str(pid)]}),
        ("PATCH", f"/providers/{pid}", {"enabled": False}),
        ("PATCH", f"/providers/{pid}", {"failover_rank": 2}),
        ("POST", f"/providers/{pid}/keys", {"secret": _fake_key()}),
    ]


ROUTE_IDS = ["create", "chain", "toggle", "rank", "add_key"]
OK_STATUS = {"create": 201, "chain": 200, "toggle": 200, "rank": 200, "add_key": 201}


def test_route_change_declared() -> None:
    assert "ai.route_change" in PIN_OPERATIONS
    assert PIN_OPERATIONS["ai.route_change"] == "Thêm / sửa nhà cung cấp AI, khoá API, chuỗi chuyển hướng"


@pytest.mark.parametrize("idx", range(len(ROUTE_IDS)), ids=ROUTE_IDS)
async def test_owner_without_pin_gets_423_then_ok(owner_api, db, idx: int) -> None:  # type: ignore[no-untyped-def]
    api: Api = owner_api
    pid = await _seed_provider(db)
    method, path, body = _routes(pid)[idx]
    r = await api.send(method, path, body)
    assert r.status_code == 423, r.text
    j = r.json()
    assert j["code"] == "PIN_REQUIRED"
    assert j.get("detail") is None or isinstance(j["detail"], str)
    # Chưa có gì thay đổi khi bị chặn.
    provs = (await api.get("/providers")).json()
    assert [p["name"] for p in provs] == ["Nguồn có sẵn"]
    assert provs[0]["enabled"] is True and len(provs[0]["keys"]) == 1 and provs[0]["failover_rank"] == 1

    await verify_pin(api)
    r = await api.send(method, path, body)
    assert r.status_code == OK_STATUS[ROUTE_IDS[idx]], r.text


@pytest.mark.parametrize("role", ["manager", "operator"])
@pytest.mark.parametrize("idx", range(len(ROUTE_IDS)), ids=ROUTE_IDS)
async def test_role_without_permission_gets_403_not_423(owner_api, client, db, role: str,  # type: ignore[no-untyped-def]
                                                        idx: int) -> None:
    pid = await _seed_provider(db)
    staff = await login_as(client, db, role)
    method, path, body = _routes(pid)[idx]
    r = await staff.send(method, path, body)
    assert r.status_code == 403, r.text
    assert r.json()["code"] == "FORBIDDEN"
    # Kể cả khi đã nhập PIN của chính mình, vẫn 403.
    await verify_pin(staff, "112233")
    r = await staff.send(method, path, body)
    assert r.status_code == 403, r.text


async def test_out_of_scope_routes_not_pin_gated(owner_api, db) -> None:  # type: ignore[no-untyped-def]
    api: Api = owner_api
    pid = await _seed_provider(db)
    assert (await api.get("/providers")).status_code == 200
    r = await api.send("POST", f"/providers/{pid}/test")
    assert r.status_code != 423, r.text
    kid = (await api.get("/providers")).json()[0]["keys"][0]["id"]
    r = await api.send("DELETE", f"/providers/{pid}/keys/{kid}")
    assert r.status_code != 423, r.text
    r = await api.send("DELETE", f"/providers/{pid}")
    assert r.status_code == 204, r.text


async def test_action_log_still_recorded_with_pin(owner_api, db) -> None:  # type: ignore[no-untyped-def]
    api: Api = owner_api
    await verify_pin(api)
    r = await api.send("POST", "/providers", {"kind": "deepseek", "name": "DeepSeek chính",
                                              "keys": [_fake_key()], "models": ["deepseek-chat"]})
    assert r.status_code == 201, r.text
    pid = r.json()["id"]
    rows = (await db.execute(text("""SELECT action, target_label FROM ops.action_log
                                     WHERE action = 'provider.created' AND target_id = :t"""),
                             {"t": pid})).all()
    assert [(x.action, x.target_label) for x in rows] == [("provider.created", "DeepSeek chính")]
