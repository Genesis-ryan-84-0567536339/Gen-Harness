"""Kết quả kiểm thật từng dòng "Việc Sếp cần làm" (v0.1.39, bảng `ops.boss_checks` — migration 0025).

- Mỗi lần Sếp bấm Kiểm tra / Gọi thử / Đổi tài khoản (hoặc luồng đăng nhập CLI kết thúc) = MỘT bản ghi
  {check_key, status pass|fail|pending, error_code, message thân thiện, detail}. Giữ 50 bản mới nhất mỗi (org, key).
- Bí mật: KHÔNG lưu token/mật khẩu/cookie/giá trị mã đăng nhập. `detail` chỉ nhận khoá trong `DETAIL_KEYS`, `message`
  luôn qua `redact` (che token, email…). Email chỉ ở dạng che `b***@tên-miền`; email đầy đủ chỉ trả trong phản hồi
  API cho Owner. Mã đăng nhập chỉ lưu DẠNG (`code_shape`: độ dài, lớp ký tự, ký hiệu, có khoảng trắng).
- Không commit — bên gọi commit.
"""

import uuid
from datetime import datetime
from typing import Any

import orjson
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

CHECK_KEYS = ("hub", "facebook", "agy_login", "agy_call", "agy_switch", "claude_login", "claude_call", "jev",
              "telegram", "remote_access", "facebook_reply")
RUNNABLE = ("hub", "facebook", "agy_call", "agy_switch", "claude_call", "jev", "telegram", "remote_access")
STATUSES = ("pass", "fail", "pending")
KEEP_PER_KEY = 50
MESSAGE_MAX = 300
SWITCHES_NEEDED = 2

ROWS: tuple[dict[str, Any], ...] = (
    {"row": 1, "key": "hub", "title": "Gen-hub", "optional": False, "checks": ["hub"]},
    {"row": 2, "key": "facebook", "title": "Facebook", "optional": False, "checks": ["facebook"]},
    {"row": 3, "key": "agy", "title": "Google / Antigravity", "optional": False,
     "checks": ["agy_login", "agy_call", "agy_switch"]},
    {"row": 4, "key": "claude", "title": "Claude Code CLI", "optional": False,
     "checks": ["claude_login", "claude_call"]},
    {"row": 5, "key": "jev", "title": "Jev", "optional": True, "checks": ["jev"]},
    # v0.1.44 (F-8c): kênh "Báo động & bản tin" — đạt khi lần Gửi thử gần nhất tới được Telegram của Sếp.
    {"row": 6, "key": "telegram", "title": "Telegram (báo động & bản tin)", "optional": False,
     "checks": ["telegram"]},
    # v0.1.46 (F-21): Console mở được từ máy khác (điện thoại) bằng địa chỉ từ xa — kiểm theo Origin của lần bấm.
    {"row": 7, "key": "remote", "title": "Truy cập từ xa", "optional": False, "checks": ["remote_access"]},
    # v0.1.47 (F-79): Facebook trả lời — đạt khi một lượt trả lời bình luận thật đã gửi xong (không bắt buộc; không có
    # nút "Kiểm tra" riêng vì mỗi lần gửi phải do chính Sếp xác nhận + nhập PIN).
    {"row": 8, "key": "facebook_reply", "title": "Facebook trả lời", "optional": True, "checks": ["facebook_reply"]},
)
REQUIRED_TOTAL = sum(1 for r in ROWS if not r["optional"])

DETAIL_KEYS = frozenset({"latency_ms", "probe_model", "models_count", "models_source", "account_masked",
                         "expected_masked", "account_match", "code_shape", "credentials_file", "job_status",
                         "exposed_tools", "missing_tools", "target_profile", "from_profile",
                         "login_source", "bot_username", "chat_masked", "opened_from", "access_mode"})

SOCIAL_FAILED_MSG = "Lượt đọc Facebook chưa thành công — mở trang Mạng xã hội xem lý do rồi bấm Đọc ngay lần nữa"
SOCIAL_HALTED_MSG = ("Đọc mạng xã hội đang bị dừng (Dừng tất cả) — bật lại ở trang Tài khoản mạng xã hội rồi bấm "
                     "Đọc ngay")
