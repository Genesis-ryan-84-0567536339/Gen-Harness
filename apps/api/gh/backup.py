"""Sao lưu/khôi phục CSDL Postgres (PLAN §5.6).

- `pg_dump` thật, định dạng tuỳ biến nén sẵn (`-Fc`) ra tệp tạm.
- Mã hoá bằng đúng cơ chế phong bì AES-256-GCM của `gh.crypto` (giai đoạn 1 dùng cho bí mật) — không tự chế
  thuật toán mã hoá mới, chỉ đổi `associated data` để tách bối cảnh backup khỏi các bí mật khác.
- Lưu qua `gh.chassis.objects.ObjectStore` (điểm nối MinIO thật thay sau — xem docstring của module đó): tái
  dùng đúng abstraction dựng ở giai đoạn 3 cho Tài liệu, không viết client MinIO riêng cho backup.
- Vòng đời GFS (grandfather-father-son): giữ 7 bản gần nhất theo NGÀY + 4 bản theo TUẦN (ISO) + 12 bản theo
  THÁNG dương lịch — thuật toán thuần (`select_retained`, không đụng DB/đĩa) nên test được đầy đủ không cần
  dựng nhiều tháng dữ liệu thật. Một danh mục (`MANIFEST_KEY`) tự quản trong chính `ObjectStore` ghi lại
  từng bản: khoá, thời điểm, CSDL nguồn, kích thước, sha256 — vì `ObjectStore` chỉ có put/get/delete (không có
  list), không mở rộng giao diện đó chỉ để phục vụ backup.

Restore: giải mã, `pg_restore --clean --if-exists` thật vào CSDL đích — mặc định CSDL đang cấu hình
(`GH_DATABASE_URL`), cho phép chỉ định CSDL khác (`target_database`) để test không đụng CSDL đang dùng.

Lịch chạy: nối vào cấu hình lưu ở bước 11 trình thiết lập (`core.organizations.settings->'backup'` —
`gh/setup/routes.py::step11`). Vì `pg_dump` sao lưu TOÀN CỤM CSDL dùng chung giữa mọi tổ chức (multi-tenant qua
RLS, không phải một CSDL riêng mỗi tổ chức), lịch dùng chung là của tổ chức ĐẦU TIÊN có cấu hình (đúng mô hình
triển khai một tổ chức một bản cài của `genh`, giai đoạn 6) — quyết định tự đưa ra, ghi rõ ở đây để không mơ hồ
nếu sau này cần cấu hình lịch backup tách khỏi tổ chức. `retention_count` ở bước 11 KHÔNG dùng cho vòng đời
GFS này (spec 5.6 khoá cứng 7/4/12) — chỉ còn ý nghĩa hiển thị/tương thích ngược, ghi rõ trong báo cáo.

CLI: `python -m gh.backup run|list|prune|restore` — `Makefile` bọc `make backup` / `make restore BACKUP=<khoá>`.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import tempfile
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import SplitResult, urlsplit, urlunsplit

import orjson
from sqlalchemy import text

from gh import crypto
from gh.biz.hooks import CronJob, Hook
from gh.chassis.objects import ObjectNotFound, ObjectStore, content_hash, get_object_store
from gh.config import get_settings

log = logging.getLogger("gh.backup")

MANIFEST_KEY = "backups/manifest.json"
BACKUP_AAD = b"gh-backup-v1"

DAILY_KEEP = 7
WEEKLY_KEEP = 4
MONTHLY_KEEP = 12

DUE_WINDOW_MIN = 15  # dung sai quanh `time_of_day` cấu hình — job quét mỗi 15 phút (xem JOBS bên dưới)


@dataclass(frozen=True)
class BackupEntry:
    key: str
    taken_at: datetime          # UTC, có tzinfo
    database: str
    size_bytes: int
    sha256: str

    def to_json(self) -> dict[str, Any]:
        return {"key": self.key, "taken_at": self.taken_at.isoformat(), "database": self.database,
                "size_bytes": self.size_bytes, "sha256": self.sha256}

    @staticmethod
    def from_json(d: dict[str, Any]) -> BackupEntry:
        return BackupEntry(key=d["key"], taken_at=datetime.fromisoformat(d["taken_at"]), database=d["database"],
                           size_bytes=d["size_bytes"], sha256=d["sha256"])


# ─── DSN: `database_url` là SQLAlchemy async (`postgresql+asyncpg://…`), pg_dump/pg_restore cần libpq thường ──

def libpq_url(database_url: str, *, database: str | None = None) -> str:
    parts: SplitResult = urlsplit(database_url.replace("postgresql+asyncpg://", "postgresql://"))
    if database is not None:
        parts = parts._replace(path=f"/{database}")
    return urlunsplit(parts)


def database_name(database_url: str) -> str:
    return urlsplit(libpq_url(database_url)).path.lstrip("/")


# ─── vòng đời GFS: thuật toán thuần, không đụng DB/đĩa ─────────────────────────────────────────────────────

def select_retained(entries: Iterable[BackupEntry], *, now: datetime | None = None, daily: int = DAILY_KEEP,
                    weekly: int = WEEKLY_KEEP, monthly: int = MONTHLY_KEEP) -> set[str]:
    """Trả về tập `key` các bản backup CẦN GIỮ theo vòng đời 7 ngày/4 tuần/12 tháng.

    Thuật toán (mỗi bản chỉ thuộc đúng MỘT hạng, ưu tiên hạng gần nhất trước):
    1. **Hàng ngày**: với mỗi ngày dương lịch có ít nhất một bản, giữ bản MỚI NHẤT của ngày đó; lấy `daily`
       ngày gần nay nhất theo cách đó.
    2. **Hàng tuần**: trong các bản KHÔNG thuộc ngày đã giữ ở (1), nhóm theo tuần ISO (năm, số tuần), giữ bản
       mới nhất mỗi tuần; lấy `weekly` tuần gần nay nhất.
    3. **Hàng tháng**: trong các bản không thuộc ngày (1) VÀ không thuộc tuần (2), nhóm theo (năm, tháng
       dương lịch), giữ bản mới nhất mỗi tháng; lấy `monthly` tháng gần nay nhất.

    Mọi bản còn lại (cũ hơn 12 tháng, hoặc rơi vào ngày/tuần/tháng không lọt vào 3 vòng trên) bị dọn. `now`
    chỉ dùng để test (mặc định giờ hệ thống) — bản thân thuật toán chỉ so sánh các bản với NHAU, không so với
    `now`, nên không cần dữ liệu thật kéo dài nhiều tháng để kiểm.
    """
    items = sorted(entries, key=lambda e: e.taken_at, reverse=True)
    keep: set[str] = set()

    day_latest: dict[Any, BackupEntry] = {}
    for e in items:
        day_latest.setdefault(e.taken_at.date(), e)
    daily_days = sorted(day_latest, reverse=True)[:daily]
    keep.update(day_latest[d].key for d in daily_days)
    daily_days_set = set(daily_days)

    week_latest: dict[Any, BackupEntry] = {}
    for e in items:
        d = e.taken_at.date()
        if d in daily_days_set:
            continue
        week_latest.setdefault(d.isocalendar()[:2], e)
    weekly_weeks = sorted(week_latest, reverse=True)[:weekly]
    keep.update(week_latest[w].key for w in weekly_weeks)
    weekly_weeks_set = set(weekly_weeks)

    month_latest: dict[Any, BackupEntry] = {}
    for e in items:
        d = e.taken_at.date()
        if d in daily_days_set or d.isocalendar()[:2] in weekly_weeks_set:
            continue
        month_latest.setdefault((d.year, d.month), e)
    monthly_months = sorted(month_latest, reverse=True)[:monthly]
    keep.update(month_latest[m].key for m in monthly_months)

    return keep


# ─── danh mục (manifest) trong chính ObjectStore ───────────────────────────────────────────────────────────

async def _read_manifest(store: ObjectStore) -> list[BackupEntry]:
    try:
        raw = await store.get(MANIFEST_KEY)
    except ObjectNotFound:
        return []
    return [BackupEntry.from_json(d) for d in orjson.loads(raw)]


async def _write_manifest(store: ObjectStore, entries: list[BackupEntry]) -> None:
    await store.put(MANIFEST_KEY, orjson.dumps([e.to_json() for e in entries]))


async def list_backups(*, store: ObjectStore | None = None) -> list[BackupEntry]:
    store = store or get_object_store()
    return sorted(await _read_manifest(store), key=lambda e: e.taken_at, reverse=True)


# ─── chạy tiến trình con thật ───────────────────────────────────────────────────────────────────────────────

async def _run(cmd: list[str]) -> None:
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _out, err = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{cmd[0]} thất bại (mã {proc.returncode}): {err.decode(errors='replace')[-4000:]}")


# ─── backup / prune / restore ──────────────────────────────────────────────────────────────────────────────

async def run_backup(*, database_url: str | None = None, store: ObjectStore | None = None) -> BackupEntry:
    """`pg_dump -Fc` CSDL thật → mã hoá → lưu qua `ObjectStore` → dọn theo vòng đời GFS."""
    database_url = database_url or get_settings().database_url
    store = store or get_object_store()
    src = libpq_url(database_url)
    db_name = database_name(database_url)
    taken_at = datetime.now(UTC)

    with tempfile.TemporaryDirectory(prefix="gh-backup-") as tmp:
        dump_path = Path(tmp) / "dump.pgcustom"
        await _run(["pg_dump", "--format=custom", "--no-owner", "--file", str(dump_path), src])
        raw = dump_path.read_bytes()

    enc = crypto.encrypt(raw, associated=BACKUP_AAD)
    key = f"backups/{taken_at.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}.pgcustom.enc"
    await store.put(key, enc)
    entry = BackupEntry(key=key, taken_at=taken_at, database=db_name, size_bytes=len(raw),
                        sha256=content_hash(raw))

    entries = [*await _read_manifest(store), entry]
    await _write_manifest(store, entries)
    await prune(store=store, entries=entries)
    log.info("Backup mới: %s (%d byte, CSDL %s)", key, len(raw), db_name)
    return entry


async def prune(*, store: ObjectStore | None = None, entries: list[BackupEntry] | None = None,
                now: datetime | None = None) -> list[str]:
    """Áp vòng đời GFS lên danh mục hiện có, xoá phần thừa khỏi `ObjectStore`. Trả về các `key` đã xoá."""
    store = store or get_object_store()
    entries = entries if entries is not None else await _read_manifest(store)
    keep_keys = select_retained(entries, now=now)
    kept, removed = [], []
    for e in entries:
        if e.key in keep_keys:
            kept.append(e)
        else:
            await store.delete(e.key)
            removed.append(e.key)
    if removed:
        await _write_manifest(store, kept)
        log.info("Đã dọn %d bản backup quá hạn vòng đời", len(removed))
    return removed


async def restore_backup(key: str, *, database_url: str | None = None, target_database: str | None = None,
                         store: ObjectStore | None = None) -> None:
    """Giải mã bản backup `key`, `pg_restore --clean --if-exists` thật vào CSDL đích.

    `target_database`: tên CSDL khác CSDL đang cấu hình — dùng khi test round-trip để không đụng CSDL đang
    dùng (spec 5.6 yêu cầu rõ điều này).
    """
    database_url = database_url or get_settings().database_url
    store = store or get_object_store()
    enc = await store.get(key)
    raw = crypto.decrypt(enc, associated=BACKUP_AAD)
    dest = libpq_url(database_url, database=target_database) if target_database else libpq_url(database_url)

    with tempfile.TemporaryDirectory(prefix="gh-restore-") as tmp:
        dump_path = Path(tmp) / "dump.pgcustom"
        dump_path.write_bytes(raw)
        await _run(["pg_restore", "--clean", "--if-exists", "--no-owner", "--dbname", dest, str(dump_path)])
    log.info("Đã khôi phục %s vào %s", key, target_database or database_name(database_url))


# ─── lịch chạy định kỳ theo cấu hình bước 11 (worker cron — xem JOBS bên dưới) ─────────────────────────────

def is_due(cfg: dict[str, Any], *, last_at: datetime | None, now: datetime) -> bool:
    """`cfg` là `settings->'backup'` (bước 11: `frequency`, `time_of_day`). Đến giờ khi: giờ hiện tại nằm
    trong cửa sổ `DUE_WINDOW_MIN` phút quanh `time_of_day` cấu hình, VÀ chưa có bản backup nào trong chu kỳ
    hiện tại (ngày/tuần ISO/tháng dương lịch tuỳ `frequency`)."""
    try:
        hh, mm = (int(x) for x in str(cfg.get("time_of_day", "02:00")).split(":"))
    except ValueError:
        hh, mm = 2, 0
    scheduled = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if abs((now - scheduled).total_seconds()) > DUE_WINDOW_MIN * 60:
        return False
    if last_at is None:
        return True
    freq = cfg.get("frequency", "daily")
    if freq == "weekly":
        return last_at.isocalendar()[:2] < now.isocalendar()[:2]
    if freq == "monthly":
        return (last_at.year, last_at.month) < (now.year, now.month)
    return last_at.date() < now.date()  # "daily" và giá trị lạ khác → mặc định hằng ngày


async def scheduled_backup_scan(ctx: dict[str, Any]) -> dict[str, Any]:
    """Quét mỗi `DUE_WINDOW_MIN` phút (đăng ký ở `JOBS`): đọc `settings->'backup'` của tổ chức đầu tiên đã
    cấu hình (xem lý do ở docstring đầu module), chạy `run_backup()` thật nếu đến giờ."""
    from gh.db import sessionmaker

    sm = sessionmaker()
    async with sm() as db:
        row = (await db.execute(text("""
            SELECT settings -> 'backup' AS cfg FROM core.organizations
            WHERE settings ? 'backup' ORDER BY created_at LIMIT 1"""))).first()
    if row is None or not row.cfg:
        return {"skipped": "no_config"}

    store = get_object_store()
    entries = await list_backups(store=store)
    last_at = entries[0].taken_at if entries else None
    now = datetime.now(UTC)
    if not is_due(row.cfg, last_at=last_at, now=now):
        return {"skipped": "not_due"}
    entry = await run_backup(store=store)
    return {"ran": entry.key}


HOOKS: list[Hook] = []
JOBS: list[CronJob] = [(scheduled_backup_scan, {"minute": set(range(0, 60, DUE_WINDOW_MIN))})]


# ─── CLI: `python -m gh.backup …` (Makefile bọc `make backup` / `make restore BACKUP=<khoá>`) ──────────────

async def _main() -> None:
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Sao lưu/khôi phục CSDL Gen-Harness (PLAN §5.6)")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("run", help="Chạy pg_dump + mã hoá + lưu + dọn vòng đời ngay")
    sub.add_parser("prune", help="Chỉ áp vòng đời GFS lên danh mục hiện có")
    sub.add_parser("list", help="Liệt kê các bản backup còn giữ")
    p_restore = sub.add_parser("restore", help="Giải mã + pg_restore một bản backup")
    p_restore.add_argument("--key", required=True, help="Khoá bản backup (xem `list`)")
    p_restore.add_argument("--target-database", default=None, help="CSDL đích khác CSDL đang cấu hình")
    args = parser.parse_args()

    if args.action == "run":
        entry = await run_backup()
        log.info("OK: %s", entry.to_json())
    elif args.action == "prune":
        removed = await prune()
        log.info("Đã xoá %d bản: %s", len(removed), removed)
    elif args.action == "list":
        for e in await list_backups():
            log.info("%s  %s  %d byte  CSDL=%s", e.taken_at.isoformat(), e.key, e.size_bytes, e.database)
    elif args.action == "restore":
        await restore_backup(args.key, target_database=args.target_database)
        log.info("Đã khôi phục %s", args.key)


if __name__ == "__main__":
    asyncio.run(_main())
