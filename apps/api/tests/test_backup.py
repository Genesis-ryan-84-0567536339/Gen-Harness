"""PLAN §5.6 — Backup/restore.

Hai lớp kiểm:
1. `select_retained`/`is_due`: thuật toán THUẦN (không đụng DB/đĩa) — kiểm vòng đời GFS 7 ngày/4 tuần/12 tháng
   với lịch sử tổng hợp nhiều tháng, không cần dựng dữ liệu thật kéo dài cả năm.
2. Round-trip THẬT trên Postgres 16 thật: `pg_dump` → mã hoá (`gh.crypto`) → `ObjectStore` đĩa cục bộ → xoá
   sạch (khôi phục vào CSDL đích trống, khác CSDL nguồn — không đụng CSDL đang dùng của bộ test khác chạy
   song song) → `pg_restore` → đối chiếu KHÔNG chỉ tổng số dòng mà cả giá trị cụ thể (mã cơ hội, số tiền, tên
   người) khớp `docs/design/seed-data.json` qua `gh.seed_demo`.
"""

import uuid
from datetime import UTC, datetime, timedelta

import psycopg
import pytest
from sqlalchemy import text

from gh.backup import BackupEntry, is_due, list_backups, restore_backup, run_backup, select_retained
from gh.chassis.objects import LocalObjectStore
from gh.db import sessionmaker
from gh.seed_demo import seed_demo
from tests.conftest import PG

# ═══ vòng đời GFS (thuần) ═══════════════════════════════════════════════════════

def _entry(day_offset: int, key: str | None = None, *, hour: int = 2) -> BackupEntry:
    ts = datetime(2026, 1, 1, hour, tzinfo=UTC) - timedelta(days=day_offset)
    return BackupEntry(key=key or f"d{day_offset}", taken_at=ts, database="gh", size_bytes=1, sha256="x")


def test_select_retained_empty() -> None:
    assert select_retained([]) == set()


def test_select_retained_fewer_than_daily_cap_keeps_all() -> None:
    entries = [_entry(i) for i in range(5)]
    assert select_retained(entries) == {e.key for e in entries}


def test_select_retained_one_year_of_daily_backups_keeps_exactly_23() -> None:
    """400 ngày liên tục có backup hằng ngày → đúng 7 (ngày) + 4 (tuần) + 12 (tháng) = 23 bản còn giữ, 7 ngày
    gần nhất chắc chắn nằm trong đó, phần còn lại (377 bản) bị dọn."""
    entries = [_entry(i) for i in range(400)]
    keep = select_retained(entries)
    assert len(keep) == 7 + 4 + 12
    assert {f"d{i}" for i in range(7)} <= keep
    kept_offsets = sorted(int(k[1:]) for k in keep)
    assert kept_offsets[0] == 0  # bản mới nhất luôn được giữ
    assert kept_offsets == sorted(set(kept_offsets))  # không trùng


def test_select_retained_multiple_same_day_keeps_only_latest() -> None:
    ts = datetime(2026, 1, 1, 12, tzinfo=UTC)
    older = BackupEntry(key="sang", taken_at=ts, database="gh", size_bytes=1, sha256="x")
    newer = BackupEntry(key="toi", taken_at=ts + timedelta(hours=6), database="gh", size_bytes=1, sha256="x")
    assert select_retained([older, newer]) == {"toi"}


def test_select_retained_eight_consecutive_days_one_falls_to_weekly() -> None:
    """8 ngày liên tục, ít hơn 23 tổng → không có gì bị dọn: 7 gần nhất theo hạng ngày, ngày thứ 8 (cũ nhất)
    không lọt hạng ngày nhưng vẫn có chỗ ở hạng tuần (4 tuần còn trống) nên vẫn được giữ."""
    entries = [_entry(i) for i in range(8)]
    keep = select_retained(entries)
    assert keep == {e.key for e in entries}


def test_select_retained_beyond_all_buckets_are_pruned() -> None:
    """> 23 bản rải xa nhau (mỗi 20 ngày, hơn 2 năm) → chỉ 23 bản tồn tại lâu nhất trong 3 vòng được giữ,
    phần vượt vòng tháng (> tháng thứ 12 kể từ vòng tuần) bị dọn hẳn."""
    entries = [_entry(i) for i in range(0, 900, 20)]  # 45 bản, mỗi bản một ngày riêng biệt
    keep = select_retained(entries)
    assert len(keep) <= 7 + 4 + 12
    assert len(keep) < len(entries)  # có dọn thật, không giữ hết
    # 7 bản gần nhất (theo ngày) luôn còn
    newest_seven = sorted(entries, key=lambda e: e.taken_at, reverse=True)[:7]
    assert {e.key for e in newest_seven} <= keep


# ═══ lịch chạy theo cấu hình bước 11 ════════════════════════════════════════════

