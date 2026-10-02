"""Antigravity CLI: đăng nhập trong container, nhiều hồ sơ, đổi tài khoản (quyết định Q6, ARCHITECTURE §11).

- Đăng nhập: chạy `agy` tương tác trong một pseudo-terminal với môi trường "SSH" để CLI in link xác thực và chờ dán
  mã (tài liệu chính thức: đăng nhập qua SSH). Link đẩy lên Console qua WebSocket `cli.login`; Owner dán mã vào
  Console → ghi vào terminal. Xong khi tệp phiên xuất hiện; tệp được mã hoá và lưu vào agent.cli_profiles.
- Đổi tài khoản (như heo-harness): ghi tệp phiên của hồ sơ được chọn vào thư mục cấu hình CLI (volume chung
  api/worker). Trước khi đổi, tệp hiện tại được lưu lại vào hồ sơ cũ (CLI có thể đã làm mới token).
- Thêm tài khoản khi ĐANG đăng nhập (v0.1.30): CLI thấy tệp phiên thì vào thẳng chat, không bao giờ in link đăng
  nhập (và còn ghi lại tệp khi làm mới token → trước đây Console tưởng "xong" với chính tài khoản cũ). Vì vậy trước
  khi chạy CLI, tệp phiên hiện tại được "gửi tạm" sang `<tệp>.before-login`; đăng nhập xong thì bỏ bản gửi tạm,
  lỗi/huỷ/quá giờ thì trả bản gửi tạm về chỗ cũ (tài khoản đang dùng không đổi).
- v0.1.31: cùng cơ chế cho Claude Code CLI (`claude auth login --claudeai`, gói Claude của Owner — QD-12 "Owner tự
  quyết"). Mỗi loại CLI (`CliSpec`) có thư mục phiên, tệp phiên và hồ sơ riêng (agent.cli_profiles theo provider).
  Phiên Claude = `.credentials.json` + mục `oauthAccount` của `.claude.json` (email), lưu thành một gói JSON.
- Trạng thái MỘT sự thật (v0.1.31): token truy cập ngắn hạn quá hạn nhưng còn refresh token thì CLI tự làm mới →
  vẫn "Đang hoạt động"; chỉ "Hết hạn" khi không làm mới được hoặc lượt gọi thật gần nhất báo lỗi xác thực.
"""

import asyncio
import base64
import contextlib
import fcntl
import logging
import os
import re
import shutil
import signal
import struct
import termios
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import orjson
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from gh import crypto, realtime
from gh.chassis import actionlog
from gh.config import get_settings
from gh.providers.clients import (
    CLAUDE_CRED_FILE,
    CLAUDE_STATE_FILE,
    TOKEN_FILE,
    claude_env,
    cli_env,
    cli_home_dir,
)

CLI_MISSING = "Máy chủ chưa cài công cụ đăng nhập Google (Antigravity CLI) — dùng khoá API ở bên dưới thay thế"
CLAUDE_MISSING = "Máy chủ chưa cài Claude Code CLI — cập nhật Gen-Harness bản mới rồi thử lại"
AGY = "antigravity_cli"
CLAUDE = "claude_code_cli"
CLI_KINDS = (AGY, CLAUDE)


@dataclass(frozen=True)
class CliSpec:
    kind: str
    name: str
    token_file: str
    missing: str

    def home(self) -> Path:
        s = get_settings()
        return cli_home_dir(s.claude_home if self.kind == CLAUDE else s.cli_home)

    def env(self) -> dict[str, str]:
        s = get_settings()
        return claude_env(s.claude_home) if self.kind == CLAUDE else cli_env(s.cli_home)


SPECS = {AGY: CliSpec(AGY, "Antigravity CLI", TOKEN_FILE, CLI_MISSING),
         CLAUDE: CliSpec(CLAUDE, "Claude Code CLI", CLAUDE_CRED_FILE, CLAUDE_MISSING)}


def spec(kind: str) -> CliSpec:
    return SPECS[kind]
log = logging.getLogger("gh.cli")

CLI_AAD = b"cli_token"
LOGIN_TIMEOUT_S = 600
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r")
_URL = re.compile(r"https://[^\s\"'<>]+")
_PROMPT_YN = re.compile(r"\[(?:y/n|Y/n|y/N)\]|\((?:y/n|Y/n|y/N)\)", re.I)
_PROMPT_ENTER = re.compile(r"(trust|accept|agree|continue|press enter|terms)", re.I)
_MENU_OAUTH = re.compile(r"google\s+oauth|sign in with google|login with google", re.I)
# Link đầy đủ nằm trong hyperlink OSC 8 ("Click here to authenticate"); bản chữ bị cắt xuống nhiều dòng.
_OSC8_URL = re.compile(r"\x1b\]8;[^;\x07\x1b]*;(https://[^\x07\x1b]+)")
# CLI (TUI) hỏi terminal rồi CHỜ trả lời trước khi vẽ gì — không trả lời thì treo mãi, không bao giờ in link.
_TERM_REPLIES = (
    (b"\x1b[>c", b"\x1b[>1;10;0c"),     # Secondary Device Attributes
    (b"\x1b[>0c", b"\x1b[>1;10;0c"),
    (b"\x1b[c", b"\x1b[?62;22c"),       # Primary Device Attributes
    (b"\x1b[0c", b"\x1b[?62;22c"),
    (b"\x1b[?u", b"\x1b[?0u"),          # kitty keyboard protocol
    (b"\x1b[6n", b"\x1b[1;1R"),         # vị trí con trỏ
)
PTY_COLS, PTY_ROWS = 1000, 50


