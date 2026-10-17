"""L6 (v0.1.69, gói D3) — quyết định của Sếp thành test: trôi khỏi ý Sếp mà không ai biết thì CI đỏ.

Mỗi quyết định (QD) đang hiệu lực có ít nhất một khẳng định; docstring/tên test ghi mã QD. Quyết định MỚI của Sếp ⇒ thêm
khẳng định trong cùng PR (kế hoạch sửa sau kiểm kê 16/10/2026, lưới L6).

- QD-20 (Sếp duyệt 10/10): Gen hướng dẫn yên lặng 21:00–07:00, ≤ 3 việc, chuông ≤ 1/ngày, cron 09:05/11:05/14:05 (F121).
- QD-18: ghi Kho dữ liệu (Phiên, Việc) chỉ qua Xác nhận + mã PIN; kanban, mail, lịch không ghi (F124).
- QD-22 (2): không còn chữ "Kho <tên riêng cũ>" trong chuỗi chạy thật, kể cả dữ liệu đã lưu qua migration (F122).
- QD-12: trình duyệt nền không "stealth", không né/giải CAPTCHA.
- v0.1.55 (Sếp "gọn"): chỉ 1 dòng "Việc Sếp cần làm" bắt buộc; mô tả mục tiêu Gen bám đúng điều đã bỏ (F033).
- 16/10 Q1: Antigravity mở cho lớp core/nội bộ; lớp ngoại giao (trả lời/soạn tin cho người ngoài) qua hộp riêng,
  chưa dùng agy.
- 16/10 Telegram: Gen chỉ ĐỀ XUẤT — không nút Duyệt, không nhận mã PIN, không ghi ra ngoài từ Telegram.
- 16/10 Q5 (=2): thu thành viên MỌI nhóm, kể cả nhóm "Không nghe". Q6 (=1): chế độ "chỉ khi được tag" vẫn lưu tin,
  chỉ sửa chữ.
- 16/10 Q4 (=2): vai Quản lý thấy việc được giao cho mình (không hứa "team"); Q7 (=1): giữ Jev; Q8 (=1): ghi
  hệ thống ngoài
  chặn và nói rõ; Q2/Q3: xem test_*_quyet_dinh_* của gói liên quan.
"""

import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
import pytest
from sqlalchemy import text

from gh.boss_checks import service as boss_service
from gh.gen import proposals
from gh.gen.coach import engine
from gh.hub_link import service as hub
from gh.providers import agy_policy
from tests.conftest import PG, Api
from tests.phase2 import org_id
from tests.test_no_personal_info_v0156 import OLD_NAME

ROOT = Path(__file__).resolve().parents[3]
GH_DIR = ROOT / "apps" / "api" / "gh"
SQL_0040 = ROOT / "db" / "sql" / "0040_v016x_theo_qd.sql"
VN = ZoneInfo("Asia/Ho_Chi_Minh")


# ─── QD-20 · Gen hướng dẫn ────────────────────────────────────────────────────────────────────────────────────

def test_qd20_defaults_quiet_21_to_7_three_todos_one_lesson() -> None:
    """QD-20: yên lặng 21:00–07:00 (F121 — từng là 22), tối đa 3 việc, 1 bài/ngày."""
    p = engine.Prefs()
    assert (p.quiet_start, p.quiet_end) == (21, 7)
    assert engine.MAX_TODOS == 3
    assert p.lessons_per_day == 1 and p.bell is True


@pytest.mark.parametrize(("hour", "minute", "quiet"), [(20, 59, False), (21, 0, True), (23, 30, True), (3, 0, True),
                                                       (6, 59, True), (7, 0, False), (9, 5, False)])
def test_qd20_quiet_window_edges(hour: int, minute: int, quiet: bool) -> None:
    """QD-20: ranh giới giờ yên lặng đúng 21:00 (vào) và 07:00 (ra), theo múi giờ tổ chức."""
    now = datetime(2026, 10, 12, hour, minute, tzinfo=VN).astimezone(UTC)
    assert engine.in_quiet_hours(engine.Prefs(), now, VN) is quiet


def test_qd20_cron_times() -> None:
    """QD-20: chuông Gen hướng dẫn chạy 09:05, 11:05, 14:05 giờ VN (trong giờ làm việc)."""
    from gh.worker import WorkerSettings

    cj = next(c for c in WorkerSettings.cron_jobs if c.name == "cron:gen_coach")
    assert cj.hour == {9, 11, 14} and cj.minute == {5}