NOW = datetime(2026, 6, 15, 2, 3, tzinfo=UTC)  # 02:03 UTC — trong cửa sổ 15' quanh "02:00"


def test_is_due_daily_first_run_in_window() -> None:
    cfg = {"frequency": "daily", "time_of_day": "02:00"}
    assert is_due(cfg, last_at=None, now=NOW) is True


def test_is_due_daily_outside_window() -> None:
    cfg = {"frequency": "daily", "time_of_day": "02:00"}
    outside = NOW.replace(hour=10)
    assert is_due(cfg, last_at=None, now=outside) is False


def test_is_due_daily_already_ran_today() -> None:
    cfg = {"frequency": "daily", "time_of_day": "02:00"}
    assert is_due(cfg, last_at=NOW.replace(hour=1), now=NOW) is False


def test_is_due_daily_ran_yesterday() -> None:
    cfg = {"frequency": "daily", "time_of_day": "02:00"}
    assert is_due(cfg, last_at=NOW - timedelta(days=1), now=NOW) is True


def test_is_due_weekly_same_iso_week_not_due() -> None:
    cfg = {"frequency": "weekly", "time_of_day": "02:00"}
    monday = NOW - timedelta(days=NOW.weekday())
    assert is_due(cfg, last_at=monday, now=NOW) is False


def test_is_due_weekly_previous_week_due() -> None:
    cfg = {"frequency": "weekly", "time_of_day": "02:00"}
    assert is_due(cfg, last_at=NOW - timedelta(days=8), now=NOW) is True


def test_is_due_monthly_same_month_not_due() -> None:
    cfg = {"frequency": "monthly", "time_of_day": "02:00"}
    assert is_due(cfg, last_at=NOW.replace(day=1), now=NOW) is False


def test_is_due_monthly_previous_month_due() -> None:
    cfg = {"frequency": "monthly", "time_of_day": "02:00"}
    assert is_due(cfg, last_at=NOW.replace(month=5), now=NOW) is True


# ═══ round-trip THẬT: pg_dump + mã hoá + ObjectStore + pg_restore ═══════════════

def _admin(sql: str) -> None:
    with psycopg.connect(f"{PG}/postgres", autocommit=True) as c:
        c.execute(sql)


def _connect(dbname: str) -> psycopg.Connection:
    return psycopg.connect(f"{PG}/{dbname}", autocommit=True)


@pytest.fixture
def scratch_db():  # type: ignore[no-untyped-def]
    name = f"gh_backup_scratch_{uuid.uuid4().hex[:10]}"
    _admin(f"CREATE DATABASE {name}")
    try:
        yield name
    finally:
        _admin(f"DROP DATABASE IF EXISTS {name} WITH (FORCE)")


async def test_backup_restore_direct_with_clean_overwrite_and_real_encryption(tmp_path, scratch_db) -> None:  # type: ignore[no-untyped-def]
    """`pg_restore --clean --if-exists` phải XOÁ dữ liệu cũ ở CSDL đích trước khi khôi phục (không chỉ cộng
    thêm); và bản lưu trong `ObjectStore` phải là bản MÃ HOÁ thật (không phải bytes `pg_dump` gốc)."""
    with _connect(scratch_db) as c:
        c.execute("CREATE TABLE t (id serial primary key, v text)")
        c.execute("INSERT INTO t (v) VALUES ('a'), ('b'), ('c')")

    store = LocalObjectStore(root=str(tmp_path / "objects"))
    src_url = f"{PG}/{scratch_db}"
    entry = await run_backup(database_url=src_url, store=store)
    assert entry.database == scratch_db and entry.size_bytes > 0
    assert [e.key for e in await list_backups(store=store)] == [entry.key]

    raw_blob = await store.get(entry.key)
    assert raw_blob[:3] == b"GH1"          # phong bì gh.crypto, không phải header pg_dump ("PGDMP")
    assert b"PGDMP" not in raw_blob[:200]

    target = f"gh_backup_scratch_target_{uuid.uuid4().hex[:10]}"
    _admin(f"CREATE DATABASE {target}")
    try:
        with _connect(target) as c:  # dữ liệu KHÁC đã có sẵn — mô phỏng CSDL đích cần "xoá sạch"
            c.execute("CREATE TABLE t (id serial primary key, v text)")
            c.execute("INSERT INTO t (v) VALUES ('rac-cu-phai-mat')")

        await restore_backup(entry.key, database_url=src_url, target_database=target, store=store)

        with _connect(target) as c:
            rows = c.execute("SELECT v FROM t ORDER BY id").fetchall()
        assert [r[0] for r in rows] == ["a", "b", "c"]
    finally:
        _admin(f"DROP DATABASE IF EXISTS {target} WITH (FORCE)")