def terminal_replies(chunk: bytes) -> bytes:
    """Câu trả lời cho các truy vấn terminal có trong chunk (giả làm một xterm)."""
    return b"".join(reply for query, reply in _TERM_REPLIES if query in chunk)


def login_url(raw_text: str, plain_text: str) -> str | None:
    """Ưu tiên link trong hyperlink OSC 8 (đầy đủ), rồi mới tới link trong chữ đã bỏ mã điều khiển."""
    m = _OSC8_URL.search(raw_text)
    if m:
        return m.group(1)
    m = _URL.search(plain_text)
    return m.group(0).rstrip(".,)") if m else None


def token_path(kind: str = AGY) -> Path:
    return spec(kind).home() / spec(kind).token_file


PARK_SUFFIX = ".before-login"


def backup_path(kind: str = AGY) -> Path:
    path = token_path(kind)
    return path.with_name(path.name + PARK_SUFFIX)


def park_token(kind: str = AGY) -> None:
    """Gửi tạm tệp phiên đang dùng để CLI khởi động ở trạng thái CHƯA đăng nhập (mới hiện link đăng nhập)."""
    path = token_path(kind)
    if path.exists():
        path.replace(backup_path(kind))


def unpark_token(kind: str = AGY) -> bool:
    """Trả tệp phiên đã gửi tạm về chỗ cũ (đăng nhập lỗi/huỷ, hoặc api chết giữa chừng). True nếu có trả."""
    bak = backup_path(kind)
    if not bak.exists():
        return False
    bak.replace(token_path(kind))
    return True


def drop_parked_token(kind: str = AGY) -> None:
    with contextlib.suppress(FileNotFoundError):
        backup_path(kind).unlink()


# ─── Gói phiên theo loại CLI ───────────────────────────────────────────────

def _json(raw: bytes | str | None) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def read_session(kind: str = AGY) -> bytes | None:
    """Phiên đang dùng trong thư mục CLI dưới dạng bytes để mã hoá vào hồ sơ (agy: chính tệp token; Claude: gói
    {credentials, oauthAccount})."""
    path = token_path(kind)
    if not path.exists():
        return None
    raw = path.read_bytes()
    if kind != CLAUDE:
        return raw
    state = _json((path.parent / CLAUDE_STATE_FILE).read_bytes()) if (path.parent / CLAUDE_STATE_FILE).exists() else {}
    return orjson.dumps({"credentials": _json(raw), "oauthAccount": state.get("oauthAccount")})


def write_session(kind: str, raw: bytes) -> None:
    if kind != CLAUDE:
        write_token_file(raw)
        return
    bundle = _json(raw)
    path = token_path(kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, orjson.dumps(bundle.get("credentials") or {}))
    state_path = path.parent / CLAUDE_STATE_FILE
    state = _json(state_path.read_bytes()) if state_path.exists() else {}
    if bundle.get("oauthAccount"):
        state["oauthAccount"] = bundle["oauthAccount"]
    else:
        state.pop("oauthAccount", None)
    _atomic_write(state_path, orjson.dumps(state))


def session_email(kind: str, raw: bytes) -> str | None:
    if kind != CLAUDE:
        return file_email(raw)
    acct = _json(raw).get("oauthAccount") or {}
    email = acct.get("emailAddress") if isinstance(acct, dict) else None
    return email if isinstance(email, str) else None


def session_meta(kind: str, raw: bytes) -> dict[str, Any]:
    """{expires_at, refreshable, plan} đọc từ gói phiên (không gọi mạng)."""
    if kind == CLAUDE:
        oauth = (_json(raw).get("credentials") or {}).get("claudeAiOauth") or {}
        exp = oauth.get("expiresAt")
        expires_at = datetime.fromtimestamp(exp / 1000, UTC) if isinstance(exp, (int, float)) and exp > 0 else None
        plan = oauth.get("subscriptionType")
        return {"expires_at": expires_at, "refreshable": bool(oauth.get("refreshToken")),
                "plan": f"Claude {str(plan).capitalize()}" if plan else None}
    data = _json(raw)
    exp = data.get("expiry") or data.get("expires_at") or _claims(data.get("id_token")).get("exp")
    expires_at = None
    if isinstance(exp, (int, float)):
        expires_at = datetime.fromtimestamp(exp, UTC)
    elif isinstance(exp, str):
        with contextlib.suppress(ValueError):
            expires_at = datetime.fromisoformat(exp.replace("Z", "+00:00"))
    return {"expires_at": expires_at, "refreshable": bool(data.get("refresh_token")), "plan": None}


