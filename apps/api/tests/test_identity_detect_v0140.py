"""v0.1.40 (F-16): dò trùng danh tính — cặp đã có bị loại TRƯỚC LIMIT (≥2000 cặp cũ vẫn ra đề xuất mới), mốc tiến độ
`ops.job_watermarks` (chỉ tiến khi lượt không bị cắt), tên gần giống dùng toán tử `%` + chỉ mục trigram."""

import uuid
from typing import Any

from sqlalchemy import text

from gh.data.ingest import handle_directory
from gh.identity import service as identity
from tests.phase2 import org_id


async def _channel(db: Any, redis: Any, org: uuid.UUID) -> uuid.UUID:
    await handle_directory(db, redis, org, {"channel": "zalo", "groups": [{"external_id": "gz", "name": "Sỉ",
                                                                            "members": []}]})
    return (await db.execute(text("SELECT id FROM core.channels WHERE org_id = :o AND type = 'zalo'"),
                             {"o": org})).scalar_one()  # type: ignore[no-any-return]


async def _pairs(db: Any, org: uuid.UUID, ch: uuid.UUID, prefix: str, start: int, n_pairs: int) -> None:
    """`n_pairs` cặp hồ sơ khác nhau cùng SĐT; tên ngẫu nhiên (md5) để không thành cặp tên gần giống."""
    await db.execute(text("""
        WITH p AS (
          INSERT INTO core.persons (org_id, code, display_name)
          SELECT :o, :pre || g, md5(:pre || g) FROM generate_series(:s, :s + 2 * :n - 1) g
          RETURNING id, code)
        INSERT INTO core.person_identities (person_id, channel_id, external_id, phone_e164)
        SELECT id, :c, 'x-' || code,
               '+849' || lpad(((substr(code, length(:pre) + 1)::int + 1) / 2)::text, 8, '0') FROM p"""),
        {"o": org, "c": ch, "pre": prefix, "s": start, "n": n_pairs})


async def _pending(db: Any, org: uuid.UUID) -> int:
    return (await db.execute(text("SELECT count(*) FROM core.identity_merge_candidates WHERE org_id = :o"),
                             {"o": org})).scalar_one()  # type: ignore[no-any-return]


async def _wm(db: Any, org: uuid.UUID) -> Any:
    return (await db.execute(text("""SELECT last_id, last_at FROM ops.job_watermarks
                                      WHERE org_id = :o AND job = 'identity.detect'"""), {"o": org})).one_or_none()


