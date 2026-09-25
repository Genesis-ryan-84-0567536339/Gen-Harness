"""Hợp nhất danh tính (spec G2, ARCHITECTURE §9): đề xuất có % + cơ sở, gộp/tách tay, lịch sử, đảo ngược.

Hệ thống không tự gộp. Gộp: mọi tài khoản kênh, thành viên nhóm, đơn vị ý nghĩa và sổ tay của hồ sơ bị gộp chuyển sang
hồ sơ giữ lại; hồ sơ bị gộp trỏ `merged_into_id` (không xoá). Nhật ký lưu đủ ID để đảo ngược chính xác.
"""

import uuid
from typing import Any

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.data.common import CHANNEL_NAME
from gh.errors import ApiError, conflict, not_found

HIGH, MID = 0.85, 0.65
MAX_NEW = 200


def level(conf: float) -> str:
    return "high" if conf >= HIGH else "mid" if conf >= MID else "low"


# ─── Đề xuất ────────────────────────────────────────────────────────────────

async def detect(db: AsyncSession, org_id: uuid.UUID) -> int:
    """Sinh đề xuất mới (không trùng cặp): trùng số điện thoại, tên gần giống, cùng nhóm."""
    rows = (await db.execute(text("""
        WITH ids AS (
          SELECT pi.id, pi.person_id, pi.phone_e164, lower(p.display_name) AS name, c.type AS ch
          FROM core.person_identities pi JOIN core.persons p ON p.id = pi.person_id
          JOIN core.channels c ON c.id = pi.channel_id
          WHERE p.org_id = :o AND p.merged_into_id IS NULL AND p.deleted_at IS NULL)
        SELECT a.id AS a, b.id AS b, a.phone_e164 IS NOT NULL AND a.phone_e164 = b.phone_e164 AS phone,
               similarity(a.name, b.name) AS sim, a.ch AS ch_a, b.ch AS ch_b,
               EXISTS (SELECT 1 FROM core.group_members ga JOIN core.group_members gb ON gb.group_id = ga.group_id
                       WHERE ga.person_id = a.person_id AND gb.person_id = b.person_id) AS cogroup
        FROM ids a JOIN ids b ON a.id < b.id AND a.person_id <> b.person_id
        WHERE (a.phone_e164 IS NOT NULL AND a.phone_e164 = b.phone_e164) OR similarity(a.name, b.name) >= 0.55
        ORDER BY 3 DESC, 4 DESC LIMIT 2000"""), {"o": org_id})).all()
    n = 0
    for r in rows:
        conf, parts = 0.0, []
        basis: dict[str, Any] = {}
        if r.phone:
            conf = 0.90
            basis["phone"] = True
            parts.append("trùng số điện thoại")
            if r.sim >= 0.5:
                conf += 0.06
                parts.append("tên gần giống")
        else:
            conf = 0.30 + 0.45 * float(r.sim)
            basis["name"] = round(float(r.sim), 2)
            parts.append("trùng cách viết tên" if r.sim >= 0.8 else "tên gần giống")
        if r.cogroup:
            conf += 0.08
            basis["co_group"] = True
            parts.append("cùng nhóm chat")
        if r.ch_a == r.ch_b and not r.phone:
            basis["same_channel"] = True
            parts.append(f"cùng kênh {CHANNEL_NAME.get(r.ch_a, r.ch_a)}")
        conf = round(min(0.99, conf), 3)
        text_basis = " và ".join(parts[:2]) + (", " + ", ".join(parts[2:]) if len(parts) > 2 else "")
        if not r.phone and r.sim < 0.8 and not r.cogroup:
            text_basis = "chỉ trùng tên, chưa có tín hiệu khác"
        res = await db.execute(text("""
            INSERT INTO core.identity_merge_candidates (org_id, identity_a, identity_b, confidence, basis, basis_text)
            VALUES (:o, :a, :b, :c, CAST(:bj AS jsonb), :bt) ON CONFLICT DO NOTHING"""),
            {"o": org_id, "a": r.a, "b": r.b, "c": conf, "bj": orjson.dumps(basis).decode(), "bt": text_basis})
        n += res.rowcount or 0  # type: ignore[attr-defined]
        if n >= MAX_NEW:
            break
    return n