def _counts(conn: psycopg.Connection, org: str) -> dict[str, int]:
    def n(sql: str) -> int:
        with conn.cursor() as cur:
            cur.execute(sql, (org,))
            return cur.fetchone()[0]  # type: ignore[no-any-return]

    return {
        "raw": n("SELECT count(*) FROM raw.events e JOIN core.channels c ON c.id = e.channel_id WHERE c.org_id = %s"),
        "units": n("SELECT count(*) FROM clean.meaning_units WHERE org_id = %s"),
        "opps": n("SELECT count(*) FROM biz.opportunities WHERE org_id = %s"),
        "signals": n("SELECT count(*) FROM biz.market_signals WHERE org_id = %s"),
        "alerts": n("SELECT count(*) FROM biz.alerts WHERE org_id = %s"),
        "agents": n("SELECT count(*) FROM agent.identities WHERE org_id = %s"),
    }


async def test_backup_restore_round_trip_preserves_seed_demo_data(app, db, redis, fresh_db, tmp_path) -> None:  # type: ignore[no-untyped-def]
    """Backup CSDL có dữ liệu thật (`make seed-demo`) → khôi phục vào một CSDL MỚI HOÀN TOÀN TRỐNG (tương
    đương "xoá sạch rồi khôi phục" — tránh đụng pool kết nối SQLAlchemy đang mở của chính bộ test song song
    trong môi trường dùng chung) → đối chiếu số dòng CÁC BẢNG CHÍNH và vài giá trị cụ thể, không chỉ tổng số."""
    sm = sessionmaker()
    seeded = await seed_demo(sm, redis)
    org = seeded["org_id"]

    before_opp = (await db.execute(text("""
        SELECT o.code, o.value_vnd, p.display_name FROM biz.opportunities o JOIN core.persons p ON p.id = o.person_id
        WHERE o.org_id = :o AND p.display_name = 'Trần Văn Hậu'"""), {"o": org})).one()
    before_alert = (await db.execute(text("""
        SELECT a.priority, a.alert_type, p.display_name FROM biz.alerts a JOIN core.persons p ON p.id = a.subject_id
        WHERE a.org_id = :o AND a.alert_type = 'repeated_complaint'"""), {"o": org})).one()
    before_counts = {k: v for k, v in (await db.execute(text("""
        SELECT 'raw', (SELECT count(*) FROM raw.events e JOIN core.channels c ON c.id = e.channel_id
                       WHERE c.org_id = :o)
        UNION ALL SELECT 'units', (SELECT count(*) FROM clean.meaning_units WHERE org_id = :o)
        UNION ALL SELECT 'opps', (SELECT count(*) FROM biz.opportunities WHERE org_id = :o)
        UNION ALL SELECT 'signals', (SELECT count(*) FROM biz.market_signals WHERE org_id = :o)
        UNION ALL SELECT 'alerts', (SELECT count(*) FROM biz.alerts WHERE org_id = :o)
        UNION ALL SELECT 'agents', (SELECT count(*) FROM agent.identities WHERE org_id = :o)"""),
        {"o": org})).all()}
    assert before_counts["units"] > 0 and before_counts["opps"] > 0 and before_counts["alerts"] > 0

    store = LocalObjectStore(root=str(tmp_path / "objects"))
    src_url = f"{PG}/{fresh_db}"
    entry = await run_backup(database_url=src_url, store=store)

    target = f"gh_backup_restore_{uuid.uuid4().hex[:10]}"
    _admin(f"CREATE DATABASE {target}")  # CSDL mới hoàn toàn trống — chưa có schema/dữ liệu gì
    try:
        await restore_backup(entry.key, database_url=src_url, target_database=target, store=store)

        with _connect(target) as conn:
            after_counts = _counts(conn, org)
            with conn.cursor() as cur:
                cur.execute("""SELECT o.code, o.value_vnd, p.display_name FROM biz.opportunities o
                               JOIN core.persons p ON p.id = o.person_id
                               WHERE o.org_id = %s AND p.display_name = 'Trần Văn Hậu'""", (org,))
                after_opp = cur.fetchone()
                cur.execute("""SELECT a.priority, a.alert_type, p.display_name FROM biz.alerts a
                               JOIN core.persons p ON p.id = a.subject_id
                               WHERE a.org_id = %s AND a.alert_type = 'repeated_complaint'""", (org,))
                after_alert = cur.fetchone()

        assert after_counts == before_counts  # nguyên vẹn tổng số ở mọi bảng chính, không chỉ một bảng
        assert after_opp == (before_opp.code, before_opp.value_vnd, before_opp.display_name)
        assert after_opp[1] == 1_200_000_000  # giá trị cụ thể khớp docs/design/seed-data.json (OPP-1842)
        assert after_alert == (before_alert.priority, before_alert.alert_type, before_alert.display_name)
        assert after_alert[0] == "P1" and after_alert[2] == "Nguyễn Văn Bảo"
    finally:
        _admin(f"DROP DATABASE IF EXISTS {target} WITH (FORCE)")