SOCIAL_CANCELLED_MSG = "Lượt đọc Facebook đã bị huỷ — bấm Đọc ngay lần nữa"
SOCIAL_TIMEOUT_MSG = ("Lượt đọc Facebook chạy quá lâu nên đã dừng (trình duyệt nền không phản hồi) — mở trang "
                      "Tài khoản mạng xã hội xem rồi bấm Đọc ngay lần nữa")
SOCIAL_MISSING_MSG = "Không còn thấy lượt đọc Facebook này (có thể tài khoản đã bị gỡ) — bấm Đọc ngay lần nữa"


def mask_email(email: str | None) -> str | None:
    """'binh@example.vn' → 'b***@example.vn'. Không phải email → None (không bao giờ trả chuỗi gốc)."""
    if not email or "@" not in email:
        return None
    local, _, domain = email.strip().rpartition("@")
    if not local or not domain:
        return None
    return f"{local[0]}***@{domain}"


def code_shape(code: str) -> dict[str, Any]:
    """DẠNG của mã đăng nhập (không bao giờ lưu giá trị): độ dài, lớp ký tự, ký hiệu, có khoảng trắng hay không."""
    classes: set[str] = set()
    symbols: set[str] = set()
    has_space = False
    for ch in code:
        if ch.isspace():
            has_space = True
        elif ch.isdigit():
            classes.add("digit")
        elif ch.isalpha():
            classes.add("upper" if ch.isupper() else "lower")
        else:
            classes.add("symbol")
            symbols.add(ch)
    return {"length": len(code), "classes": sorted(classes), "symbols": "".join(sorted(symbols)),
            "has_space": has_space}


def clean_detail(detail: dict[str, Any] | None) -> dict[str, Any]:
    """Chỉ giữ khoá trong danh sách cho phép (khoá lạ có thể mang bí mật/email đầy đủ)."""
    return {k: v for k, v in (detail or {}).items() if k in DETAIL_KEYS}


def clean_message(message: str | None) -> str | None:
    if message is None:
        return None
    from gh.providers.clients import redact

    return redact(str(message), MESSAGE_MAX)[:MESSAGE_MAX]


def _iso(v: datetime | None) -> str | None:
    return v.isoformat().replace("+00:00", "Z") if v else None


async def record(db: AsyncSession, org_id: uuid.UUID, key: str, status: str, *, error_code: str | None = None,
                 message: str | None = None, detail: dict[str, Any] | None = None, user_id: uuid.UUID | None = None,
                 ref_id: uuid.UUID | None = None) -> dict[str, Any]:
    """Ghi một bản ghi kiểm + dọn bản cũ ngoài 50 bản mới nhất của (org, key). Không commit."""
    if key not in CHECK_KEYS:
        raise ValueError(f"check_key lạ: {key}")
    if status not in STATUSES:
        raise ValueError(f"status lạ: {status}")
    msg = clean_message(message)
    det = clean_detail(detail)
    row = (await db.execute(text("""
        INSERT INTO ops.boss_checks (org_id, check_key, status, error_code, message, detail, ref_id, checked_by)
        VALUES (:o, :k, :s, :c, :m, CAST(:d AS jsonb), :r, :u) RETURNING id, checked_at"""),
        {"o": org_id, "k": key, "s": status, "c": error_code, "m": msg, "d": orjson.dumps(det).decode(),
         "r": ref_id, "u": user_id})).one()
    await db.execute(text("""
        DELETE FROM ops.boss_checks WHERE org_id = :o AND check_key = :k AND id NOT IN (
          SELECT id FROM ops.boss_checks WHERE org_id = :o AND check_key = :k
          ORDER BY checked_at DESC, id DESC LIMIT :n)"""), {"o": org_id, "k": key, "n": KEEP_PER_KEY})
    runs = int((await db.execute(text("SELECT count(*) FROM ops.boss_checks WHERE org_id = :o AND check_key = :k"),
                                 {"o": org_id, "k": key})).scalar_one())
    return {"id": str(row.id), "key": key, "status": status, "error_code": error_code, "message": msg,
            "detail": det, "checked_at": _iso(row.checked_at), "runs": runs}