def _claims(id_token: str | None) -> dict[str, Any]:
    if not id_token or id_token.count(".") < 2:
        return {}
    part = id_token.split(".")[1]
    part += "=" * (-len(part) % 4)
    try:
        data = orjson.loads(base64.urlsafe_b64decode(part))
    except (ValueError, orjson.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def file_email(raw: bytes) -> str | None:
    """Email trong id_token của tệp phiên (không gọi mạng); None nếu không đọc được."""
    try:
        data = orjson.loads(raw)
    except orjson.JSONDecodeError:
        return None
    email = _claims(data.get("id_token")).get("email") if isinstance(data, dict) else None
    return email if isinstance(email, str) else None


async def token_identity(raw: bytes, transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
    """Email + hạn của tệp phiên: đọc id_token nếu có (như heo-harness), không có thì hỏi userinfo của Google."""
    try:
        data = orjson.loads(raw)
    except orjson.JSONDecodeError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    claims = _claims(data.get("id_token"))
    email = claims.get("email")
    exp = data.get("expiry") or data.get("expires_at") or claims.get("exp")
    if not email and data.get("access_token"):
        with contextlib.suppress(Exception):
            async with httpx.AsyncClient(transport=transport, timeout=10) as c:
                r = await c.get("https://openidconnect.googleapis.com/v1/userinfo",
                                headers={"authorization": f"Bearer {data['access_token']}"})
                if r.status_code == 200:
                    email = r.json().get("email")
    expires_at = None
    if isinstance(exp, (int, float)):
        expires_at = datetime.fromtimestamp(exp, UTC)
    elif isinstance(exp, str):
        with contextlib.suppress(ValueError):
            expires_at = datetime.fromisoformat(exp.replace("Z", "+00:00"))
    return {"email": email, "expires_at": expires_at}


async def cli_provider_id(db: AsyncSession, org_id: uuid.UUID, kind: str = AGY) -> uuid.UUID:
    pid = (await db.execute(text("""SELECT id FROM agent.providers WHERE org_id = :o AND kind = :k
                                    ORDER BY created_at LIMIT 1"""), {"o": org_id, "k": kind})).scalar_one_or_none()
    if pid is None:
        rank = (await db.execute(text("""SELECT COALESCE(max(failover_rank), 0) + 1 FROM agent.providers
                                         WHERE org_id = :o"""), {"o": org_id})).scalar_one()
        pid = (await db.execute(text("""INSERT INTO agent.providers (org_id, kind, name, failover_rank)
                                        VALUES (:o, :k, :n, :r) RETURNING id"""),
                                {"o": org_id, "k": kind, "n": spec(kind).name, "r": rank})).scalar_one()
    return pid  # type: ignore[no-any-return]


def profile_state(expires_at: datetime | None, *, refreshable: bool = False, auth_state: str | None = None,
                  active: bool = False) -> str:
    """MỘT sự thật cho thẻ tài khoản và dòng nguồn (v0.1.31, Boss: thẻ "Hết hạn" mà dòng nguồn "Gọi thử OK").

    - Hồ sơ đang dùng mà lượt gọi thật gần nhất báo lỗi xác thực (`auth_state = expired`) → "expired" (đăng nhập lại).
    - Token truy cập ngắn hạn quá hạn NHƯNG còn refresh token → CLI tự làm mới → "ok".
    - Không làm mới được: quá hạn → "expired", còn dưới 1 giờ → "expiring"."""
    if active and auth_state == "expired":
        return "expired"
    if expires_at is None or refreshable:
        return "ok"
    left = (expires_at - datetime.now(UTC)).total_seconds()
    return "expired" if left <= 0 else "expiring" if left < 3600 else "ok"


async def profiles(db: AsyncSession, org_id: uuid.UUID, kind: str = AGY) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""SELECT c.id, c.email, c.plan_label, c.is_active, c.expires_at, c.created_at,
                                            c.token_enc, p.auth_state
                                     FROM agent.cli_profiles c JOIN agent.providers p ON p.id = c.provider_id
                                     WHERE c.org_id = :o AND p.kind = :k ORDER BY c.created_at"""),
                             {"o": org_id, "k": kind})).all()
    out = []
    for r in rows:
        meta: dict[str, Any] = {"refreshable": False}
        if r.token_enc is not None:
            with contextlib.suppress(Exception):
                meta = session_meta(kind, crypto.decrypt(bytes(r.token_enc), CLI_AAD))
        out.append({"id": str(r.id), "kind": kind, "email": r.email, "plan_label": r.plan_label,
                    "active": r.is_active,
                    "expires_at": r.expires_at.isoformat().replace("+00:00", "Z") if r.expires_at else None,
                    "refreshable": bool(meta.get("refreshable")),
                    "state": profile_state(r.expires_at, refreshable=bool(meta.get("refreshable")),
                                           auth_state=r.auth_state, active=r.is_active)})
    return out


def _atomic_write(path: Path, raw: bytes) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(raw)
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def write_token_file(raw: bytes) -> None:
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(path, raw)


async def save_current_back(db: AsyncSession, org_id: uuid.UUID, kind: str = AGY) -> None:
    """Lưu tệp phiên đang dùng (có thể đã được CLI làm mới) vào hồ sơ đang hoạt động của đúng loại CLI."""
    raw = read_session(kind)
    if raw is None:
        return
    email = session_email(kind, raw)
    meta = session_meta(kind, raw)
    # Tệp của tài khoản KHÁC (id_token ghi rõ email khác) thì không ghi đè lên hồ sơ đang hoạt động.
    await db.execute(text("""UPDATE agent.cli_profiles c SET token_enc = :t, updated_at = now(),
                                    expires_at = COALESCE(CAST(:x AS timestamptz), c.expires_at)
                             FROM agent.providers p
                             WHERE p.id = c.provider_id AND p.kind = :k AND c.org_id = :o AND c.is_active
                               AND (CAST(:e AS text) IS NULL OR c.email IS NULL OR c.email = CAST(:e AS citext))"""),
                     {"t": crypto.encrypt(raw, CLI_AAD), "o": org_id, "e": email, "k": kind,
                      "x": meta.get("expires_at")})


async def activate(db: AsyncSession, org_id: uuid.UUID, profile_id: uuid.UUID) -> dict[str, Any]:
    from gh.errors import conflict, not_found

    row = (await db.execute(text("""SELECT c.id, c.provider_id, c.email, c.token_enc, c.expires_at, p.kind
                                    FROM agent.cli_profiles c JOIN agent.providers p ON p.id = c.provider_id
                                    WHERE c.id = :i AND c.org_id = :o"""),
                            {"i": profile_id, "o": org_id})).one_or_none()
    if row is None:
        raise not_found("Tài khoản của CLI")
    if row.token_enc is None:
        # Trước đây: chỉ đổi cờ trong CSDL, tệp phiên giữ nguyên → UI báo "đã đổi" mà AI vẫn chạy tài khoản cũ.
        raise conflict("CLI_PROFILE_NO_SESSION",
                       "Tài khoản này chưa có phiên đăng nhập đã lưu — bấm “Thêm tài khoản” để đăng nhập lại")
    try:
        token = crypto.decrypt(bytes(row.token_enc), CLI_AAD)
    except Exception as exc:  # noqa: BLE001 — khoá master đổi / dữ liệu hỏng
        raise conflict("CLI_PROFILE_NO_SESSION",
                       "Không mở được phiên đã lưu của tài khoản này — hãy đăng nhập lại tài khoản đó") from exc
    await save_current_back(db, org_id, row.kind)
    await db.execute(text("UPDATE agent.cli_profiles SET is_active = false WHERE provider_id = :p AND is_active"),
                     {"p": row.provider_id})
    await db.execute(text("UPDATE agent.cli_profiles SET is_active = true, updated_at = now() WHERE id = :i"),
                     {"i": row.id})
    await db.execute(text("""UPDATE agent.providers SET account_label = :e, auth_state = 'ok', auth_expires_at = :x
                             WHERE id = :p"""),
                     {"e": row.email, "x": row.expires_at, "p": row.provider_id})
    # Worker gọi CLI mới cho MỖI lượt, đọc tệp này từ volume chung → lượt kế tiếp dùng tài khoản vừa chọn.
    write_session(row.kind, token)
    return {"id": str(row.id), "email": row.email, "kind": row.kind}


async def delete_profile(db: AsyncSession, org_id: uuid.UUID, profile_id: uuid.UUID) -> dict[str, Any]:
    row = (await db.execute(text("""DELETE FROM agent.cli_profiles c USING agent.providers p
                                    WHERE c.id = :i AND c.org_id = :o AND p.id = c.provider_id
                                    RETURNING c.provider_id, c.email, c.is_active, p.kind"""),
                            {"i": profile_id, "o": org_id})).one_or_none()
    if row is None:
        from gh.errors import not_found

        raise not_found("Hồ sơ CLI")
    if row.is_active:
        # Đăng xuất = xoá tệp phiên (như heo-harness).
        with contextlib.suppress(FileNotFoundError):
            token_path(row.kind).unlink()
        await db.execute(text("""UPDATE agent.providers SET account_label = NULL, auth_state = 'unconfigured'
                                 WHERE id = :p"""), {"p": row.provider_id})
    return {"email": row.email, "was_active": row.is_active, "kind": row.kind}


CLAUDE_HOME_SHARED_MSG = "GH_CLAUDE_HOME nằm trong HOME của Antigravity CLI — agy có thể đọc phiên Claude"
CLAUDE_HOME_SHARED_KEY = "cli.claude_home_shared"


def _agy_home() -> Path:
    return Path(cli_env(get_settings().cli_home)["HOME"])


def _inside(path: Path, parent: Path) -> bool:
    return path == parent or parent in path.parents


def _remove(p: Path) -> None:
    if p.is_dir() and not p.is_symlink():
        shutil.rmtree(p)
    elif p.exists() or p.is_symlink():
        p.unlink()


def _copy_into(item: Path, dest: Path) -> None:
    """Chép `item` sang `dest` an toàn khi đứt giữa chừng: chép vào `<dest>.migrating` rồi `os.replace` — đích không
    bao giờ là bản dở. Hai volume khác nhau nên không dùng `rename`/`shutil.move` (= chép rồi xoá, không nguyên tử)."""
    tmp = dest.with_name(dest.name + ".migrating")
    _remove(tmp)
    try:
        if item.is_symlink():
            os.symlink(os.readlink(item), tmp)
        elif item.is_dir():
            shutil.copytree(item, tmp, symlinks=True)
            tmp.chmod(0o700)
        else:
            shutil.copy2(item, tmp)
            tmp.chmod(0o600)
        os.replace(tmp, dest)
    except OSError:
        with contextlib.suppress(OSError):
            _remove(tmp)
        raise


def legacy_claude_pending() -> bool:
    """True khi còn thư mục phiên Claude cũ (GH_CLAUDE_LEGACY_HOME) chờ api chuyển (F-22). Worker dùng để KHÔNG tự ghi
    tệp phiên Claude từ hồ sơ trước khi api chuyển — bản trong CSDL là ảnh lúc đăng nhập, có thể cũ hơn tệp CLI đã tự
    làm mới; ghi trước thì api thấy đích đã có và bỏ qua bản mới."""
    s = get_settings()
    if not s.claude_legacy_home.strip():
        return False
    with contextlib.suppress(OSError):
        legacy = cli_home_dir(s.claude_legacy_home)
        return legacy.is_dir() and not legacy.is_symlink()
    return False


def _legacy_session_newer(item: Path, dest: Path) -> bool:
    """Tệp phiên (`.credentials.json`/`.claude.json`) cũ mới hơn tệp ở đích (vd. đích là bản ghi lại từ hồ sơ lúc đăng
    nhập, còn bản cũ đã được CLI làm mới token) ⇒ bản cũ được ghi đè lên đích. Mục khác: đích đã có thì giữ."""
    if item.name not in (CLAUDE_CRED_FILE, CLAUDE_STATE_FILE):
        return False
    try:
        if item.is_symlink() or not item.is_file() or dest.is_symlink() or not dest.is_file():
            return False
        return item.stat().st_mtime > dest.stat().st_mtime
    except OSError:
        return False


def migrate_legacy_claude_home() -> int:
    """F-22 (v0.1.38): chuyển phiên Claude Code từ đường dẫn cũ (≤ v0.1.37: `/var/lib/gh/agy/claude/.claude`, nằm trong
    volume agy_state — agy có công cụ đọc tệp nên đọc được `.credentials.json`) sang GH_CLAUDE_HOME mới (volume
    claude_state). Trả số mục đã chuyển.

    Đường dẫn cũ CHỈ lấy từ GH_CLAUDE_LEGACY_HOME (chỉ đặt trong api.Dockerfile). Rỗng (dev, pytest) ⇒ không làm gì:
    ngoài Docker HOME của agy là HOME thật của người dùng, `~/claude/.claude` có thể là thư mục dự án của họ.

    Chỉ api gọi (đầu `restore_active`, `owns_logins=True`), trước khi trả bản gửi tạm/ghi lại phiên. Tệp/thư mục đã có
    ở đích (vd. phiên mới hơn) KHÔNG bị bản cũ ghi đè — trừ `.credentials.json`/`.claude.json` cũ có mtime mới hơn
    đích (CLI đã tự làm mới token). Mỗi mục chép vào tên tạm rồi `os.replace`; CHỈ khi mọi mục đều xong mới xoá
    đúng thư mục cũ và `<cha>/work` (thư mục làm việc cũ của claude), rồi `rmdir` thư mục cha nếu đã rỗng (còn mục
    khác ⇒ chỉ ghi TÊN chúng vào log) — không bao giờ xoá cả thư mục cha. Có lỗi ⇒ giữ nguyên thư mục cũ, lần
    khởi động sau làm tiếp. Chạy lại an toàn.
    Lỗi OSError chỉ ghi cảnh báo (không làm sập api); tệp còn thiếu thì `restore_active` ghi lại từ agent.cli_profiles.
    Rollback về v0.1.37: bản cũ thấy thiếu tệp ở đường dẫn cũ ⇒ restore_active của nó ghi lại từ CSDL ⇒ vẫn an toàn.
    Không bao giờ log nội dung tệp — chỉ số mục."""
    s = get_settings()
    if not s.claude_legacy_home.strip():
        return 0
    target = cli_home_dir(s.claude_home)
    legacy = cli_home_dir(s.claude_legacy_home)
    moved = 0
    try:
        if not legacy.is_dir() or legacy.is_symlink():
            return 0
        legacy_r, target_r = legacy.resolve(), target.resolve()
        if legacy_r == target_r or _inside(target_r, legacy_r) or _inside(legacy_r, target_r):
            return 0
        target.mkdir(parents=True, exist_ok=True)
        failed = 0
        for item in sorted(legacy.iterdir()):
            if item.name.endswith(".migrating"):
                continue
            dest = target / item.name
            if (dest.exists() or dest.is_symlink()) and not _legacy_session_newer(item, dest):
                continue
            try:
                _copy_into(item, dest)
                moved += 1
            except OSError as exc:
                failed += 1
                log.warning("Chuyển một mục phiên Claude Code lỗi (%s) — giữ thư mục cũ, thử lại lần khởi động sau",
                            type(exc).__name__)
        if failed:
            return moved
        shutil.rmtree(legacy)
        work = legacy.parent / "work"
        if work.is_dir() and not work.is_symlink():
            shutil.rmtree(work)
        try:
            legacy.parent.rmdir()  # chỉ khi đã rỗng
        except OSError:
            # Không xoá thay (có thể là dự án của người dùng) — chỉ ghi TÊN các mục còn lại để Owner/hỗ trợ dọn tay.
            with contextlib.suppress(OSError):
                left = sorted(p.name for p in legacy.parent.iterdir())
                if left:
                    log.warning("Thư mục phiên Claude Code cũ %s còn %d mục không thuộc phiên đã chuyển: %s",
                                legacy.parent, len(left), ", ".join(left[:20]))
        log.info("Đã chuyển %d mục phiên Claude Code sang thư mục riêng (F-22)", moved)
    except OSError as exc:
        log.warning("Chuyển phiên Claude Code sang thư mục riêng lỗi (%s) — sẽ ghi lại từ hồ sơ đã lưu",
                    type(exc).__name__)
    return moved


def claude_home_shared() -> bool:
    """True khi GH_CLAUDE_HOME nằm trong HOME của Antigravity CLI (agy có thể đọc phiên Claude)."""
    try:
        return _inside(cli_home_dir(get_settings().claude_home).resolve(), _agy_home().resolve())
    except OSError:
        return False


async def _report_claude_home(sm: async_sessionmaker[AsyncSession] | None, shared: bool) -> None:
    """Mở/đóng sự cố `cli.claude_home_shared` cho từng tổ chức (gh.health — v0.1.36). Lỗi thì bỏ qua."""
    if sm is None:
        return
    from gh import health

    try:
        async with sm() as db:
            orgs = (await db.execute(text("SELECT id FROM core.organizations"))).scalars().all()
            for org_id in orgs:
                if shared:
                    await health.raise_once(
                        db, org_id, key=CLAUDE_HOME_SHARED_KEY, kind=CLAUDE_HOME_SHARED_KEY, severity="bad",
                        title="Phiên Claude Code nằm chung chỗ với Antigravity CLI",
                        body="Antigravity CLI có thể đọc phiên đăng nhập đã lưu của Claude Code. Cập nhật Gen-Harness "
                             "bản mới (dùng volume claude_state riêng). Chi tiết kỹ thuật: " + CLAUDE_HOME_SHARED_MSG,
                        link=None)
                else:
                    await health.clear(db, org_id, CLAUDE_HOME_SHARED_KEY)
            await db.commit()
    except Exception as exc:  # noqa: BLE001 — báo sự cố là phụ, không làm hỏng khởi động
        log.warning("Không ghi được sự cố %s: %s", CLAUDE_HOME_SHARED_KEY, type(exc).__name__)


async def restore_active(sm: async_sessionmaker[AsyncSession] | None, *, owns_logins: bool = True) -> None:
    """Khi khởi động: tệp phiên trong volume trống mà có hồ sơ hoạt động → ghi lại tệp (từng loại CLI).

    Còn bản "gửi tạm" (api chết giữa lúc thêm tài khoản) thì api trả nó về trước — đó là tài khoản đang dùng. Worker
    (`owns_logins=False`) không đụng tới khi còn bản gửi tạm: có thể api đang chạy một phiên đăng nhập, ghi tệp lúc đó
    sẽ bị nhận nhầm là tài khoản mới.

    F-22: api chuyển phiên Claude từ đường dẫn cũ trong HOME của agy sang GH_CLAUDE_HOME riêng TRƯỚC mọi bước khác
    (`migrate_legacy_claude_home`); tệp còn thiếu sau đó được ghi lại từ hồ sơ như thường."""
    if owns_logins:
        migrate_legacy_claude_home()
        shared = claude_home_shared()
        if shared and get_settings().env == "development":
            # Dev ngoài Docker: HOME của agy là HOME thật (~) nên mọi GH_CLAUDE_HOME mặc định đều "chung" — chỉ nhắc,
            # không mở sự cố đỏ cho mọi tổ chức mỗi lần khởi động (production/test vẫn báo đầy đủ).
            log.warning(CLAUDE_HOME_SHARED_MSG + " (môi trường phát triển — đặt GH_CLI_HOME riêng nếu cần tách)")
            shared = False
        elif shared:
            log.error(CLAUDE_HOME_SHARED_MSG)
        await _report_claude_home(sm, shared)
    need: list[str] = []
    for kind in CLI_KINDS:
        if owns_logins:
            # api vừa khởi động ⇒ không còn phiên đăng nhập nào. Bản gửi tạm là tài khoản đang hoạt động trong CSDL;
            # tệp phiên (nếu có) là của lượt đăng nhập dở ⇒ trả bản gửi tạm về, đè lên tệp dở dang, để tệp và hồ sơ
            # khớp nhau và bản gửi tạm không bị lượt đăng nhập sau ghi đè mất.
            with contextlib.suppress(OSError):
                unpark_token(kind)
        elif not token_path(kind).exists() and backup_path(kind).exists():
            continue
        elif kind == CLAUDE and legacy_claude_pending():
            continue  # F-22: chờ api chuyển phiên cũ trước (xem legacy_claude_pending)
        if not token_path(kind).exists():
            need.append(kind)
    if not need or sm is None:
        return
    async with sm() as db:
        rows = (await db.execute(text("""SELECT DISTINCT ON (p.kind) p.kind, c.token_enc
                                         FROM agent.cli_profiles c JOIN agent.providers p ON p.id = c.provider_id
                                         WHERE c.is_active AND c.token_enc IS NOT NULL AND p.kind = ANY(:k)
                                         ORDER BY p.kind, c.updated_at DESC"""), {"k": need})).all()
    for r in rows:
        with contextlib.suppress(Exception):
            write_session(r.kind, crypto.decrypt(bytes(r.token_enc), CLI_AAD))


# ─── Phiên đăng nhập ───────────────────────────────────────────────────────

@dataclass
class LoginSession:
    id: str
    org_id: uuid.UUID
    user_id: uuid.UUID
    kind: str = AGY
    status: str = "starting"
    url: str | None = None
    message: str | None = None
    code: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    pid: int | None = None
    profile: dict[str, Any] | None = None

    def public(self) -> dict[str, Any]:
        return {"login_id": self.id, "kind": self.kind, "status": self.status, "url": self.url,
                "message": self.message, "profile": self.profile}


class CliLogins:
    """Quản lý các phiên đăng nhập CLI đang mở trong tiến trình api (một phiên / tổ chức)."""

    def __init__(self, sm: async_sessionmaker[AsyncSession], redis: Redis, *, argv: list[str] | None = None,
                 claude_argv: list[str] | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.sm, self.redis, self.transport = sm, redis, transport
        self.argv = argv or [get_settings().cli_binary]
        # Claude Code: tệp chạy (test thay bằng [python, fake_claude.py]); lệnh con thêm ở login_argv/_identity.
        self.claude_argv = claude_argv or [get_settings().claude_binary]
        self.sessions: dict[str, LoginSession] = {}

    def login_argv(self, kind: str) -> list[str]:
        # Claude Code: `claude auth login --claudeai` in link (hyperlink OSC 8) rồi chờ "Paste code here if prompted >"
        # (đo thật trên claude 2.1.285 trong pty). agy: chạy không tham số (TUI, menu đăng nhập Google).
        return [*self.claude_argv, "auth", "login", "--claudeai"] if kind == CLAUDE else list(self.argv)

    async def _emit(self, s: LoginSession, **extra: Any) -> None:
        await realtime.publish(self.redis, "cli.login", {"login_id": s.id, "kind": s.kind, "status": s.status,
                                                         "url": s.url, "message": s.message, **extra},
                               org_id=s.org_id)

    async def start(self, org_id: uuid.UUID, user_id: uuid.UUID, kind: str = AGY) -> LoginSession:
        # CLI sẽ ghi đè tệp phiên → lưu lại phiên của hồ sơ đang hoạt động trước.
        async with self.sm() as db:
            await save_current_back(db, org_id, kind)
            await db.commit()
        old = [s for s in self.sessions.values()
               if s.org_id == org_id and s.kind == kind and s.task is not None and not s.task.done()]
        for s in old:
            self.cancel(s.id)
        # Chờ phiên cũ dọn xong (trả tệp phiên gửi tạm) rồi mới mở phiên mới, tránh hai phiên giẫm lên tệp.
        for s in old:
            with contextlib.suppress(BaseException):
                await asyncio.wait_for(asyncio.shield(s.task), 10)  # type: ignore[arg-type]
        s = LoginSession(str(uuid.uuid4()), org_id, user_id, kind)
        self.sessions[s.id] = s
        s.task = asyncio.create_task(self._run(s), name=f"cli-login-{s.id}")
        return s

    def busy(self, org_id: uuid.UUID, kind: str | None = None) -> bool:
        """Có phiên đăng nhập đang chạy (tệp phiên đang để trống cho CLI) — không đổi tài khoản lúc này."""
        return any(s.org_id == org_id and (kind is None or s.kind == kind) and s.task is not None
                   and not s.task.done() for s in self.sessions.values())

    def get(self, login_id: str, org_id: uuid.UUID) -> LoginSession | None:
        s = self.sessions.get(login_id)
        return s if s is not None and s.org_id == org_id else None

    async def submit(self, s: LoginSession, code: str) -> None:
        await s.code.put(code.strip())

    def cancel(self, login_id: str) -> None:
        s = self.sessions.get(login_id)
        if s and s.task and not s.task.done():
            s.task.cancel()

    async def shutdown(self) -> None:
        for s in list(self.sessions.values()):
            self.cancel(s.id)

    async def _run(self, s: LoginSession) -> None:
        import pty

        started = time.time()
        sp = spec(s.kind)
        path = token_path(s.kind)
        with contextlib.suppress(OSError):
            path.parent.mkdir(parents=True, exist_ok=True)
        # CLI đang đăng nhập sẵn sẽ không in link → gửi tạm tệp phiên (đã lưu vào hồ sơ ở start()).
        park_token(s.kind)
        before = path.stat().st_mtime if path.exists() else 0.0
        env = {**sp.env(), "TERM": "xterm", "SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 22",
               "SSH_CLIENT": "127.0.0.1 0 22", "SSH_TTY": "/dev/pts/0", "COLUMNS": str(PTY_COLS),
               "LINES": str(PTY_ROWS)}
        master, slave = pty.openpty()
        with contextlib.suppress(OSError):
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", PTY_ROWS, PTY_COLS, 0, 0))
        proc: asyncio.subprocess.Process | None = None
        loop = asyncio.get_running_loop()
        out: asyncio.Queue[bytes] = asyncio.Queue()
        buf = ""
        raw = ""
        answered: set[str] = set()
        try:
            await self._emit(s)
            proc = await asyncio.create_subprocess_exec(*self.login_argv(s.kind), stdin=slave, stdout=slave,
                                                        stderr=slave, env=env, start_new_session=True,
                                                        cwd=str(path.parent))
            s.pid = proc.pid
            os.close(slave)
            slave = -1
            os.set_blocking(master, False)

            def readable() -> None:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    data = b""
                out.put_nowait(data)
                if not data:
                    loop.remove_reader(master)

            loop.add_reader(master, readable)
            code_task: asyncio.Task[str] | None = None
            while time.time() - started < LOGIN_TIMEOUT_S:
                if path.exists() and path.stat().st_mtime > before and path.stat().st_size > 20:
                    await asyncio.sleep(0.5)   # chờ CLI ghi xong (Claude: cả .claude.json)
                    await self._finish(s, read_session(s.kind) or path.read_bytes())
                    return
                try:
                    chunk = await asyncio.wait_for(out.get(), 0.5)
                except TimeoutError:
                    chunk = None
                if chunk == b"":
                    if path.exists() and path.stat().st_mtime > before:
                        continue
                    raise RuntimeError("CLI đã thoát trước khi đăng nhập xong: " + buf[-300:].strip())
                if chunk:
                    reply = terminal_replies(chunk)
                    if reply:
                        os.write(master, reply)
                    decoded = chunk.decode(errors="replace")
                    raw = (raw + decoded)[-16000:]
                    buf = (buf + _ANSI.sub("", decoded))[-8000:]
                    tail = buf[-600:]
                    if _MENU_OAUTH.search(tail) and "menu" not in answered and s.url is None:
                        answered.add("menu")
                        os.write(master, b"1\r")
                    url = login_url(raw, buf) if s.url is None else None
                    if url:
                        s.url = url
                        s.status = "waiting_code"
                        await self._emit(s)
                    if s.status == "verifying":
                        key = tail[-120:]
                        if _PROMPT_YN.search(tail) and key not in answered:
                            answered.add(key)
                            os.write(master, b"y\r")
                        elif _PROMPT_ENTER.search(tail[-200:]) and key not in answered:
                            answered.add(key)
                            os.write(master, b"\r")
                if s.status == "waiting_code":
                    if code_task is None:
                        code_task = asyncio.create_task(s.code.get())
                    if code_task.done():
                        os.write(master, code_task.result().encode() + b"\r")
                        code_task = None
                        s.status, s.message = "verifying", None
                        await self._emit(s)
            raise TimeoutError("Quá 10 phút chưa hoàn tất đăng nhập")
        except asyncio.CancelledError:
            s.status, s.message = "failed", "Đã huỷ"
            await self._emit(s)
            raise
        except Exception as exc:  # noqa: BLE001 — báo lỗi lên Console, không làm sập api
            log.warning("Đăng nhập CLI lỗi: %s", exc)
            # v0.1.28 (UX N2): không đưa lỗi hệ điều hành ("[Errno 2] No such file or directory") thẳng lên Console.
            s.status = "failed"
            s.message = (sp.missing if isinstance(exc, FileNotFoundError) else str(exc)[:300])
            await self._emit(s)
            await self._log(s, "failed", {"error": str(exc)[:300]})
        finally:
            with contextlib.suppress(Exception):
                loop.remove_reader(master)
            with contextlib.suppress(OSError):
                os.close(master)
            if slave >= 0:
                with contextlib.suppress(OSError):
                    os.close(slave)
            if proc is not None and proc.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(proc.pid, signal.SIGTERM)
                with contextlib.suppress(BaseException):
                    await asyncio.wait_for(proc.wait(), 5)
            # Sau khi CLI đã tắt (không còn ghi tệp): xong → bỏ bản gửi tạm; lỗi/huỷ → trả tài khoản cũ về.
            with contextlib.suppress(OSError):
                if s.status == "done":
                    drop_parked_token(s.kind)
                elif not unpark_token(s.kind) and path.exists() and path.stat().st_mtime > before:
                    # Chưa có tài khoản nào: bỏ tệp dở dang CLI để lại, để không thành "đã đăng nhập" giả.
                    path.unlink()

    async def _identity(self, s: LoginSession, raw: bytes) -> dict[str, Any]:
        if s.kind != CLAUDE:
            return await token_identity(raw, self.transport)
        meta = session_meta(CLAUDE, raw)
        email, plan = session_email(CLAUDE, raw), meta.get("plan")
        if not email or not plan:
            # `claude auth status --json` (đo trên 2.1.285): {loggedIn, authMethod, email, subscriptionType, …}.
            with contextlib.suppress(Exception):
                proc = await asyncio.create_subprocess_exec(
                    *self.claude_argv, "auth", "status", "--json", stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, env=spec(CLAUDE).env())
                out, _ = await asyncio.wait_for(proc.communicate(), 30)
                st = _json(out)
                email = email or (st.get("email") if isinstance(st.get("email"), str) else None)
                if not plan and st.get("subscriptionType"):
                    plan = f"Claude {str(st['subscriptionType']).capitalize()}"
        return {"email": email, "expires_at": meta.get("expires_at"), "plan": plan}

    async def _finish(self, s: LoginSession, raw: bytes) -> None:
        ident = await self._identity(s, raw)
        async with self.sm() as db:
            provider_id = await cli_provider_id(db, s.org_id, s.kind)
            existing = (await db.execute(text("""SELECT id FROM agent.cli_profiles WHERE provider_id = :p
                                                 AND email = :e"""),
                                         {"p": provider_id, "e": ident["email"]})).scalar_one_or_none() \
                if ident["email"] else None
            enc = crypto.encrypt(raw, CLI_AAD)
            if existing:
                profile_id = existing
                await db.execute(text("""UPDATE agent.cli_profiles SET token_enc = :t, expires_at = :x,
                                         plan_label = COALESCE(:pl, plan_label), updated_at = now() WHERE id = :i"""),
                                 {"t": enc, "x": ident["expires_at"], "i": existing, "pl": ident.get("plan")})
            else:
                profile_id = (await db.execute(text("""
                    INSERT INTO agent.cli_profiles (org_id, provider_id, email, token_enc, expires_at, plan_label)
                    VALUES (:o, :p, :e, :t, :x, :pl) RETURNING id"""),
                    {"o": s.org_id, "p": provider_id, "e": ident["email"], "t": enc,
                     "x": ident["expires_at"], "pl": ident.get("plan")})).scalar_one()
            # Tệp trong volume giờ là của tài khoản vừa đăng nhập → hồ sơ này thành hồ sơ hoạt động.
            await db.execute(text("UPDATE agent.cli_profiles SET is_active = false WHERE provider_id = :p"),
                             {"p": provider_id})
            await db.execute(text("UPDATE agent.cli_profiles SET is_active = true WHERE id = :i"), {"i": profile_id})
            await db.execute(text("""UPDATE agent.providers SET account_label = :e, auth_state = 'ok',
                                     auth_expires_at = :x WHERE id = :p"""),
                             {"e": ident["email"], "x": ident["expires_at"], "p": provider_id})
            await actionlog.record(db, org_id=s.org_id, actor_type="user", actor_id=f"user:{s.user_id}",
                                   action="cli.logged_in", target_type="cli_profile", target_id=str(profile_id),
                                   target_label=ident["email"], detail={"kind": s.kind})
            await db.commit()
            profs = await profiles(db, s.org_id, s.kind)
        s.status, s.message = "done", None
        s.profile = next((p for p in profs if p["id"] == str(profile_id)), None)
        await self._emit(s, profile=s.profile)

    async def _log(self, s: LoginSession, result: str, detail: dict[str, Any]) -> None:
        with contextlib.suppress(Exception):
            async with self.sm() as db:
                await actionlog.record(db, org_id=s.org_id, actor_type="user", actor_id=f"user:{s.user_id}",
                                       action="cli.login_failed", target_type="cli", result=result,
                                       detail={**detail, "kind": s.kind})
                await db.commit()
