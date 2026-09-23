"""Nhận tin vào Kho thô: nhóm chưa bật bị bỏ, trùng tin bị bỏ, tin 1-1 theo cài đặt, đường nhanh, chỉ-INSERT."""

import pytest
from sqlalchemy import text

from gh.data.ingest import handle_directory, sync_listen_sets
from gh.db import sessionmaker
from tests.phase2 import listen, msg, org_id, put


async def test_new_group_is_off_and_drops_messages(app, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    [eid] = await put(sessionmaker(), org, msg("Còn hàng không chị?", group="g-new"))
    assert eid is None
    g = (await db.execute(text("SELECT listen_mode FROM core.groups WHERE external_id = 'g-new'"))).one()
    assert g.listen_mode == "off"           # khoá cứng: nhóm mới luôn "Không nghe"
    assert (await db.execute(text("SELECT count(*) FROM raw.events"))).scalar() == 0


async def test_listening_group_ingests_and_dedupes(app, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await listen(db, org, "g1")
    sm = sessionmaker()
    a, b = await put(sm, org, msg("Báo giá 3 container thép", msg_id="zmsg-1"), msg("lặp lại", msg_id="zmsg-1"))
    assert a is not None and b is None
    row = (await db.execute(text("""SELECT e.body_text, e.direction, s.state, s.fast FROM raw.events e
                                    JOIN refinery.event_state s ON s.event_id = e.id"""))).one()
    assert (row.body_text, row.direction, row.state, row.fast) == ("Báo giá 3 container thép", "inbound", "pending",
                                                                  False)
    # người gửi thành hồ sơ tự tạo + thành viên nhóm
    person = (await db.execute(text("SELECT attrs FROM core.persons"))).scalar_one()
    assert person == {"auto": True}
    assert (await db.execute(text("SELECT count(*) FROM core.group_members"))).scalar() == 1


async def test_mention_takes_fast_path(app, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await listen(db, org, "g1", mode="tagged_only")
    await put(sessionmaker(), org, msg("@bot kiểm tra giúp", mentions=True))
    assert (await db.execute(text("SELECT fast FROM refinery.event_state"))).scalar() is True


async def test_direct_messages_follow_owner_setting(app, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    sm = sessionmaker()
    [dropped] = await put(sm, org, msg("Chào anh", group=None))
    assert dropped is None                  # mặc định không nghe tin 1-1
    await db.execute(text("""UPDATE core.organizations
                             SET settings = settings || '{"listen_direct": {"zalo": true}}'::jsonb WHERE id = :o"""),
                     {"o": org})
    await db.commit()
    [eid] = await put(sm, org, msg("Chào anh", group=None))
    assert eid is not None
    assert (await db.execute(text("SELECT fast FROM refinery.event_state"))).scalar() is True


async def test_raw_store_is_insert_only(app, db) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await listen(db, org, "g1")
    await put(sessionmaker(), org, msg("tin gốc"))
    with pytest.raises(Exception, match="(?i)insert|chỉ|append|not allowed|permission"):
        await db.execute(text("UPDATE raw.events SET body_text = 'sửa'"))
    await db.rollback()
    with pytest.raises(Exception, match="(?i)insert|chỉ|append|not allowed|permission"):
        await db.execute(text("DELETE FROM raw.events"))
    await db.rollback()


async def test_directory_and_listen_sets(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await handle_directory(db, redis, org, {"channel": "zalo", "groups": [
        {"external_id": "gA", "name": "Kênh sỉ", "member_count": 40, "members": [
            {"external_id": "p1", "name": "Anh Tùng", "phone": "0901234567"}]},
        {"external_id": "gB", "name": "Nội bộ", "member_count": 5}]})
    await db.commit()
    rows = (await db.execute(text("SELECT external_id, listen_mode, member_count FROM core.groups ORDER BY 1"))).all()
    assert [(r.external_id, r.listen_mode, r.member_count) for r in rows] == [("gA", "off", 40), ("gB", "off", 5)]
    phone = (await db.execute(text("SELECT phone_e164 FROM core.person_identities"))).scalar()
    assert phone == "+84901234567"
    await db.execute(text("UPDATE core.groups SET listen_mode = 'silent' WHERE external_id = 'gA'"))
    await sync_listen_sets(db, redis, org)
    assert await redis.smembers("gh:bridge:listen:zalo") == {b"gA"}
    assert await redis.get("gh:bridge:listen_direct:zalo") == b"0"
