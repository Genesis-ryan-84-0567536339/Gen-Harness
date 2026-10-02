"""v0.1.40 (F-2): hạn lưu dữ liệu THẬT — nguồn sự thật duy nhất cho mọi việc dọn dữ liệu quá hạn.

Ba kiểu dọn:
- `partition` — bảng phân vùng theo tháng (raw.events, clean.meaning_units, agent.model_calls): chỉ xoá theo CẢ phân
  vùng tháng qua pg_partman (`partman.part_config.retention` + `retention_keep_table = false`; mặc định partman chỉ
  TÁCH bảng con chứ không xoá). raw.events và ops.action_log có trigger `core.forbid_mutation` chặn UPDATE/DELETE
  theo dòng ⇒ tuyệt đối không DELETE theo dòng ở đây. Hạn hiệu lực = MAX(keep_days) qua mọi tổ chức; tổ chức nào
  chưa đặt (NULL) ⇒ giữ mãi (retention NULL) — một máy cài, các tổ chức dùng chung bảng phân vùng.
- `batch` — xoá/làm rỗng theo lô (5000 dòng/lô, commit mỗi lô, dừng khi lô < 5000 hoặc hết ngân sách thời gian):
  memory.entries (chỉ mục ĐÃ NÉN quá hạn, không ghim), agent.browser_jobs.result (cố định 14 ngày — giữ dòng việc,
  bỏ nội dung đã đọc), raw.attachments của sự kiện đã bị partman xoá (xoá dòng + object, best-effort).
- `not_applicable` — ops.action_log: nhật ký chống sửa (chuỗi băm) được giữ nguyên.

`retention_sweep` (cron 05:00 giờ VN) gọi lần lượt mọi phần — mỗi phần try/except riêng — gồm cả hội thoại Gen
(`gen_store.purge_expired`) và chuông (`notifications.purge_old`); phiên đăng nhập vẫn dọn mỗi giờ (`purge_sessions`).
Kết quả ghi Redis `gh:retention:last` = {"at", "datasets": {tên: {"mode", "deleted", "ok"}}} (TTL 14 ngày) —
GET /system/retention-policies đọc để hiện "lần dọn gần nhất".
"""

import logging
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger("gh.retention")

#: Tập dữ liệu Owner đặt được hạn lưu (`ops.retention_policies`) — thứ tự giữ như danh sách cũ của API.
DATASETS: dict[str, dict[str, Any]] = {
    "raw.events": {"mode": "partition", "column": "received_at", "editable": True},
    "clean.meaning_units": {"mode": "partition", "column": "observed_at", "editable": True},
    "ops.action_log": {"mode": "not_applicable", "editable": False},
    "memory.entries": {"mode": "batch", "editable": True},
    "agent.model_calls": {"mode": "partition", "column": "at", "editable": True},
}
PARTITIONED = tuple(d for d, v in DATASETS.items() if v["mode"] == "partition")

#: Mục cố định (không sửa được): nội dung đã đọc của việc trình duyệt giữ 14 ngày.
BROWSER_RESULT = "agent.browser_jobs.result"
BROWSER_RESULT_DAYS = 14
FIXED: dict[str, dict[str, Any]] = {BROWSER_RESULT: {"mode": "batch", "keep_days": BROWSER_RESULT_DAYS,
                                                     "editable": False}}

NOTES = {
    "partition": "Xoá theo tháng: cả tháng quá hạn mới bị xoá",
    "memory.entries": "Chỉ xoá mục sổ tay đã nén; mục ghim giữ mãi",
    "ops.action_log": "Không áp dụng — nhật ký chống sửa được giữ nguyên",
    BROWSER_RESULT: "Nội dung đã đọc của việc trình duyệt giữ 14 ngày; dòng việc vẫn giữ",
}
NOT_APPLICABLE_ERROR = "Nhật ký hành động chưa áp dụng hạn lưu (chuỗi chống sửa)"

BATCH = 5000
TIME_BUDGET_S = 600.0
LAST_KEY = "gh:retention:last"
LAST_TTL = 14 * 86400


def note_for(dataset: str) -> str:
    if dataset in NOTES:
        return NOTES[dataset]
    mode = (DATASETS.get(dataset) or FIXED.get(dataset) or {}).get("mode", "")
    return NOTES.get(mode, "")


def _utc_iso() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


# ─── partman ───────────────────────────────────────────────────────────────────────────────────────────────

async def effective_keep_days(db: AsyncSession, dataset: str) -> int | None:
    """MAX(keep_days) qua mọi tổ chức; có tổ chức chưa đặt (NULL/thiếu dòng) hoặc chưa có tổ chức ⇒ None (giữ mãi)."""
    r = (await db.execute(text("""
        SELECT count(*) AS orgs, count(rp.keep_days) AS set_, max(rp.keep_days) AS keep
        FROM core.organizations o
        LEFT JOIN ops.retention_policies rp ON rp.org_id = o.id AND rp.dataset = :d"""), {"d": dataset})).one()
    if not r.orgs or r.set_ < r.orgs or r.keep is None:
        return None
    return int(r.keep)