async def resolve_pending(db: AsyncSession, org_id: uuid.UUID) -> int:
    """Bản ghi facebook 'pending' (ref_id = việc đọc) → đọc agent.browser_jobs: done → pass; failed → fail
    (WORKER_TIMEOUT riêng); halted (Dừng tất cả) → SOCIAL_READ_HALTED; cancelled → SOCIAL_READ_CANCELLED; việc không
    còn → fail SOCIAL_JOB_MISSING. Cập nhật tại chỗ, trả số bản ghi đã chốt. Không commit.

    Việc còn 'queued'/'running' quá `social.service.STALE_AFTER` (worker trình duyệt chết/chưa chạy) được ĐÓNG ngay tại
    đây giống `social.active_job` (failed + WORKER_TIMEOUT) — nếu không, ô Facebook kẹt "Đang chạy…" mãi vì nút Đọc ngay
    bị tắt khi đang chờ và `active_job` chỉ chạy khi có lượt đọc mới.
    Không chép `job.error` thô (có thể mang dữ liệu trang) — chỉ câu thân thiện + mã."""
    from gh.social.service import STALE_AFTER

    await db.execute(text("""
        UPDATE agent.browser_jobs j SET status = 'failed', error = 'WORKER_TIMEOUT', finished_at = now()
        FROM ops.boss_checks b
        WHERE b.org_id = :o AND b.check_key = 'facebook' AND b.status = 'pending' AND j.id = b.ref_id
          AND j.org_id = b.org_id AND j.status IN ('queued', 'running')
          AND j.created_at < now() - make_interval(secs => :s)"""),
        {"o": org_id, "s": STALE_AFTER.total_seconds()})
    rows = (await db.execute(text("""
        SELECT b.id, b.detail, j.status AS job_status, j.error AS job_error, (j.id IS NOT NULL) AS has_job
        FROM ops.boss_checks b LEFT JOIN agent.browser_jobs j ON j.id = b.ref_id AND j.org_id = b.org_id
        WHERE b.org_id = :o AND b.check_key = 'facebook' AND b.status = 'pending' AND b.ref_id IS NOT NULL"""),
        {"o": org_id})).all()
    n = 0
    for r in rows:
        detail = clean_detail(dict(r.detail or {}))
        if r.has_job:
            detail["job_status"] = r.job_status
        if not r.has_job:
            status, code, msg = "fail", "SOCIAL_JOB_MISSING", SOCIAL_MISSING_MSG
        elif r.job_status == "done":
            status, code, msg = "pass", None, None
        elif r.job_status == "failed" and r.job_error == "WORKER_TIMEOUT":
            status, code, msg = "fail", "WORKER_TIMEOUT", SOCIAL_TIMEOUT_MSG
        elif r.job_status == "failed":
            status, code, msg = "fail", "SOCIAL_READ_FAILED", SOCIAL_FAILED_MSG
        elif r.job_status == "halted":
            status, code, msg = "fail", "SOCIAL_READ_HALTED", SOCIAL_HALTED_MSG
        elif r.job_status == "cancelled":
            status, code, msg = "fail", "SOCIAL_READ_CANCELLED", SOCIAL_CANCELLED_MSG
        else:
            # Còn đang xếp hàng/chạy: chỉ cập nhật trạng thái việc để web hiện "Đang chạy…".
            await db.execute(text("UPDATE ops.boss_checks SET detail = CAST(:d AS jsonb) WHERE id = :i"),
                             {"d": orjson.dumps(detail).decode(), "i": r.id})
            continue
        await db.execute(text("""UPDATE ops.boss_checks SET status = :s, error_code = :c, message = :m,
                                 detail = CAST(:d AS jsonb) WHERE id = :i"""),
                         {"s": status, "c": code, "m": msg, "d": orjson.dumps(detail).decode(), "i": r.id})
        n += 1
    return n