def _side(r: Any, p: str) -> dict[str, Any]:
    ch = getattr(r, f"{p}_ch")
    meta = CHANNEL_NAME.get(ch, ch)
    phone = getattr(r, f"{p}_phone")
    handle = getattr(r, f"{p}_handle")
    if phone:
        meta += f" · {phone[:-6]} xxx {phone[-3:]}" if len(phone) > 8 else f" · {phone}"
    elif handle:
        meta += f" · {handle}"
    return {"identity_id": str(getattr(r, f"{p}_id")), "channel": ch, "meta": meta,
            "person": {"id": str(getattr(r, f"{p}_pid")), "code": getattr(r, f"{p}_pcode"),
                       "name": getattr(r, f"{p}_pname")}}


CANDIDATE_SQL = """
SELECT m.id, m.confidence, m.basis, m.basis_text, m.status, m.created_at,
       ia.id AS a_id, ca.type AS a_ch, ia.phone_e164 AS a_phone, ia.handle AS a_handle,
       pa.id AS a_pid, pa.code AS a_pcode, pa.display_name AS a_pname,
       ib.id AS b_id, cb.type AS b_ch, ib.phone_e164 AS b_phone, ib.handle AS b_handle,
       pb.id AS b_pid, pb.code AS b_pcode, pb.display_name AS b_pname
FROM core.identity_merge_candidates m
JOIN core.person_identities ia ON ia.id = m.identity_a JOIN core.channels ca ON ca.id = ia.channel_id
JOIN core.persons pa ON pa.id = ia.person_id
JOIN core.person_identities ib ON ib.id = m.identity_b JOIN core.channels cb ON cb.id = ib.channel_id
JOIN core.persons pb ON pb.id = ib.person_id
WHERE m.org_id = :o
"""


def candidate_payload(r: Any) -> dict[str, Any]:
    return {"id": str(r.id), "confidence": float(r.confidence), "level": level(float(r.confidence)),
            "basis": r.basis_text or "", "basis_detail": r.basis or {}, "status": r.status,
            "a": _side(r, "a"), "b": _side(r, "b")}


async def candidates(db: AsyncSession, org_id: uuid.UUID, status: str = "pending") -> list[dict[str, Any]]:
    rows = (await db.execute(text(CANDIDATE_SQL + """ AND m.status = :s
        AND (m.status <> 'pending' OR ia.person_id <> ib.person_id)
        ORDER BY m.confidence DESC, m.created_at LIMIT 200"""), {"o": org_id, "s": status})).all()
    return [candidate_payload(r) for r in rows]


async def stats(db: AsyncSession, org_id: uuid.UUID) -> dict[str, int]:
    r = (await db.execute(text("""
        SELECT
          (SELECT count(*) FROM core.persons p WHERE p.org_id = :o AND p.merged_into_id IS NULL AND p.deleted_at IS NULL
             AND NOT COALESCE((p.attrs->>'auto')::boolean, false)
             AND (SELECT count(*) FROM core.person_identities i WHERE i.person_id = p.id) >= 2) AS merged_people,
          (SELECT count(*) FROM core.persons p WHERE p.org_id = :o AND p.merged_into_id IS NULL AND p.deleted_at IS NULL
             AND NOT COALESCE((p.attrs->>'auto')::boolean, false)) AS live_profiles,
          (SELECT count(*) FROM core.identity_merge_candidates m
             JOIN core.person_identities a ON a.id = m.identity_a JOIN core.person_identities b ON b.id = m.identity_b
             WHERE m.org_id = :o AND m.status = 'pending' AND a.person_id <> b.person_id) AS pending_pairs,
          (SELECT count(*) FROM core.identity_merge_log l WHERE l.org_id = :o AND l.op = 'split'
             AND l.reverted_at IS NULL) AS manual_splits,
          (SELECT count(*) FROM core.person_identities i JOIN core.persons p ON p.id = i.person_id
             WHERE p.org_id = :o AND p.merged_into_id IS NULL
               AND COALESCE((p.attrs->>'auto')::boolean, false)) AS unlinked_accounts"""), {"o": org_id})).one()
    return dict(r._mapping)


