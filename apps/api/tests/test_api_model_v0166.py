"""v0.1.66 (gói C3) — phía máy chủ của màn API & Model:

- F008: gỡ được một model đã thêm nhầm (DELETE /providers/{id}/models/{mid}) — gỡ luôn dòng gán trỏ vào nó, ghi Action
  Log `provider.model_deleted`, model lạ ⇒ 404; (xoá khoá đã có sẵn, nay có nút ở web);
- F009: hạn mức ngày / lượt-phút đặt qua POST /providers/{id}/models và KHÔNG bị xoá khi chỉ bấm "Dùng model này";
- F015 / F134: "Khoá & phiên" nói cùng nhãn với mọi màn (lần Kiểm tra lỗi ⇒ "Lỗi kết nối", không "Cần đăng nhập") và
  không còn dòng "khoá phiên QR" của Zalo / WhatsApp trong thẻ tài khoản Google.
"""

import uuid

from sqlalchemy import text

from tests.conftest import Api, verify_pin
from tests.phase2 import org_id
from tests.test_defaults_v0155 import AGY, API, add_source, bind


async def _quota(db, pid, name):  # type: ignore[no-untyped-def]
    await db.rollback()
    r = (await db.execute(text("""SELECT daily_quota, rate_limit_per_min, is_default FROM agent.models
                                  WHERE provider_id = :p AND model_name = :m"""), {"p": pid, "m": name})).one()
    return r.daily_quota, r.rate_limit_per_min, r.is_default


async def test_delete_model_removes_bindings_and_logs(owner_api: Api, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    pid, ids = await add_source(db, org, API, "alpha", 1, ["m-flash", "m-pro"])
    await bind(db, org, "core.gen", ids["m-pro"])
    r = await owner_api.send("DELETE", f"/providers/{pid}/models/{ids['m-pro']}")
    assert r.status_code == 204, r.text
    await db.rollback()
    left = (await db.execute(text("SELECT model_name FROM agent.models WHERE provider_id = :p"),
                             {"p": pid})).scalars().all()
    assert left == ["m-flash"]
    # vai quay về model chuẩn
    assert (await db.execute(text("SELECT count(*) FROM agent.bindings"))).scalar_one() == 0
    log = (await db.execute(text("""SELECT detail FROM ops.action_log
                                 WHERE action = 'provider.model_deleted'"""))).all()
    assert len(log) == 1 and log[0].detail["model_name"] == "m-pro"
    # Model đã gỡ / không thuộc nguồn này ⇒ 404 (không đụng model của nguồn khác).
    assert (await owner_api.send("DELETE", f"/providers/{pid}/models/{ids['m-pro']}")).status_code == 404
    other, oids = await add_source(db, org, API, "beta", 2, ["b-1"])
    assert (await owner_api.send("DELETE", f"/providers/{pid}/models/{oids['b-1']}")).status_code == 404
    assert (await owner_api.send("DELETE", f"/providers/{uuid.uuid4()}/models/{ids['m-flash']}")).status_code == 404


async def test_quota_is_kept_when_only_choosing_default(owner_api: Api, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    pid, _ = await add_source(db, org, API, "alpha", 1, ["m-flash"])
    r = await owner_api.send("POST", f"/providers/{pid}/models",
                             {"model_name": "m-flash", "daily_quota": 500, "rate_limit_per_min": 20})
    assert r.status_code == 201, r.text
    assert await _quota(db, pid, "m-flash") == (500, 20, False)
    # "Dùng model này" chỉ gửi model_name + make_default ⇒ hạn mức giữ nguyên.
    r = await owner_api.send("POST", f"/providers/{pid}/models", {"model_name": "m-flash", "make_default": True})
    assert r.status_code == 201, r.text
    assert await _quota(db, pid, "m-flash") == (500, 20, True)
    # Gửi null ⇒ bỏ hạn mức.
    r = await owner_api.send("POST", f"/providers/{pid}/models",
                             {"model_name": "m-flash", "daily_quota": None, "rate_limit_per_min": 20})
    assert r.status_code == 201, r.text
    assert await _quota(db, pid, "m-flash") == (None, 20, True)


async def test_credentials_label_error_is_connection_error_and_no_qr_rows(owner_api: Api, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await verify_pin(owner_api)
    pid, _ = await add_source(db, org, AGY, "Antigravity", 1, ["gemini-3.8-flash"])
    for state, label in (("ok", "Hoạt động"), ("error", "Lỗi kết nối"), ("expired", "Hết hạn"),
                         ("unconfigured", "Chưa đăng nhập")):
        await db.execute(text("UPDATE agent.providers SET auth_state = :s WHERE id = :p"), {"s": state, "p": pid})
        await db.commit()
        rows = (await owner_api.get("/providers/credentials")).json()
        cli = next(c for c in rows if c["name"].startswith("Antigravity"))
        assert cli["state_label"] == label, (state, cli)
    assert not [c for c in rows if "QR" in c["name"] or c["icon"] == "qr-code"]