async def latest(db: AsyncSession, org_id: uuid.UUID) -> dict[str, dict[str, Any] | None]:
    """{check_key: bản ghi mới nhất (kèm `runs` = số bản ghi đang giữ) | None}."""
    rows = (await db.execute(text("""
        SELECT DISTINCT ON (check_key) check_key, status, error_code, message, detail, checked_at,
               count(*) OVER (PARTITION BY check_key) AS runs
        FROM ops.boss_checks WHERE org_id = :o
        ORDER BY check_key, checked_at DESC, id DESC"""), {"o": org_id})).all()
    out: dict[str, dict[str, Any] | None] = dict.fromkeys(CHECK_KEYS)
    for r in rows:
        if r.check_key in out:
            out[r.check_key] = {"key": r.check_key, "status": r.status, "error_code": r.error_code,
                                "message": r.message, "detail": dict(r.detail or {}),
                                "checked_at": _iso(r.checked_at), "runs": int(r.runs)}
    return out


async def pass_count(db: AsyncSession, org_id: uuid.UUID, key: str) -> int:
    return int((await db.execute(text("""SELECT count(*) FROM ops.boss_checks WHERE org_id = :o AND check_key = :k
                                         AND status = 'pass'"""), {"o": org_id, "k": key})).scalar_one())


async def switch_passes(db: AsyncSession, org_id: uuid.UUID) -> int:
    """Số lần ĐỔI THẬT đã đạt, theo thời gian:

    - bản ghi có `from_profile` (hồ sơ đang hoạt động NGAY TRƯỚC khi đổi, từ v0.1.39 sau review): chỉ đếm khi
      `from_profile` ≠ `target_profile` — "đổi" sang chính tài khoản đang dùng không đổi gì cả (F-76);
    - bản ghi cũ không có `from_profile`: đếm khi tài khoản đích KHÁC lượt đạt ngay trước. Tài khoản đích =
      `target_profile` (hồ sơ), thiếu thì email đã che; không có cả hai → coi là khác."""
    rows = (await db.execute(text("""
        SELECT id, COALESCE(detail->>'target_profile', detail->>'expected_masked') AS target,
               detail->>'from_profile' AS source, (detail->'from_profile' IS NOT NULL) AS has_source
        FROM ops.boss_checks WHERE org_id = :o AND check_key = 'agy_switch' AND status = 'pass'
        ORDER BY checked_at, id"""), {"o": org_id})).all()
    n, prev = 0, None
    for r in rows:
        target = r.target or f"row:{r.id}"
        if r.has_source:
            # from_profile null = chưa có hồ sơ nào hoạt động trước đó → vẫn là một lần đổi thật.
            if r.source != target:
                n += 1
        elif target != prev:
            n += 1
        prev = target
    return n


def _passed(results: dict[str, dict[str, Any] | None], key: str) -> bool:
    r = results.get(key)
    return r is not None and r["status"] == "pass"


async def overview(db: AsyncSession, org_id: uuid.UUID) -> dict[str, Any]:
    """Quy tắc 'done': hub/facebook/jev = kiểm tương ứng đạt; agy = agy_call đạt VÀ ≥2 lần đổi tài khoản THẬT đạt
    (`switch_passes` — đổi qua lại giữa hai tài khoản); claude = claude_login đạt VÀ claude_call đạt.

    `switch_passes` trả kèm cho web (bộ đếm "Đã đổi qua lại x/2 lần"): `results.agy_switch.runs` đếm MỌI bản ghi, cả
    lượt lỗi, nên không dùng được cho bộ đếm."""
    results = await latest(db, org_id)
    switches = await switch_passes(db, org_id)
    rows: list[dict[str, Any]] = []
    for row in ROWS:
        if row["key"] == "agy":
            done = _passed(results, "agy_call") and switches >= SWITCHES_NEEDED
        elif row["key"] == "claude":
            done = _passed(results, "claude_login") and _passed(results, "claude_call")
        else:
            done = _passed(results, row["checks"][0])
        rows.append({**row, "checks": list(row["checks"]), "done": done})
    required_done = sum(1 for r in rows if r["done"] and not r["optional"])
    return {"rows": rows, "results": results, "required_done": required_done, "required_total": REQUIRED_TOTAL,
            "switch_passes": switches}