# ─── Gộp / tách / đảo ngược ────────────────────────────────────────────────

async def _move(db: AsyncSession, src: uuid.UUID, dst: uuid.UUID, identity_ids: list[uuid.UUID] | None,
                unit_ids: list[uuid.UUID] | None = None) -> dict[str, Any]:
    """Chuyển tài khoản kênh (tất cả hoặc danh sách), đơn vị ý nghĩa, thành viên nhóm, sổ tay từ src sang dst."""
    if identity_ids is None:
        identity_ids = list((await db.execute(text("SELECT id FROM core.person_identities WHERE person_id = :p"),
                                              {"p": src})).scalars().all())
    await db.execute(text("UPDATE core.person_identities SET person_id = :d WHERE id = ANY(:ids)"),
                     {"d": dst, "ids": identity_ids})
    if unit_ids is None:
        unit_ids = list((await db.execute(text("SELECT id FROM clean.meaning_units WHERE person_id = :p"),
                                          {"p": src})).scalars().all())
    await db.execute(text("UPDATE clean.meaning_units SET person_id = :d WHERE id = ANY(:ids)"),
                     {"d": dst, "ids": unit_ids})
    groups = list((await db.execute(text("""
        INSERT INTO core.group_members (group_id, person_id, role, joined_at)
        SELECT group_id, :d, role, joined_at FROM core.group_members WHERE person_id = :s
        ON CONFLICT DO NOTHING RETURNING group_id"""), {"s": src, "d": dst})).scalars().all())
    # Sổ tay: chuyển mục sang sổ của hồ sơ đích (tạo nếu chưa có).
    nb_src = (await db.execute(text("""SELECT id, org_id FROM memory.notebooks
                                       WHERE subject_type = 'person' AND subject_id = :s"""), {"s": src})).one_or_none()
    entry_ids: list[uuid.UUID] = []
    if nb_src is not None:
        from gh.memory import notebook

        nb_dst = await notebook.ensure(db, nb_src.org_id, "person", dst)
        entry_ids = list((await db.execute(text("""UPDATE memory.entries SET notebook_id = :d WHERE notebook_id = :s
                                                   RETURNING id"""), {"d": nb_dst.id, "s": nb_src.id})).scalars().all())
        await notebook.recount(db, nb_src.id)
        await notebook.recount(db, nb_dst.id)
    return {"identities": [str(i) for i in identity_ids], "units": [str(u) for u in unit_ids],
            "groups_added": [str(g) for g in groups], "entries": [str(e) for e in entry_ids]}