async def sync_partman(admin_db: AsyncSession) -> dict[str, int | None]:
    """Đặt `partman.part_config.retention` cho 3 bảng phân vùng theo hạn hiệu lực. PHẢI chạy qua
    `admin_sessionmaker` (role gh_app không có quyền schema partman). Bên gọi commit."""
    out: dict[str, int | None] = {}
    for ds in PARTITIONED:
        keep = await effective_keep_days(admin_db, ds)
        await admin_db.execute(text("""
            UPDATE partman.part_config
            SET retention = CASE WHEN CAST(:k AS int) IS NULL THEN NULL ELSE CAST(:k AS int)::text || ' days' END,
                retention_keep_table = false
            WHERE parent_table = :t"""), {"k": keep, "t": ds})
        out[ds] = keep
    return out


async def _partition_count(admin_db: AsyncSession, parent: str) -> int:
    return int((await admin_db.execute(text("SELECT count(*) FROM partman.show_partitions(:t)"),
                                       {"t": parent})).scalar_one())


async def drop_expired_partitions(admin_db: AsyncSession, keeps: dict[str, int | None]) -> dict[str, int]:
    """Chạy bảo trì partman cho từng bảng có hạn lưu ⇒ phân vùng tháng quá hạn bị XOÁ. Trả số phân vùng đã xoá."""
    out: dict[str, int] = {}
    for ds in PARTITIONED:
        if keeps.get(ds) is None:
            out[ds] = 0
            continue
        before = await _partition_count(admin_db, ds)
        await admin_db.execute(text("SELECT partman.run_maintenance(p_parent_table => :t)"), {"t": ds})
        await admin_db.commit()
        out[ds] = max(0, before - await _partition_count(admin_db, ds))
    return out


# ─── xoá theo lô ───────────────────────────────────────────────────────────────────────────────────────────

async def _batched(db: AsyncSession, sql: str, params: dict[str, Any], deadline: float) -> int:
    """Lặp một câu xoá/làm rỗng `LIMIT :lim` — commit mỗi lô, dừng khi lô < BATCH hoặc hết ngân sách thời gian."""
    total = 0
    while True:
        n = int((await db.execute(text(sql), {**params, "lim": BATCH})).rowcount or 0)  # type: ignore[attr-defined]
        await db.commit()
        total += n
        if n < BATCH or time.monotonic() >= deadline:
            return total


async def purge_memory_entries(db: AsyncSession, deadline: float) -> int:
    """Mục sổ tay ĐÃ NÉN (archived_at) quá `keep_days` của tổ chức sở hữu sổ — không bao giờ xoá mục ghim."""
    return await _batched(db, """
        DELETE FROM memory.entries WHERE id IN (
          SELECT e.id FROM memory.entries e
          JOIN memory.notebooks n ON n.id = e.notebook_id
          JOIN ops.retention_policies rp ON rp.org_id = n.org_id AND rp.dataset = 'memory.entries'
          WHERE rp.keep_days IS NOT NULL AND e.archived_at IS NOT NULL AND NOT e.is_pinned
            AND e.archived_at < now() - make_interval(days => rp.keep_days)
          LIMIT :lim)""", {}, deadline)


async def purge_browser_results(db: AsyncSession, deadline: float) -> int:
    """Bỏ nội dung đã đọc (`result`) của việc trình duyệt xong quá 14 ngày — giữ dòng việc (trạng thái/chi phí)."""
    return await _batched(db, """
        UPDATE agent.browser_jobs SET result = NULL WHERE id IN (
          SELECT id FROM agent.browser_jobs
          WHERE result IS NOT NULL AND finished_at < now() - make_interval(days => :d)
          LIMIT :lim)""", {"d": BROWSER_RESULT_DAYS}, deadline)


async def purge_orphan_attachments(db: AsyncSession, keep_days: int | None, deadline: float,
                                   store: Any = None) -> int:
    """Tệp đính kèm có sự kiện thô đã bị partman xoá theo tháng (cũ hơn hạn, sự kiện không còn) ⇒ xoá dòng + object
    (object best-effort: lỗi chỉ log, dòng vẫn xoá để không quét lại mãi)."""
    if keep_days is None:
        return 0
    if store is None:
        from gh.chassis.objects import get_object_store

        store = get_object_store()
    total, failed = 0, 0
    while True:
        rows = (await db.execute(text("""
            DELETE FROM raw.attachments WHERE id IN (
              SELECT a.id FROM raw.attachments a
              WHERE a.event_received_at < now() - make_interval(days => :k)
                AND NOT EXISTS (SELECT 1 FROM raw.events e
                                WHERE e.id = a.event_id AND e.received_at = a.event_received_at)
              LIMIT :lim)
            RETURNING storage_key"""), {"k": keep_days, "lim": BATCH})).scalars().all()
        await db.commit()
        for key in rows:
            try:
                await store.delete(key)
            except Exception:  # noqa: BLE001 — best-effort
                failed += 1
        total += len(rows)
        if len(rows) < BATCH or time.monotonic() >= deadline:
            break
    if total:
        log.info("Dọn tệp đính kèm quá hạn: %d dòng (%d object không xoá được)", total, failed)
    return total


