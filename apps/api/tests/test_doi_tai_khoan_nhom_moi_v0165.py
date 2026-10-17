"""v0.1.65 (review P3) — quét QR tài khoản KHÁC thì «Nhóm mới» về lại MẶC ĐỊNH `silent` (Lắng nghe im lặng, QD 17/10;
không mang chế độ tự chọn của tài khoản cũ sang tài khoản mới) và bộ đếm «N nhóm mới đã vào Lắng nghe im lặng» về 0."""

from typing import Any

from sqlalchemy import text

from gh.data.common import new_group_mode, org_settings, set_channel_setting
from tests.phase2 import org_id
from tests.test_kenh_ben_v016x import _session, _status


async def _mode(db: Any, org: Any) -> str:
    await db.rollback()
    return new_group_mode(await org_settings(db, org), "zalo")


async def _asked(db: Any, org: Any) -> Any:
    await db.rollback()
    return ((await org_settings(db, org)).get("new_group_asked") or {}).get("zalo")


async def _active(app: Any, redis: Any, org: Any, sid: Any, account_id: str) -> None:
    await _status(app, redis, org, "session.active",
                  {"session_id": str(sid), "account": {"id": account_id, "name": f"Shop {account_id}"}})


async def test_scanning_a_different_account_resets_new_group_mode_to_default(owner_api, db, redis, app) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    # Lần nối ĐẦU TIÊN (chưa có tài khoản nào trước đó): giữ nguyên thiết lập đang có
    await set_channel_setting(db, org, "new_group_mode", "zalo", "off")
    await set_channel_setting(db, org, "new_groups_silent", "zalo", 4)
    await db.commit()
    first = await _session(db, org, state="pending_qr", started_ago_h=None, cred=False, qr_ago_h=0.01)
    await _active(app, redis, org, first, "A1")
    assert await _mode(db, org) == "off"
    # Quét lại ĐÚNG tài khoản đó: giữ
    again = await _session(db, org, state="pending_qr", started_ago_h=None, cred=False, qr_ago_h=0.01)
    await set_channel_setting(db, org, "new_group_asked", "zalo", True)
    await db.commit()
    await _active(app, redis, org, again, "A1")
    assert await _mode(db, org) == "off" and await _asked(db, org) is True
    # Quét tài khoản KHÁC: về mặc định silent (Lắng nghe im lặng), xoá bộ đếm thông báo của tài khoản cũ
    other = await _session(db, org, state="pending_qr", started_ago_h=None, cred=False, qr_ago_h=0.01)
    await _active(app, redis, org, other, "B2")
    assert await _mode(db, org) == "silent" and await _asked(db, org) is False
    await db.rollback()
    assert ((await org_settings(db, org)).get("new_groups_silent") or {}).get("zalo") == 0
    log = (await db.execute(text("""SELECT detail FROM ops.action_log
                                    WHERE action = 'channel.new_group_mode_reset'"""))).all()
    assert len(log) == 1 and log[0].detail == {"from": "off", "reason": "account_changed"}
