# ruff: noqa: F811 — fixture `w` nhập từ test_p3_duty (tham số test trùng tên là cách pytest dùng fixture)
"""QD 17/10/2026 (Sếp, thay quyết định «hỏi khi kết nối kênh»): «Khi được add vào một group nào đó thì phải MẶC ĐỊNH
lắng nghe trong im lặng, KHÔNG trả lời cho dù được tag.»

- Nhóm mới (mọi bản cài, kể cả cũ): mặc định `silent` — lưu hết tin, không trả lời. `new_group_mode` thiếu ⇒ silent;
  `ask` (pending + hộp hỏi) / `off` vẫn chọn được. Nhóm đã có không bị đổi (nhóm cũ đang `off` giữ nguyên).
- `silent` KHÔNG BAO GIỜ trả lời, kể cả được tag: agent trực chỉ được `silent`/`note`, không `suggest`/`draft`/`send`.
  `tagged_only` («Nghe hết, chỉ trả lời khi được tag») giữ nguyên hành vi trả lời khi được tag.
- Thẻ kênh báo «N nhóm mới đã vào Lắng nghe im lặng» (`new_groups_silent`) cho tới khi Sếp bấm «Đã biết».
Các khẳng định cốt lõi (mặc định silent, silent không bao giờ trả lời kể cả khi được tag, tagged_only vẫn trả lời) đã
chuyển vào lưới L6 `test_quyet_dinh_sep.py`; tệp này giữ các ca chi tiết còn lại."""

from typing import Any

from sqlalchemy import text

from gh.data.ingest import handle_directory, handle_group_discovered
from gh.db import sessionmaker
from tests.conftest import Api, verify_pin
from tests.phase2 import msg, org_id, put
from tests.test_p3_duty import BUY, agent_drafts, decide, decisions, hook, make_agent, refine, w  # noqa: F401


# ─── nhóm mới mặc định silent ────────────────────────────────────────────────────────────────────────────────────