async def test_qd20_new_owner_prefs_default_21_and_bell_once_a_day(owner_api: Api, db: Any) -> None:
    """QD-20: máy mới trả giờ yên lặng 21→7; cột DB mặc định 21; chuông ≤ 1/ngày (cổng nguyên tử `claim_bell`)."""
    from gh.gen.coach import store

    prefs = (await owner_api.get("/gen/coach/prefs")).json()
    assert (prefs["quiet_start"], prefs["quiet_end"]) == (21, 7)
    default = (await db.execute(text("""SELECT column_default FROM information_schema.columns
                                        WHERE table_schema = 'agent' AND table_name = 'gen_coach_prefs'
                                          AND column_name = 'quiet_start'"""))).scalar_one()
    assert default == "21"
    org = await org_id(db)
    uid = (await db.execute(text("SELECT id FROM core.users WHERE org_id = :o LIMIT 1"), {"o": org})).scalar_one()
    await store.ensure_prefs(db, org, uid)
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    assert await store.claim_bell(db, uid, today, ["todo:a"], datetime.now(UTC)) is True
    assert await store.claim_bell(db, uid, today, ["todo:a"], datetime.now(UTC)) is False


async def test_qd20_migration_0040_moves_default_rows_only_and_is_rerunnable(owner_api: Api, db: Any,
                                                                             fresh_db: str) -> None:
    """QD-20: migration đổi hàng còn mặc định cũ 22→21; giá trị Sếp đã chỉnh (lệch hoặc có trong Nhật ký) được giữ."""
    org = await org_id(db)
    users = [(await db.execute(text("""
        INSERT INTO core.users (org_id, email, display_name, password_hash) VALUES (:o, :e, :n, 'x') RETURNING id"""),
                               {"o": org, "e": f"u{i}@example.test", "n": f"Owner {i}"})).scalar_one()
             for i in range(4)]
    await db.commit()
    sql = SQL_0040.read_text(encoding="utf-8")
    with psycopg.connect(f"{PG}/{fresh_db}", autocommit=True) as c:
        ins = "INSERT INTO agent.gen_coach_prefs (user_id, org_id, quiet_start, quiet_end) VALUES (%s, %s, %s, %s)"
        c.execute("ALTER TABLE agent.gen_coach_prefs ALTER COLUMN quiet_start SET DEFAULT 22")   # máy v0.1.54–v0.1.68
        c.execute(ins, (users[0], org, 22, 7))      # còn mặc định cũ ⇒ đổi
        c.execute(ins, (users[1], org, 23, 7))      # Sếp chỉnh 23 ⇒ giữ
        c.execute(ins, (users[2], org, 22, 8))      # Sếp chỉnh giờ ra ⇒ giữ
        c.execute(ins, (users[3], org, 22, 7))      # Sếp từng chỉnh rồi quay lại đúng 22 (có trong Nhật ký) ⇒ giữ
        c.execute("""INSERT INTO ops.action_log (org_id, actor_type, actor_id, action, target_type, target_id, result,
                                                 detail, row_hash)
                     VALUES (%s, 'user', %s, 'gen.coach_prefs_changed', 'settings', 'gen_coach', 'ok',
                             '{"fields": ["quiet_start", "quiet_end"]}', '\\x00')""", (org, f"user:{users[3]}"))

        def snap() -> dict[str, int]:
            rows = c.execute("SELECT user_id, quiet_start FROM agent.gen_coach_prefs").fetchall()
            return {str(u): int(q) for u, q in rows}

        c.execute(sql)  # type: ignore[call-overload]
        first = snap()
        assert first == {str(users[0]): 21, str(users[1]): 23, str(users[2]): 22, str(users[3]): 22}
        c.execute(sql)  # type: ignore[call-overload]
        assert snap() == first
        default = c.execute("""SELECT column_default FROM information_schema.columns WHERE table_schema = 'agent'
                               AND table_name = 'gen_coach_prefs' AND column_name = 'quiet_start'""").fetchone()
        assert default == ("21",)


# ─── QD-18 · ghi Kho chỉ qua Xác nhận + PIN ───────────────────────────────────────────────────────────────────