async def merge(db: AsyncSession, org_id: uuid.UUID, candidate_id: uuid.UUID, actor: uuid.UUID) -> dict[str, Any]:
    c = (await db.execute(text(CANDIDATE_SQL + " AND m.id = :i FOR UPDATE OF m"),
                          {"o": org_id, "i": candidate_id})).one_or_none()
    if c is None:
        raise not_found("Cặp đề xuất")
    if c.status != "pending":
        raise conflict("CANDIDATE_DECIDED", "Cặp này đã được xử lý")
    if c.a_pid == c.b_pid:
        raise conflict("ALREADY_MERGED", "Hai tài khoản đã thuộc cùng một người")
    keep, drop = await _pick_keep(db, c.a_pid, c.b_pid)
    moved = await _move(db, drop, keep, None)
    await db.execute(text("""UPDATE core.persons SET merged_into_id = :k,
                             attrs = attrs || '{"auto": false}' WHERE id = :d"""), {"k": keep, "d": drop})
    await db.execute(text("""UPDATE core.persons SET attrs = attrs || '{"auto": false}' WHERE id = :k"""), {"k": keep})
    await db.execute(text("""UPDATE core.identity_merge_candidates SET status = 'merged', decided_by = :u,
                             decided_at = now() WHERE id = :i"""), {"u": actor, "i": candidate_id})
    log_id = (await db.execute(text("""
        INSERT INTO core.identity_merge_log (org_id, op, from_person, to_person, identities, actor_user, candidate_id,
                                             snapshot)
        VALUES (:o, 'merge', :f, :t, :ids, :u, :c, CAST(:s AS jsonb)) RETURNING id"""),
        {"o": org_id, "f": drop, "t": keep, "ids": [uuid.UUID(i) for i in moved["identities"]], "u": actor,
         "c": candidate_id, "s": orjson.dumps(moved).decode()})).scalar_one()
    return {"person": await person_ref(db, keep), "merged": await person_ref(db, drop), "log_id": str(log_id)}