async def purge_sessions(db: AsyncSession) -> int:
    """Phiên đăng nhập hết hạn/thu hồi quá `GH_SESSION_PURGE_AFTER_DAYS` (job hằng giờ `expire_sessions`). Bên gọi
    commit."""
    from gh.auth import service as auth_service
    from gh.config import get_settings

    return await auth_service.purge_expired_sessions(db, older_than_days=get_settings().session_purge_after_days)


async def purge_gen(db: AsyncSession) -> int:
    from gh.gen import store as gen_store

    n = await gen_store.purge_expired(db)
    await db.commit()
    return n


async def purge_notifications(db: AsyncSession) -> int:
    from gh import notifications

    return await notifications.purge_old(db, commit_each=True)


# ─── lượt dọn hằng ngày ────────────────────────────────────────────────────────────────────────────────────

async def read_last(redis: Any) -> dict[str, Any] | None:
    if redis is None:
        return None
    try:
        raw = await redis.get(LAST_KEY)
        data = orjson.loads(raw) if raw else None
    except Exception as exc:  # noqa: BLE001 — chỉ là thông tin hiển thị
        log.warning("Không đọc được %s: %s", LAST_KEY, exc)
        return None
    return data if isinstance(data, dict) else None


async def retention_sweep(ctx: dict[str, Any]) -> dict[str, Any]:
    """Cron 05:00 giờ VN: sync partman → xoá phân vùng quá hạn → các lô → hội thoại Gen → chuông. Mỗi phần chạy
    trong session riêng, lỗi một phần chỉ log và không chặn phần khác."""
    from gh.db import admin_sessionmaker, sessionmaker

    deadline = time.monotonic() + TIME_BUDGET_S
    datasets: dict[str, dict[str, Any]] = {"ops.action_log": {"mode": "not_applicable", "deleted": 0, "ok": True}}

    async def part(name: str, mode: str, fn: Callable[[], Awaitable[int]]) -> None:
        try:
            datasets[name] = {"mode": mode, "deleted": int(await fn()), "ok": True}
        except Exception:  # noqa: BLE001 — một phần lỗi không chặn phần khác
            log.exception("Dọn dữ liệu quá hạn lỗi ở phần %s", name)
            datasets[name] = {"mode": mode, "deleted": 0, "ok": False}

    keeps: dict[str, int | None] = {}
    dropped: dict[str, int] = {}

    async def do_partman() -> int:
        async with admin_sessionmaker()() as adb:
            keeps.update(await sync_partman(adb))
            await adb.commit()
            dropped.update(await drop_expired_partitions(adb, keeps))
        return sum(dropped.values())

    try:
        await do_partman()
        for ds in PARTITIONED:
            datasets[ds] = {"mode": "partition", "deleted": dropped.get(ds, 0), "ok": True}
    except Exception:  # noqa: BLE001
        log.exception("Dọn dữ liệu quá hạn lỗi ở phần partman")
        for ds in PARTITIONED:
            datasets[ds] = {"mode": "partition", "deleted": dropped.get(ds, 0), "ok": False}

    sm = sessionmaker()

    def in_session(fn: Callable[[AsyncSession], Awaitable[int]]) -> Callable[[], Awaitable[int]]:
        async def run() -> int:
            async with sm() as db:
                return await fn(db)
        return run

    await part("memory.entries", "batch", in_session(lambda db: purge_memory_entries(db, deadline)))
    await part(BROWSER_RESULT, "batch", in_session(lambda db: purge_browser_results(db, deadline)))
    if "raw.events" in keeps:
        raw_keep = keeps["raw.events"]
    else:  # partman lỗi — vẫn tính hạn từ bảng chính sách (chỉ đọc)
        async with sm() as db:
            raw_keep = await effective_keep_days(db, "raw.events")
    await part("raw.attachments", "batch", in_session(lambda db: purge_orphan_attachments(db, raw_keep, deadline)))
    await part("agent.gen_conversations", "batch", in_session(purge_gen))
    await part("core.notifications", "batch", in_session(purge_notifications))

    summary = {"at": _utc_iso(), "datasets": datasets}
    redis = ctx.get("redis")
    if redis is not None:
        try:
            await redis.set(LAST_KEY, orjson.dumps(summary), ex=LAST_TTL)
        except Exception as exc:  # noqa: BLE001
            log.warning("Không ghi được %s: %s", LAST_KEY, exc)
    return summary


async def sync_partman_now() -> dict[str, int | None]:
    """Gọi ngay sau khi Owner đổi hạn lưu bảng phân vùng (PATCH /retention-policies) — qua admin session."""
    from gh.db import admin_sessionmaker

    async with admin_sessionmaker()() as adb:
        out = await sync_partman(adb)
        await adb.commit()
    return out


__all__ = ["BATCH", "DATASETS", "FIXED", "LAST_KEY", "PARTITIONED", "effective_keep_days", "read_last",
           "retention_sweep", "sync_partman", "sync_partman_now"]