def test_qd18_kho_write_needs_pin_and_owner_other_writes_denied() -> None:
    """QD-18: ghi Kho (Phiên, Việc) luôn cần mã PIN và chỉ Owner; tool ghi kanban/mail/lịch/Drive bị chặn."""
    assert proposals.requires_pin(f"{proposals.KHO_TARGET_PREFIX}Phiên") is True
    assert proposals.requires_pin(f"{proposals.KHO_TARGET_PREFIX}VIEC-1") is True
    assert set(proposals.KHO_TYPES) <= set(proposals.OWNER_ONLY_TYPES)
    from gh.auth import service as auth_service

    assert auth_service.PIN_OPERATIONS["hub.write"].startswith("Ghi Kho dữ liệu")
    for suffix in ("gmail_send", "gmail_create_draft", "calendar_create_event", "drive_create_file", "tasks_create"):
        assert suffix in hub.WRITE_SUFFIXES_DENY
        assert suffix not in hub.READ_SUFFIXES
    assert all(not re.search(r"create|update|send|write|share|edit", s) for s in hub.READ_SUFFIXES)


def test_qd18_hub_server_note_says_write_needs_confirm_and_pin() -> None:
    """QD-18 (F124): ghi chú máy chủ Gen-hub không còn "(chỉ đọc)" — nói rõ ghi Kho chỉ khi Sếp Xác nhận + mã PIN."""
    assert "chỉ đọc" not in hub.SERVER_NOTE
    assert "ghi Kho chỉ khi Sếp Xác nhận + mã PIN" in hub.SERVER_NOTE
    for rel in ("gen/registry.json",):
        raw = (GH_DIR / rel).read_text(encoding="utf-8")
        assert "(chỉ đọc, chỉ Sếp)" not in raw


async def test_qd18_migration_0040_updates_old_server_note_only_and_is_rerunnable(owner_api: Api, db: Any,
                                                                                  fresh_db: str) -> None:
    """QD-18 (F124): ghi chú máy chủ Gen-hub cũ "(chỉ đọc)" đã lưu → ghi chú mới (kể cả khi Owner đặt tên Kho khác);
    ghi chú Owner tự sửa, máy chủ khác, bản mới: giữ nguyên."""
    org = await org_id(db)
    await db.rollback()
    old = "Liên kết Gen-hub — Gen đọc {k}, lịch, mail, việc, Drive (chỉ đọc). Quản lý ở thẻ Gen-hub."
    ins = ("INSERT INTO agent.mcp_servers (org_id, name, transport, endpoint, note) "
           "VALUES (%s, %s, 'streamable_http', 'https://mcp.example.test/mcp', %s)")
    sql = SQL_0040.read_text(encoding="utf-8")
    with psycopg.connect(f"{PG}/{fresh_db}", autocommit=True) as c:
        c.execute(ins, (org, "Gen-hub", old.format(k="Kho dữ liệu")))
        c.execute(ins, (org, "Gen-hub", old.format(k="Kho nhà tôi")))               # Owner tự đặt tên Kho (v0.1.57)
        c.execute(ins, (org, "Gen-hub", "Ghi chú Owner tự sửa (chỉ đọc)"))          # tự sửa tay ⇒ KHÔNG đụng
        c.execute(ins, (org, "Máy chủ khác", old.format(k="Kho dữ liệu")))          # tên máy chủ khác ⇒ KHÔNG đụng

        def notes() -> list[tuple[str, str]]:
            return c.execute("SELECT name, note FROM agent.mcp_servers ORDER BY name, note").fetchall()

        c.execute(sql)  # type: ignore[call-overload]
        first = notes()
        c.execute(sql)  # type: ignore[call-overload]
        assert notes() == first
        new = "(đọc; ghi Kho chỉ khi Sếp Xác nhận + mã PIN). Quản lý ở thẻ Gen-hub."
        assert sorted(first) == sorted([
            ("Gen-hub", "Liên kết Gen-hub — Gen đọc Kho dữ liệu, lịch, mail, việc, Drive " + new),
            ("Gen-hub", "Liên kết Gen-hub — Gen đọc Kho nhà tôi, lịch, mail, việc, Drive " + new),
            ("Gen-hub", "Ghi chú Owner tự sửa (chỉ đọc)"),
            ("Máy chủ khác", old.format(k="Kho dữ liệu"))])


# ─── QD-22 · không còn tên riêng trong dữ liệu đã lưu ─────────────────────────────────────────────────────────

