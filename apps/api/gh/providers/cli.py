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
"""

import asyncio
import base64
import contextlib
import fcntl
import logging
import os
import re
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
from gh.providers.clients import TOKEN_FILE, cli_env, cli_home_dir

CLI_MISSING = "Máy chủ chưa cài công cụ đăng nhập Google (Antigravity CLI) — dùng khoá API ở bên dưới thay thế"
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


def token_path() -> Path:
    return cli_home_dir(get_settings().cli_home) / TOKEN_FILE


PARK_SUFFIX = ".before-login"


def backup_path() -> Path:
    path = token_path()
    return path.with_name(path.name + PARK_SUFFIX)


def park_token() -> None:
    """Gửi tạm tệp phiên đang dùng để CLI khởi động ở trạng thái CHƯA đăng nhập (mới hiện link đăng nhập)."""
    path = token_path()
    if path.exists():
        path.replace(backup_path())


def unpark_token() -> bool:
    """Trả tệp phiên đã gửi tạm về chỗ cũ (đăng nhập lỗi/huỷ, hoặc api chết giữa chừng). True nếu có trả."""
    bak = backup_path()
    if not bak.exists():
        return False
    bak.replace(token_path())
    return True


def drop_parked_token() -> None:
    with contextlib.suppress(FileNotFoundError):
        backup_path().unlink()


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


async def cli_provider_id(db: AsyncSession, org_id: uuid.UUID) -> uuid.UUID:
    pid = (await db.execute(text("""SELECT id FROM agent.providers WHERE org_id = :o AND kind = 'antigravity_cli'
                                    ORDER BY created_at LIMIT 1"""), {"o": org_id})).scalar_one_or_none()
    if pid is None:
        rank = (await db.execute(text("""SELECT COALESCE(max(failover_rank), 0) + 1 FROM agent.providers
                                         WHERE org_id = :o"""), {"o": org_id})).scalar_one()
        pid = (await db.execute(text("""INSERT INTO agent.providers (org_id, kind, name, failover_rank)
                                        VALUES (:o, 'antigravity_cli', 'Antigravity CLI', :r) RETURNING id"""),
                                {"o": org_id, "r": rank})).scalar_one()
    return pid  # type: ignore[no-any-return]


def profile_state(expires_at: datetime | None) -> str:
    if expires_at is None:
        return "ok"
    left = (expires_at - datetime.now(UTC)).total_seconds()
    # Token truy cập ngắn hạn được CLI tự làm mới; chỉ báo "sắp hết" khi dưới 1 giờ và hết hạn khi đã qua.
    return "expired" if left <= 0 else "expiring" if left < 3600 else "ok"


async def profiles(db: AsyncSession, org_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = (await db.execute(text("""SELECT id, email, plan_label, is_active, expires_at, created_at
                                     FROM agent.cli_profiles WHERE org_id = :o ORDER BY created_at"""),
                             {"o": org_id})).all()
    return [{"id": str(r.id), "email": r.email, "plan_label": r.plan_label, "active": r.is_active,
             "expires_at": r.expires_at.isoformat().replace("+00:00", "Z") if r.expires_at else None,
             "state": profile_state(r.expires_at)} for r in rows]


def write_token_file(raw: bytes) -> None:
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(raw)
    os.chmod(tmp, 0o600)
    tmp.replace(path)


async def save_current_back(db: AsyncSession, org_id: uuid.UUID) -> None:
    """Lưu tệp phiên đang dùng (có thể đã được CLI làm mới) vào hồ sơ đang hoạt động."""
    path = token_path()
    if not path.exists():
        return
    raw = path.read_bytes()
    email = file_email(raw)
    # Tệp của tài khoản KHÁC (id_token ghi rõ email khác) thì không ghi đè lên hồ sơ đang hoạt động.
    await db.execute(text("""UPDATE agent.cli_profiles SET token_enc = :t, updated_at = now()
                             WHERE org_id = :o AND is_active AND (CAST(:e AS text) IS NULL OR email IS NULL
                                                                  OR email = CAST(:e AS citext))"""),
                     {"t": crypto.encrypt(raw, CLI_AAD), "o": org_id, "e": email})


async def activate(db: AsyncSession, org_id: uuid.UUID, profile_id: uuid.UUID) -> dict[str, Any]:
    from gh.errors import conflict, not_found

    row = (await db.execute(text("""SELECT id, provider_id, email, token_enc, expires_at FROM agent.cli_profiles
                                    WHERE id = :i AND org_id = :o"""), {"i": profile_id, "o": org_id})).one_or_none()
    if row is None:
        raise not_found("Tài khoản Google của CLI")
    if row.token_enc is None:
        # Trước đây: chỉ đổi cờ trong CSDL, tệp phiên giữ nguyên → UI báo "đã đổi" mà AI vẫn chạy tài khoản cũ.
        raise conflict("CLI_PROFILE_NO_SESSION",
                       "Tài khoản này chưa có phiên đăng nhập đã lưu — bấm “Thêm tài khoản Google” để đăng nhập lại")
    try:
        token = crypto.decrypt(bytes(row.token_enc), CLI_AAD)
    except Exception as exc:  # noqa: BLE001 — khoá master đổi / dữ liệu hỏng
        raise conflict("CLI_PROFILE_NO_SESSION",
                       "Không mở được phiên đã lưu của tài khoản này — hãy đăng nhập lại tài khoản đó") from exc
    await save_current_back(db, org_id)
    await db.execute(text("UPDATE agent.cli_profiles SET is_active = false WHERE provider_id = :p AND is_active"),
                     {"p": row.provider_id})
    await db.execute(text("UPDATE agent.cli_profiles SET is_active = true, updated_at = now() WHERE id = :i"),
                     {"i": row.id})
    await db.execute(text("""UPDATE agent.providers SET account_label = :e, auth_state = 'ok', auth_expires_at = :x
                             WHERE id = :p"""),
                     {"e": row.email, "x": row.expires_at, "p": row.provider_id})
    # Worker gọi `agy -p` mới cho MỖI lượt, đọc tệp này từ volume chung → lượt kế tiếp dùng tài khoản vừa chọn.
    write_token_file(token)
    return {"id": str(row.id), "email": row.email}


async def delete_profile(db: AsyncSession, org_id: uuid.UUID, profile_id: uuid.UUID) -> dict[str, Any]:
    row = (await db.execute(text("""DELETE FROM agent.cli_profiles WHERE id = :i AND org_id = :o
                                    RETURNING provider_id, email, is_active"""),
                            {"i": profile_id, "o": org_id})).one_or_none()
    if row is None:
        from gh.errors import not_found

        raise not_found("Hồ sơ CLI")
    if row.is_active:
        # Đăng xuất = xoá tệp phiên (như heo-harness).
        with contextlib.suppress(FileNotFoundError):
            token_path().unlink()
        await db.execute(text("""UPDATE agent.providers SET account_label = NULL, auth_state = 'unconfigured'
                                 WHERE id = :p"""), {"p": row.provider_id})
    return {"email": row.email, "was_active": row.is_active}


async def restore_active(sm: async_sessionmaker[AsyncSession], *, owns_logins: bool = True) -> None:
    """Khi khởi động: tệp phiên trong volume trống mà có hồ sơ hoạt động → ghi lại tệp.

    Còn bản "gửi tạm" (api chết giữa lúc thêm tài khoản) thì api trả nó về trước — đó là tài khoản đang dùng. Worker
    (`owns_logins=False`) không đụng tới khi còn bản gửi tạm: có thể api đang chạy một phiên đăng nhập, ghi tệp lúc đó
    sẽ bị nhận nhầm là tài khoản mới."""
    if owns_logins:
        # api vừa khởi động ⇒ không còn phiên đăng nhập nào. Bản gửi tạm là tài khoản đang hoạt động trong CSDL; tệp
        # phiên (nếu có) là của lượt đăng nhập dở chưa ghi vào hồ sơ ⇒ trả bản gửi tạm về, đè lên tệp dở dang, để tệp
        # và hồ sơ khớp nhau và bản gửi tạm không bị lượt đăng nhập sau ghi đè mất.
        with contextlib.suppress(OSError):
            unpark_token()
    elif not token_path().exists() and backup_path().exists():
        return
    if token_path().exists():
        return
    async with sm() as db:
        blob = (await db.execute(text("""SELECT token_enc FROM agent.cli_profiles WHERE is_active
                                         AND token_enc IS NOT NULL ORDER BY updated_at DESC LIMIT 1"""))).scalar()
    if blob is not None:
        with contextlib.suppress(Exception):
            write_token_file(crypto.decrypt(bytes(blob), CLI_AAD))


# ─── Phiên đăng nhập ───────────────────────────────────────────────────────

@dataclass
class LoginSession:
    id: str
    org_id: uuid.UUID
    user_id: uuid.UUID
    status: str = "starting"
    url: str | None = None
    message: str | None = None
    code: asyncio.Queue[str] = field(default_factory=asyncio.Queue)
    task: asyncio.Task[None] | None = None
    pid: int | None = None
    profile: dict[str, Any] | None = None

    def public(self) -> dict[str, Any]:
        return {"login_id": self.id, "status": self.status, "url": self.url, "message": self.message,
                "profile": self.profile}


class CliLogins:
    """Quản lý các phiên đăng nhập CLI đang mở trong tiến trình api (một phiên / tổ chức)."""

    def __init__(self, sm: async_sessionmaker[AsyncSession], redis: Redis, *, argv: list[str] | None = None,
                 transport: httpx.AsyncBaseTransport | None = None):
        self.sm, self.redis, self.transport = sm, redis, transport
        self.argv = argv or [get_settings().cli_binary]
        self.sessions: dict[str, LoginSession] = {}

    async def _emit(self, s: LoginSession, **extra: Any) -> None:
        await realtime.publish(self.redis, "cli.login", {"login_id": s.id, "status": s.status, "url": s.url,
                                                         "message": s.message, **extra}, org_id=s.org_id)

    async def start(self, org_id: uuid.UUID, user_id: uuid.UUID) -> LoginSession:
        # CLI sẽ ghi đè tệp phiên → lưu lại phiên của hồ sơ đang hoạt động trước.
        async with self.sm() as db:
            await save_current_back(db, org_id)
            await db.commit()
        old = [s for s in self.sessions.values()
               if s.org_id == org_id and s.task is not None and not s.task.done()]
        for s in old:
            self.cancel(s.id)
        # Chờ phiên cũ dọn xong (trả tệp phiên gửi tạm) rồi mới mở phiên mới, tránh hai phiên giẫm lên tệp.
        for s in old:
            with contextlib.suppress(BaseException):
                await asyncio.wait_for(asyncio.shield(s.task), 10)  # type: ignore[arg-type]
        s = LoginSession(str(uuid.uuid4()), org_id, user_id)
        self.sessions[s.id] = s
        s.task = asyncio.create_task(self._run(s), name=f"cli-login-{s.id}")
        return s

    def busy(self, org_id: uuid.UUID) -> bool:
        """Có phiên đăng nhập đang chạy (tệp phiên đang để trống cho CLI) — không đổi tài khoản lúc này."""
        return any(s.org_id == org_id and s.task is not None and not s.task.done() for s in self.sessions.values())

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
        path = token_path()
        # CLI đang đăng nhập sẵn sẽ không in link → gửi tạm tệp phiên (đã lưu vào hồ sơ ở start()).
        park_token()
        before = path.stat().st_mtime if path.exists() else 0.0
        env = {**cli_env(get_settings().cli_home), "TERM": "xterm", "SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 22",
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
            proc = await asyncio.create_subprocess_exec(*self.argv, stdin=slave, stdout=slave, stderr=slave, env=env,
                                                        start_new_session=True)
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
                    await asyncio.sleep(0.5)   # chờ CLI ghi xong
                    await self._finish(s, path.read_bytes())
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
            s.message = (CLI_MISSING if isinstance(exc, FileNotFoundError) else str(exc)[:300])
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
                    drop_parked_token()
                elif not unpark_token() and path.exists() and path.stat().st_mtime > before:
                    # Chưa có tài khoản nào: bỏ tệp dở dang CLI để lại, để không thành "đã đăng nhập" giả.
                    path.unlink()

    async def _finish(self, s: LoginSession, raw: bytes) -> None:
        ident = await token_identity(raw, self.transport)
        async with self.sm() as db:
            provider_id = await cli_provider_id(db, s.org_id)
            existing = (await db.execute(text("""SELECT id FROM agent.cli_profiles WHERE provider_id = :p
                                                 AND email = :e"""),
                                         {"p": provider_id, "e": ident["email"]})).scalar_one_or_none() \
                if ident["email"] else None
            enc = crypto.encrypt(raw, CLI_AAD)
            if existing:
                profile_id = existing
                await db.execute(text("""UPDATE agent.cli_profiles SET token_enc = :t, expires_at = :x,
                                         updated_at = now() WHERE id = :i"""),
                                 {"t": enc, "x": ident["expires_at"], "i": existing})
            else:
                profile_id = (await db.execute(text("""
                    INSERT INTO agent.cli_profiles (org_id, provider_id, email, token_enc, expires_at)
                    VALUES (:o, :p, :e, :t, :x) RETURNING id"""),
                    {"o": s.org_id, "p": provider_id, "e": ident["email"], "t": enc,
                     "x": ident["expires_at"]})).scalar_one()
            # Tệp trong volume giờ là của tài khoản vừa đăng nhập → hồ sơ này thành hồ sơ hoạt động.
            await db.execute(text("UPDATE agent.cli_profiles SET is_active = false WHERE provider_id = :p"),
                             {"p": provider_id})
            await db.execute(text("UPDATE agent.cli_profiles SET is_active = true WHERE id = :i"), {"i": profile_id})
            await db.execute(text("""UPDATE agent.providers SET account_label = :e, auth_state = 'ok',
                                     auth_expires_at = :x WHERE id = :p"""),
                             {"e": ident["email"], "x": ident["expires_at"], "p": provider_id})
            await actionlog.record(db, org_id=s.org_id, actor_type="user", actor_id=f"user:{s.user_id}",
                                   action="cli.logged_in", target_type="cli_profile", target_id=str(profile_id),
                                   target_label=ident["email"])
            await db.commit()
            profs = await profiles(db, s.org_id)
        s.status, s.message = "done", None
        s.profile = next((p for p in profs if p["id"] == str(profile_id)), None)
        await self._emit(s, profile=s.profile)

    async def _log(self, s: LoginSession, result: str, detail: dict[str, Any]) -> None:
        with contextlib.suppress(Exception):
            async with self.sm() as db:
                await actionlog.record(db, org_id=s.org_id, actor_type="user", actor_id=f"user:{s.user_id}",
                                       action="cli.login_failed", target_type="cli", result=result, detail=detail)
                await db.commit()