async def test_qd1710_directory_and_discovered_default_silent_for_every_channel(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    grp = {"external_id": "gD", "name": "Nhóm gD", "member_count": 1, "members": [{"external_id": "u1", "name": "A"}]}
    await handle_directory(db, redis, org, {"channel": "whatsapp", "groups": [grp]})
    row, fresh = await handle_group_discovered(db, redis, org, {"channel": "zalo", "group_id": "gF", "name": "Mới"})
    await db.commit()
    assert fresh is True and row.listen_mode == "silent"
    modes = dict((await db.execute(text("SELECT external_id, listen_mode FROM core.groups"))).all())
    assert modes == {"gD": "silent", "gF": "silent"}
    assert await redis.smembers("gh:bridge:listen:zalo") == {b"gF"}                  # bridge nghe nhóm vừa phát hiện
    assert await redis.smembers("gh:bridge:listen:whatsapp") == {b"gD"}


async def test_qd1710_existing_groups_are_not_changed_old_off_stays_off(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    # nhóm cũ đã có (đang off — bản ≤ 0.1.64 — hoặc pending) giữ nguyên, kể cả khi nhận tin / đồng bộ danh bạ
    await handle_directory(db, redis, org, {"channel": "zalo", "groups": [
        {"external_id": "gOff", "name": "Cũ", "member_count": 0, "members": []},
        {"external_id": "gPend", "name": "Chờ", "member_count": 0, "members": []}]})
    await db.execute(text("UPDATE core.groups SET listen_mode = 'off' WHERE external_id = 'gOff'"))
    await db.execute(text("UPDATE core.groups SET listen_mode = 'pending' WHERE external_id = 'gPend'"))
    await db.commit()
    assert await put(sessionmaker(), org, msg("x", group="gOff"), msg("y", group="gPend")) == [None, None]
    await handle_directory(db, redis, org, {"channel": "zalo", "groups": [
        {"external_id": "gOff", "name": "Cũ", "member_count": 1, "members": []}]})
    await db.commit()
    modes = dict((await db.execute(text("SELECT external_id, listen_mode FROM core.groups"))).all())
    assert modes == {"gOff": "off", "gPend": "pending"}
    assert (await db.execute(text("SELECT count(*) FROM raw.events"))).scalar_one() == 0


# ─── thông báo «N nhóm mới đã vào Lắng nghe im lặng» ──────────────────────────────────────────────────────────────

def _card(cards: list[dict[str, Any]], type_: str = "zalo") -> dict[str, Any]:
    return next(c for c in cards if c["type"] == type_)


async def test_qd1710_card_counts_new_silent_groups_until_boss_acknowledges(owner_api: Api, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    assert _card((await owner_api.get("/channels")).json())["new_groups_silent"] == 0
    await put(sessionmaker(), org, msg("a", group="g1"), msg("b", group="g1", sender="u2"), msg("c", group="g2"))
    await handle_group_discovered(db, redis, org, {"channel": "zalo", "group_id": "g3", "name": "Ba"})
    await db.commit()
    cards = (await owner_api.get("/channels")).json()
    assert _card(cards)["new_groups_silent"] == 3                                       # đếm theo nhóm, không theo tin
    assert _card(cards, "whatsapp")["new_groups_silent"] == 0                           # theo từng kênh
    # nhóm vào `ask`/`off` không tính vào thông báo
    await db.execute(text("""UPDATE core.organizations SET settings = settings
                             || '{"new_group_mode": {"zalo": "off"}}'::jsonb"""))
    await db.commit()
    await put(sessionmaker(), org, msg("d", group="g4"))
    assert _card((await owner_api.get("/channels")).json())["new_groups_silent"] == 3
    # «Đã biết»: không cần PIN, về 0; viewer không được
    r = await owner_api.send("POST", "/channels/zalo/groups/seen")
    assert r.status_code == 200 and r.json()["new_groups_silent"] == 0
    assert _card((await owner_api.get("/channels")).json())["new_groups_silent"] == 0
    assert (await owner_api.send("POST", "/channels/linkedin/groups/seen")).status_code == 404


# ─── agent trực: silent không bao giờ trả lời ─────────────────────────────────────────────────────────────────────

async def test_qd1710_silent_group_can_still_note_even_when_tagged(w, db, redis) -> None:  # type: ignore[no-untyped-def]
    a = await make_agent(db, w, level=6)
    await db.execute(text("UPDATE core.groups SET listen_mode = 'silent' WHERE id = :g"), {"g": w["g1"]})
    await db.commit()
    [u] = await refine(w, redis, msg(BUY, mentions=True))
    await hook(w, redis, decide("note"), [u])
    [d] = await decisions(db, a)
    assert (d.decision, d.outcome) == ("note", "noted") and await agent_drafts(db) == []


async def test_qd1710_prompt_says_never_reply_even_if_tagged_and_offers_only_silent_note(w, db, redis) -> None:  # type: ignore[no-untyped-def]
    await make_agent(db, w, level=6)
    await db.execute(text("UPDATE core.groups SET listen_mode = 'silent' WHERE id = :g"), {"g": w["g1"]})
    await db.commit()
    [u] = await refine(w, redis, msg(BUY, mentions=True))
    router = decide("silent", refs=())
    await hook(w, redis, router, [u])
    system, user = router.calls[0][0].content, router.calls[0][-1].content
    assert "Được chọn: silent, note." in system
    assert "không bao giờ soạn tin trả lời, kể cả khi được tag" in user
    assert "người gửi đang chờ bạn phản hồi" not in user                               # không giục trả lời nhóm im lặng
    assert "trừ khi được tag" not in user


async def test_qd1710_bot_assigned_to_a_member_does_not_make_the_silent_group_reply(w, db, redis) -> None:  # type: ignore[no-untyped-def]
    """B8: gán BOT cho một người chỉ áp cho tin 1-1 của họ; tin của họ trong nhóm im lặng vẫn không được trả lời."""
    from gh.biz.relations import service as rsvc

    lan = await make_agent(db, w, [], name="Trợ lý Lan", level=6)
    await db.execute(text("UPDATE core.groups SET listen_mode = 'silent' WHERE id = :g"), {"g": w["g1"]})
    await db.commit()
    [ug] = await refine(w, redis, msg(BUY, group="g1", sender="khachA", name="Khách A", mentions=True))
    pa = (await db.execute(text("""SELECT person_id FROM core.person_identities
                                  WHERE external_id = 'khachA'"""))).scalar_one()
    await rsvc.set_person_bot(db, pa, agent_id=lan, set_agent=True, autonomy_level=None, set_autonomy=False)
    await db.commit()
    await hook(w, redis, decide("draft"), [ug])
    assert await decisions(db) == [] and await agent_drafts(db) == []                   # tin nhóm không thuộc Lan
    # đã được gán BOT + nhóm do chính BOT đó phụ trách nhưng nhóm im lặng ⇒ vẫn không trả lời
    await db.execute(text("UPDATE core.groups SET assigned_agent_id = :a WHERE id = :g"), {"a": lan, "g": w["g1"]})
    await db.commit()
    await hook(w, redis, decide("draft"), [ug])
    [d] = await decisions(db, lan)
    assert (d.decision, d.requested, d.outcome) == ("silent", "draft", "blocked") and await agent_drafts(db) == []
    # tin 1-1 của người được gán BOT vẫn theo B8 (không đổi)
    [ud] = await refine(w, redis, msg(BUY, group=None, sender="khachA", name="Khách A"))
    await hook(w, redis, decide("draft"), [ud])
    assert len(await agent_drafts(db)) == 1


# ─── thẻ kênh: đổi tài khoản về mặc định mới ──────────────────────────────────────────────────────────────────────

async def test_qd1710_patch_ask_off_silent_roundtrip_and_default_on_card(owner_api: Api, db, redis) -> None:  # type: ignore[no-untyped-def]
    card = _card((await owner_api.get("/channels")).json())
    assert card["new_group_mode"] == "silent"                                           # mặc định mới trên thẻ kênh
    await verify_pin(owner_api)
    for mode in ("ask", "off", "silent"):
        r = await owner_api.send("PATCH", "/channels/zalo", {"new_group_mode": mode})
        assert r.status_code == 200 and r.json()["new_group_mode"] == mode