async def test_existing_2000_pairs_do_not_block_new(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    ch = await _channel(db, redis, org)
    await _pairs(db, org, ch, "OLD-", 1, 2001)
    await db.execute(text("""
        INSERT INTO core.identity_merge_candidates (org_id, identity_a, identity_b, confidence, basis, basis_text)
        SELECT :o, (array_agg(pi.id ORDER BY pi.id))[1], (array_agg(pi.id ORDER BY pi.id))[2], 0.9, '{}', 'cũ'
        FROM core.person_identities pi WHERE pi.channel_id = :c GROUP BY pi.phone_e164"""), {"o": org, "c": ch})
    await _pairs(db, org, ch, "NEW-", 5001, 1)
    await db.commit()
    assert await _pending(db, org) == 2001

    assert await identity.detect(db, org) == 1
    await db.commit()
    new_ids = (await db.execute(text("""SELECT pi.id FROM core.person_identities pi JOIN core.persons p
                                        ON p.id = pi.person_id WHERE p.code LIKE 'NEW-%' ORDER BY pi.id"""))
               ).scalars().all()
    row = (await db.execute(text("""SELECT identity_a, identity_b, basis_text FROM core.identity_merge_candidates
                                    WHERE identity_a = ANY(:ids) OR identity_b = ANY(:ids)"""),
                            {"ids": list(new_ids)})).one()
    assert [row.identity_a, row.identity_b] == list(new_ids)          # cặp chuẩn hoá LEAST/GREATEST
    assert "số điện thoại" in row.basis_text
    assert await identity.detect(db, org) == 0                        # chạy lại: không trùng
    await db.commit()
    assert await _pending(db, org) == 2002


async def test_watermark_advances_only_when_not_truncated(app, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    ch = await _channel(db, redis, org)
    await _pairs(db, org, ch, "A-", 1, 5)
    await db.commit()
    monkeypatch.setattr(identity, "MAX_NEW", 3)
    assert await identity.detect(db, org) == 3
    await db.commit()
    assert await _wm(db, org) is None                                  # bị cắt bởi MAX_NEW ⇒ mốc giữ nguyên
    assert await identity.detect(db, org) == 2                         # lượt sau làm tiếp phần còn lại
    await db.commit()
    wm = await _wm(db, org)
    assert wm is not None and wm.last_at is not None
    max_id = (await db.execute(text("""SELECT pi.id FROM core.person_identities pi WHERE pi.channel_id = :c
                                       ORDER BY pi.id DESC LIMIT 1"""), {"c": ch})).scalar_one()
    assert wm.last_id == max_id

    # Đã có mốc, thêm cặp mới ⇒ lượt (không bị cắt) tiến mốc tới định danh mới nhất.
    await _pairs(db, org, ch, "B-", 101, 1)
    await db.commit()
    assert await identity.detect(db, org) == 1
    await db.commit()
    wm2 = await _wm(db, org)
    assert wm2.last_id > wm.last_id


async def test_renamed_profile_detected_after_watermark(app, db, redis) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    ch = await _channel(db, redis, org)
    ids = {}
    for code, name in (("R-1", "Nguyễn Văn Hùng"), ("R-2", "Trần Thị Mai")):
        pid = (await db.execute(text("""INSERT INTO core.persons (org_id, code, display_name) VALUES (:o, :c, :n)
                                        RETURNING id"""), {"o": org, "c": code, "n": name})).scalar_one()
        await db.execute(text("""INSERT INTO core.person_identities (person_id, channel_id, external_id)
                                 VALUES (:p, :c, :x)"""), {"p": pid, "c": ch, "x": code})
        ids[code] = pid
    await db.commit()
    assert await identity.detect(db, org) == 0
    await db.commit()
    # Giả lập thời gian trôi: mốc mới hơn mọi hồ sơ hiện có ⇒ lượt sau không còn gì "mới".
    await db.execute(text("""UPDATE ops.job_watermarks SET last_at = clock_timestamp()
                             WHERE org_id = :o AND job = 'identity.detect'"""), {"o": org})
    await db.commit()
    assert await identity.detect(db, org) == 0
    await db.commit()
    # Đổi tên hồ sơ cũ (updated_at mới hơn mốc) ⇒ cặp tên gần giống được phát hiện dù định danh không mới.
    await db.execute(text("UPDATE core.persons SET display_name = 'Nguyễn Văn Hùng' WHERE id = :p"),
                     {"p": ids["R-2"]})
    await db.commit()
    assert await identity.detect(db, org) == 1
    await db.commit()
    basis = (await db.execute(text("SELECT basis FROM core.identity_merge_candidates WHERE org_id = :o"),
                              {"o": org})).scalar_one()
    assert basis.get("name", 0) >= 0.55


async def test_name_query_uses_trigram_operator_and_index(app, db) -> None:  # type: ignore[no-untyped-def]
    assert "pb.display_name % f.name" in identity.DETECT_SQL
    assert "NOT EXISTS (SELECT 1 FROM core.identity_merge_candidates m" in identity.DETECT_SQL
    await db.execute(text("SET LOCAL enable_seqscan = off"))
    await db.execute(text("SET LOCAL pg_trgm.similarity_threshold = 0.55"))
    plan = "\n".join((await db.execute(text(
        "EXPLAIN SELECT 1 FROM core.persons pb WHERE pb.display_name % 'nguyễn văn hùng'"))).scalars().all())
    # Chỉ mục trigram dùng được kể cả dưới RLS của gh_app (similarity_op LEAKPROOF — migration 0026).
    assert "persons_display_name_idx" in plan and "Index Cond" in plan
    leak = (await db.execute(text(
        "SELECT proleakproof FROM pg_proc WHERE oid = 'similarity_op(text,text)'::regprocedure"))).scalar_one()
    assert leak is True
    # SET LOCAL không rò ra ngoài transaction
    await db.rollback()
    left = (await db.execute(text("SELECT current_setting('pg_trgm.similarity_threshold', true)"))).scalar_one()
    assert left in (None, "", "0.3")