async def test_qd22_migration_0040_cleans_stored_old_kho_name_and_is_rerunnable(owner_api: Api, db: Any,
                                                                                fresh_db: str) -> None:
    """QD-22 (F122): hội thoại Gen + chuông đã lưu chữ "Kho <tên riêng cũ>" (v0.1.50–55) được thay bằng "Kho dữ liệu";
    dòng khác giữ nguyên; chạy lại không đổi gì."""
    org = await org_id(db)
    uid = (await db.execute(text("SELECT id FROM core.users WHERE org_id = :o LIMIT 1"), {"o": org})).scalar_one()
    await db.rollback()
    old = f"Kho {OLD_NAME.removeprefix('Kho ')}"
    sql = SQL_0040.read_text(encoding="utf-8")
    with psycopg.connect(f"{PG}/{fresh_db}", autocommit=True) as c:
        conv = c.execute("""INSERT INTO agent.gen_conversations (org_id, user_id, title) VALUES (%s, %s, 'T')
                            RETURNING id""", (org, uid)).fetchone()
        assert conv is not None
        contents = (f"Em đề xuất ghi một Phiên vào {old} để lưu mốc", f"em đọc {old.lower()} rồi", "Không liên quan")
        for content in contents:
            c.execute("INSERT INTO agent.gen_messages (conversation_id, org_id, role, content) "
                      "VALUES (%s, %s, 'assistant', %s::jsonb)", (conv[0], org, json.dumps({"text": content})))
        for title, body in ((f"Gen đề xuất ghi {old}", f"Ghi Phiên vào {old}."), ("Sao lưu xong", "Không liên quan")):
            c.execute("INSERT INTO core.notifications (org_id, user_id, kind, title, body) "
                      "VALUES (%s, %s, 'x', %s, %s)", (org, uid, title, body))

        def dump() -> list[Any]:
            m = c.execute("SELECT content FROM agent.gen_messages ORDER BY content").fetchall()
            n = c.execute("SELECT title, body FROM core.notifications ORDER BY title").fetchall()
            return [m, n]

        c.execute(sql)  # type: ignore[call-overload]
        first = dump()
        flat = " ".join(str(x) for part in first for row in part for x in row)
        assert OLD_NAME.lower() not in flat.lower()
        assert "Kho dữ liệu" in flat and "Không liên quan" in flat
        c.execute(sql)  # type: ignore[call-overload]
        assert dump() == first


def test_qd22_no_old_name_in_runtime_strings_or_registry() -> None:
    """QD-22: chuỗi chạy thật + registry sinh ra không chứa tên riêng cũ (bổ sung test_no_personal_info_v0156)."""
    for rel in ("gen/registry.json", "gen/coach/content/lessons.json", "gen/coach/content/tips.json"):
        assert OLD_NAME not in (GH_DIR / rel).read_text(encoding="utf-8"), rel
    assert OLD_NAME not in hub.SERVER_NOTE


# ─── v0.1.55 · "gọn" ──────────────────────────────────────────────────────────────────────────────────────────

def test_v0155_only_one_required_boss_row_and_readme_says_so() -> None:
    """v0.1.55: chỉ dòng 0 (nguồn AI) bắt buộc; README nói đúng điều đó."""
    assert boss_service.REQUIRED_TOTAL == 1
    required = [r["key"] for r in boss_service.ROWS if not r["optional"]]
    assert required == ["ai"]
    assert "chỉ 1 dòng bắt buộc" in (ROOT / "README.md").read_text(encoding="utf-8")


def test_v0155_agy_row_target_does_not_promise_switching_two_accounts() -> None:
    """v0.1.55 (F033): Sếp đã bỏ bài "đổi qua lại hai tài khoản" — mô tả mục tiêu Gen của dòng Google bám đúng."""
    reg = json.loads((GH_DIR / "gen" / "registry.json").read_text(encoding="utf-8"))
    agy = next(t for t in reg["targets"] if t["id"] == "boss_checks.row.agy")
    assert agy["description"] == "Dòng 3 của Việc Sếp cần làm: đăng nhập tài khoản Google rồi bấm Gọi thử"
    texts = [t["description"] for t in reg["targets"]] + [s for g in reg["guide"] for s in g["steps"]]
    assert not [t for t in texts if "đổi qua lại" in t and "hai tài khoản" in t]
    ts = (ROOT / "packages" / "contracts" / "src" / "genTargets.ts").read_text(encoding="utf-8")
    assert "đổi qua lại" not in ts