async def _pick_keep(db: AsyncSession, a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    """Giữ hồ sơ do người xác nhận (không tự tạo) hoặc có nhiều dữ liệu hơn; hoà thì giữ hồ sơ cũ hơn."""
    rows = {r.id: r for r in (await db.execute(text("""
        SELECT p.id, COALESCE((p.attrs->>'auto')::boolean, false) AS auto, p.created_at,
               (SELECT count(*) FROM clean.meaning_units m WHERE m.person_id = p.id) AS units
        FROM core.persons p WHERE p.id IN (:a, :b)"""), {"a": a, "b": b})).all()}
    ra, rb = rows[a], rows[b]
    key_a = (not ra.auto, ra.units, -ra.created_at.timestamp())
    key_b = (not rb.auto, rb.units, -rb.created_at.timestamp())
    return (a, b) if key_a >= key_b else (b, a)


async def split(db: AsyncSession, org_id: uuid.UUID, person_id: uuid.UUID, identity_ids: list[uuid.UUID],
                actor: uuid.UUID) -> dict[str, Any]:
    p = (await db.execute(text("""SELECT id, display_name FROM core.persons WHERE id = :p AND org_id = :o
                                  AND merged_into_id IS NULL AND deleted_at IS NULL FOR UPDATE"""),
                          {"p": person_id, "o": org_id})).one_or_none()
    if p is None:
        raise not_found("Hồ sơ")
    owned = set((await db.execute(text("SELECT id FROM core.person_identities WHERE person_id = :p"),
                                  {"p": person_id})).scalars().all())
    ids = list(dict.fromkeys(identity_ids))
    if not ids or not set(ids) <= owned:
        raise ApiError(422, "VALIDATION", "Dữ liệu chưa hợp lệ", errors={"identity_ids": "Tài khoản không thuộc hồ sơ"})
    if set(ids) == owned:
        raise ApiError(422, "VALIDATION", "Dữ liệu chưa hợp lệ",
                       errors={"identity_ids": "Phải giữ lại ít nhất một tài khoản ở hồ sơ gốc"})
    handle = (await db.execute(text("SELECT handle FROM core.person_identities WHERE id = :i"),
                               {"i": ids[0]})).scalar_one()
    code = (await db.execute(text("SELECT core.next_code('PER')"))).scalar_one()
    new_id = (await db.execute(text("""INSERT INTO core.persons (org_id, code, display_name, attrs)
                                       VALUES (:o, :c, :n, '{"auto": false, "split_from": true}') RETURNING id"""),
                               {"o": org_id, "c": code, "n": handle or f"{p.display_name} (tách)"})).scalar_one()
    # Đơn vị ý nghĩa đi theo tài khoản đã nói ra chúng (qua chứng cứ).
    unit_ids = list((await db.execute(text("""
        SELECT DISTINCT m.id FROM clean.meaning_units m JOIN clean.evidence x ON x.meaning_unit_id = m.id
        JOIN raw.events e ON e.id = x.raw_event_id AND e.received_at = x.raw_received_at
        WHERE m.person_id = :p AND e.sender_identity_id = ANY(:ids)"""), {"p": person_id, "ids": ids})).scalars().all())
    await db.execute(text("UPDATE core.person_identities SET person_id = :d WHERE id = ANY(:ids)"),
                     {"d": new_id, "ids": ids})
    await db.execute(text("UPDATE clean.meaning_units SET person_id = :d WHERE id = ANY(:ids)"),
                     {"d": new_id, "ids": unit_ids})
    snapshot = {"identities": [str(i) for i in ids], "units": [str(u) for u in unit_ids]}
    log_id = (await db.execute(text("""
        INSERT INTO core.identity_merge_log (org_id, op, from_person, to_person, identities, actor_user, snapshot)
        VALUES (:o, 'split', :f, :t, :ids, :u, CAST(:s AS jsonb)) RETURNING id"""),
        {"o": org_id, "f": person_id, "t": new_id, "ids": ids, "u": actor,
         "s": orjson.dumps(snapshot).decode()})).scalar_one()
    return {"person": await person_ref(db, new_id), "from": await person_ref(db, person_id), "log_id": str(log_id)}


async def revert(db: AsyncSession, org_id: uuid.UUID, log_id: uuid.UUID, actor: uuid.UUID) -> dict[str, Any]:
    lg = (await db.execute(text("""SELECT id, op, from_person, to_person, snapshot, reverted_at, at, candidate_id
                                   FROM core.identity_merge_log WHERE id = :i AND org_id = :o FOR UPDATE"""),
                           {"i": log_id, "o": org_id})).one_or_none()
    if lg is None:
        raise not_found("Thao tác")
    if lg.reverted_at is not None:
        raise conflict("ALREADY_REVERTED", "Thao tác này đã được đảo ngược")
    later = (await db.execute(text("""
        SELECT 1 FROM core.identity_merge_log WHERE org_id = :o AND reverted_at IS NULL AND at > :t AND id <> :i
          AND (from_person IN (:f, :to) OR to_person IN (:f, :to)) LIMIT 1"""),
        {"o": org_id, "t": lg.at, "i": lg.id, "f": lg.from_person, "to": lg.to_person})).scalar()
    if later:
        raise conflict("REVERT_ORDER", "Có thao tác gộp/tách mới hơn trên hồ sơ này — hãy đảo ngược thao tác mới trước")
    snap = lg.snapshot or {}
    ids = [uuid.UUID(i) for i in snap.get("identities", [])]
    units = [uuid.UUID(u) for u in snap.get("units", [])]
    if lg.op == "merge":
        # to_person đang giữ mọi thứ; trả phần của from_person về.
        await db.execute(text("UPDATE core.persons SET merged_into_id = NULL WHERE id = :f"), {"f": lg.from_person})
        await db.execute(text("UPDATE core.person_identities SET person_id = :f WHERE id = ANY(:ids)"),
                         {"f": lg.from_person, "ids": ids})
        await db.execute(text("UPDATE clean.meaning_units SET person_id = :f WHERE id = ANY(:ids)"),
                         {"f": lg.from_person, "ids": units})
        added = [uuid.UUID(g) for g in snap.get("groups_added", [])]
        if added:
            await db.execute(text("DELETE FROM core.group_members WHERE person_id = :t AND group_id = ANY(:g)"),
                             {"t": lg.to_person, "g": added})
        entries = [uuid.UUID(e) for e in snap.get("entries", [])]
        if entries:
            nb = (await db.execute(text("""SELECT id FROM memory.notebooks WHERE subject_type = 'person'
                                           AND subject_id = :f"""), {"f": lg.from_person})).scalar_one_or_none()
            if nb is not None:
                await db.execute(text("UPDATE memory.entries SET notebook_id = :n WHERE id = ANY(:ids)"),
                                 {"n": nb, "ids": entries})
        if lg.candidate_id:
            await db.execute(text("""UPDATE core.identity_merge_candidates SET status = 'pending', decided_by = NULL,
                                     decided_at = NULL WHERE id = :c"""), {"c": lg.candidate_id})
        restored = lg.from_person
    else:
        # Tách: trả tài khoản + đơn vị về hồ sơ gốc; hồ sơ tách ra trỏ về gốc.
        await db.execute(text("UPDATE core.person_identities SET person_id = :f WHERE id = ANY(:ids)"),
                         {"f": lg.from_person, "ids": ids})
        await db.execute(text("UPDATE clean.meaning_units SET person_id = :f WHERE id = ANY(:ids)"),
                         {"f": lg.from_person, "ids": units})
        await db.execute(text("UPDATE core.persons SET merged_into_id = :f WHERE id = :t"),
                         {"f": lg.from_person, "t": lg.to_person})
        restored = lg.from_person
    await db.execute(text("UPDATE core.identity_merge_log SET reverted_at = now(), reverted_by = :u WHERE id = :i"),
                     {"u": actor, "i": lg.id})
    return {"person": await person_ref(db, restored), "log_id": str(lg.id), "op": lg.op}


async def history(db: AsyncSession, org_id: uuid.UUID, limit: int = 50) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""
        SELECT l.id, l.op, l.at, l.identities, l.reverted_at, u.display_name AS actor,
               pf.id AS f_id, pf.code AS f_code, pf.display_name AS f_name,
               pt.id AS t_id, pt.code AS t_code, pt.display_name AS t_name
        FROM core.identity_merge_log l
        JOIN core.persons pf ON pf.id = l.from_person JOIN core.persons pt ON pt.id = l.to_person
        LEFT JOIN core.users u ON u.id = l.actor_user
        WHERE l.org_id = :o ORDER BY l.at DESC LIMIT :n"""), {"o": org_id, "n": limit})).all()
    return [{"id": str(r.id), "op": r.op, "at": r.at.isoformat().replace("+00:00", "Z"), "actor": r.actor,
             "from": {"id": str(r.f_id), "code": r.f_code, "name": r.f_name},
             "to": {"id": str(r.t_id), "code": r.t_code, "name": r.t_name},
             "identities": len(r.identities or []), "reverted": r.reverted_at is not None} for r in rows]


async def person_ref(db: AsyncSession, person_id: uuid.UUID) -> dict[str, Any]:
    r = (await db.execute(text("SELECT id, code, display_name FROM core.persons WHERE id = :i"),
                          {"i": person_id})).one()
    return {"id": str(r.id), "code": r.code, "name": r.display_name}


async def evidence(db: AsyncSession, org_id: uuid.UUID, candidate_id: uuid.UUID) -> list[dict[str, Any]]:
    """Chứng cứ của một cặp: tin gần nhất của mỗi tài khoản (ai nói gì, ở đâu) để Sếp tự so."""
    from gh.data.common import RAW_SELECT, raw_item

    c = (await db.execute(text("""SELECT identity_a, identity_b, basis_text FROM core.identity_merge_candidates
                                  WHERE id = :i AND org_id = :o"""), {"i": candidate_id, "o": org_id})).one_or_none()
    if c is None:
        raise not_found("Cặp đề xuất")
    out: list[dict[str, Any]] = []
    for ident, note in ((c.identity_a, "Tài khoản A"), (c.identity_b, "Tài khoản B")):
        rows = (await db.execute(text(RAW_SELECT + """ WHERE e.sender_identity_id = :i
                                                     ORDER BY e.received_at DESC LIMIT 3"""), {"i": ident})).all()
        out.extend({"raw": raw_item(r), "note": note} for r in rows)
    return out