# ─── 16/10 · Q1 agy: core/nội bộ mở, ngoại giao qua hộp riêng ─────────────────────────────────────────────────

def test_q1_agy_open_for_core_and_internal_closed_for_diplomatic_layer() -> None:
    """16/10 Q1: core.gen của Sếp, bản tin, sàng lọc, agent nội bộ dùng được agy; core.reply, agent ngoại giao, soạn
    lại/dịch nháp và Gen của nhân viên thì chưa (chờ hộp riêng / dùng khoá API)."""
    d = agy_policy.decide
    assert d("core.gen", owner=True).allowed and d("core.briefing").allowed and d("core.refinery").allowed
    assert d("agent:11111111-1111-1111-1111-111111111111", diplomatic=False).allowed
    assert d("agent:11111111-1111-1111-1111-111111111111", diplomatic=True).code == agy_policy.CODE_DIPLOMATIC
    assert d("core.reply").code == agy_policy.CODE_DIPLOMATIC
    for purpose in agy_policy.DIPLOMATIC_PURPOSES:
        assert d("core.gen", purpose=purpose).code == agy_policy.CODE_DIPLOMATIC
    assert d("core.gen", owner=False).code == agy_policy.CODE_STAFF_GEN
    assert "hộp riêng" in agy_policy.REASON_DIPLOMATIC


# ─── 16/10 · Telegram chỉ đề xuất ─────────────────────────────────────────────────────────────────────────────

_TELEGRAM_FORBIDDEN = ("write_kho", "kho_write", "confirm_proposal", "approve_draft", "verify_pin", "require_pin",
                       "mcp_write", "send_draft")


def test_telegram_modules_cannot_execute_writes() -> None:
    """16/10: Telegram chỉ ĐỀ XUẤT — không module nào của gh/telegram import/gọi đường ghi Kho, duyệt nháp, kiểm mã PIN
    (PIN không đi qua bên thứ ba). Quét mọi tệp trong gh/telegram (kể cả inbound/commands khi có). Ngoại lệ DUY NHẤT:
    `routes.py` (API cấu hình của Console, người dùng đã đăng nhập) được đòi mã PIN để đổi cấu hình Telegram."""
    bad: list[str] = []
    for path in sorted((GH_DIR / "telegram").rglob("*.py")):
        banned = tuple(w for w in _TELEGRAM_FORBIDDEN if not (path.name == "routes.py" and w == "require_pin"))
        for no, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            if re.match(r"\s*(from|import)\s", code) or "(" in code:
                bad += [f"{path.relative_to(ROOT)}:{no}: {w}" for w in banned if w in code]
    assert bad == []


# ─── 16/10 · Q5 / Q6 danh bạ & chế độ nghe ───────────────────────────────────────────────────────────────────

def test_q5_group_members_are_collected_for_every_group_including_off() -> None:
    """16/10 Q5 (=2): thu thành viên MỌI nhóm, kể cả "Không nghe" — nhập danh sách nhóm không xét `listen_mode`."""
    src = (GH_DIR / "data" / "ingest.py").read_text(encoding="utf-8")
    start = src.index("for m in (g.get(\"members\") or [])")
    block = src[max(0, start - 600): start + 600]
    assert "listen_mode" not in block
    assert "_member(db, row.id, ident.person_id)" in block


def test_q6_tagged_only_group_messages_are_still_stored() -> None:
    """16/10 Q6 (=1): "chỉ khi được tag" chỉ đổi cách TRẢ LỜI — tin của nhóm vẫn được lưu và phân tích (chỉ sửa chữ)."""
    from gh.data import common

    assert "tagged_only" in common.LISTENING_MODES
    assert "off" not in common.LISTENING_MODES and "paused" not in common.LISTENING_MODES


# ─── 16/10 · Q4 / Q7 ──────────────────────────────────────────────────────────────────────────────────────────

def test_q7_jev_stays_enabled_as_decided() -> None:
    """16/10 Q7 (=1): giữ Jev như hiện tại — lọc trước vẫn bật mặc định (mở băng QD-10/QD-13 được ghi nhận)."""
    from gh.refinery import triage

    assert triage.DEFAULTS["enabled"] is True
