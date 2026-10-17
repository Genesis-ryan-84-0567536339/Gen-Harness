"""Dịch vụ `agy-box` (v0.1.63 H1): `python -m gh.agybox.server` — nhận yêu cầu ký HMAC từ api/worker qua mạng nội bộ
`agy-bus` và chạy `agy` bằng ĐÚNG `AgyClient` có sẵn (cwd rỗng 0700 mỗi lượt, env sạch, prompt qua stdin, killpg).

Cô lập (docs/api/agybox-protocol.md): tiến trình này chỉ đọc các biến môi trường trong ALLOWED_ENV, tự xoá mọi
biến GH_* khác khỏi môi trường của mình, KHÔNG import `gh.config`/DB/Redis/crypto, chỉ giữ một khoá `gh_agy_key`
(ký yêu cầu). Review v0.1.63 (P1-1): hộp KHÔNG có volume / kho phiên nào — tệp token agy đến trong từng yêu cầu đã
ký (`session`), được đặt vào HOME tạm 0700 của đúng lượt đó (xoá sau lượt) và không bao giờ được ghi lại đâu cả;
lượt sau không thấy gì lượt trước để lại. Hộp không bao giờ gọi ngược api. Nhật ký chỉ ghi mã yêu cầu + kết quả,
không ghi prompt hay token."""

import asyncio
import logging
import math
import os
import re
import shutil
import time
from collections.abc import Callable, MutableMapping
from dataclasses import dataclass
from typing import Any

import orjson
from starlette.applications import Starlette
from starlette.exceptions import HTTPException
from starlette.requests import Request
from starlette.responses import Response
from starlette.routing import Route

from gh.agybox import protocol as P
from gh.providers.clients import (
    AgyClient,
    AuthFailed,
    BadRequest,
    Message,
    ModelRejected,
    ProviderError,
    RateLimited,
    cli_env,
    make_turn_home,
    redact,
    valid_token_json,
)

log = logging.getLogger("agybox")

ENV_KEY_FILE = "GH_AGYBOX_KEY_FILE"
ENV_MAX_JOBS = "GH_AGYBOX_MAX_JOBS"
ENV_HOST = "GH_AGYBOX_HOST"
ENV_PORT = "GH_AGYBOX_PORT"
ENV_CLI_BINARY = "GH_CLI_BINARY"
#: Toàn bộ biến GH_* hộp được phép đọc. Mọi biến GH_* khác (DB, Redis, khoá master/bridge/browser…, cả GH_CLI_HOME của
#: ảnh api — hộp không có kho phiên) bị bỏ qua và xoá.
ALLOWED_ENV = frozenset({ENV_KEY_FILE, ENV_MAX_JOBS, ENV_HOST, ENV_PORT, ENV_CLI_BINARY})
VERSION_TTL_S = 300.0
_VERSION_RE = re.compile(r"\d+\.\d+\.\d+\S*")


@dataclass
class Config:
    key_file: str
    cli_binary: str = "agy"
    max_jobs: int = 2
    host: str = "0.0.0.0"  # noqa: S104 — chỉ nghe trong mạng nội bộ agy-bus, không publish cổng ra máy chủ
    port: int = P.DEFAULT_PORT


def load_config(env: "MutableMapping[str, str] | dict[str, str]") -> Config:
    key_file = env.get(ENV_KEY_FILE, "")
    if not key_file:
        raise RuntimeError(f"Thiếu {ENV_KEY_FILE} — hộp agy không chạy được nếu không có khoá ký")
    try:
        jobs = max(1, int(env.get(ENV_MAX_JOBS) or 2))
        port = int(env.get(ENV_PORT) or P.DEFAULT_PORT)
    except ValueError as e:
        raise RuntimeError("GH_AGYBOX_MAX_JOBS / GH_AGYBOX_PORT phải là số nguyên") from e
    return Config(key_file=key_file, cli_binary=env.get(ENV_CLI_BINARY) or "agy", max_jobs=jobs,
                  host=env.get(ENV_HOST) or "0.0.0.0", port=port)  # noqa: S104


def scrub_environ(env: MutableMapping[str, str]) -> list[str]:
    """Xoá khỏi `env` mọi biến GH_* không nằm trong ALLOWED_ENV (vd. biến ENV của ảnh api); trả tên đã xoá."""
    gone = [k for k in list(env) if k.startswith("GH_") and k not in ALLOWED_ENV]
    for k in gone:
        del env[k]
    return gone


class _Reject(Exception):
    def __init__(self, code: str, message: str, **extra: Any):
        self.code, self.message, self.extra = code, message, extra


def _error_for(e: Exception) -> tuple[str, str, dict[str, Any]]:
    """ngoại lệ của AgyClient → (mã lỗi giao thức, thông điệp đã che, trường phụ)."""
    msg = redact(str(e), 300)
    if isinstance(e, ModelRejected):
        return P.E_MODEL_REJECTED, msg, {"what": e.what, "available": e.available[:50], "raw": redact(e.raw, 2000)}
    if isinstance(e, BadRequest):
        return P.E_BAD_REQUEST, msg, {}
    if isinstance(e, AuthFailed):
        return P.E_CLI_AUTH, msg, {}
    if isinstance(e, RateLimited):
        return P.E_RATE_LIMITED, msg, {"retry_after": e.retry_after}
    if isinstance(e, ProviderError):
        # AgyClient dùng đúng câu "CLI quá <n>s" cho hết giờ (clients.py::generate/discover_models), không có lớp riêng.
        return (P.E_TIMEOUT if str(e).startswith("CLI quá") else P.E_PROVIDER), msg, {}
    return P.E_INTERNAL, "Lỗi nội bộ của hộp", {}


def _number(v: Any, default: float, lo: float, hi: float) -> float:
    if v is None:
        return default
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise _Reject(P.E_BAD_REQUEST, "timeout_s phải là số")
    return min(max(float(v), lo), hi)


def create_app(cfg: Config, *, clock: Callable[[], float] = time.time) -> Starlette:
    key = P.load_key(cfg.key_file)
    state: dict[str, Any] = {"active": 0, "seen": {}, "version": None, "version_at": -1e18}
    version_lock = asyncio.Lock()

    def reply(status: int, obj: dict[str, Any], req_sig: str | None = None, headers: dict[str, str] | None = None
              ) -> Response:
        body = orjson.dumps(obj)
        h = dict(headers or {})
        if req_sig is not None:
            h[P.SIG_HEADER] = P.response_signature(key, req_sig, status, body)
        return Response(body, status_code=status, media_type="application/json", headers=h)

    def fail(code: str, message: str, *, request_id: str | None = None, req_sig: str | None = None,
             **extra: Any) -> Response:
        err: dict[str, Any] = {"code": code, "message": message, **{k: v for k, v in extra.items() if v is not None}}
        obj: dict[str, Any] = {"error": err}
        if request_id:
            obj["request_id"] = request_id
        headers = {"Retry-After": str(int(extra["retry_after"]))} if extra.get("retry_after") else None
        return reply(P.ERROR_STATUS[code], obj, req_sig, headers)

    async def read_body(request: Request) -> bytes:
        cl = request.headers.get("content-length")
        if cl and cl.isdigit() and int(cl) > P.MAX_BODY_BYTES:
            raise _Reject(P.E_TOO_LARGE, "Thân yêu cầu quá lớn")
        buf = bytearray()
        async for chunk in request.stream():
            buf += chunk
            if len(buf) > P.MAX_BODY_BYTES:
                raise _Reject(P.E_TOO_LARGE, "Thân yêu cầu quá lớn")
        return bytes(buf)

    def authenticate(request: Request, body: bytes) -> str:
        """Trả chữ ký yêu cầu (đã hợp lệ, chưa dùng). Ném _Reject(unauthorized) — thông điệp luôn chung chung."""
        now = clock()
        why = P.verify_request(key, request.method, request.url.path, body, request.headers, now)
        sig = request.headers.get(P.SIG_HEADER, "").lower()
        seen: dict[str, float] = state["seen"]
        for s in [s for s, t in seen.items() if now - t > 2 * P.MAX_SKEW_S]:
            del seen[s]
        if why is None and sig in seen:
            why = "replayed"
        if why is not None:
            log.warning("agy-box: từ chối %s %s (%s)", request.method, request.url.path, why)
            raise _Reject(P.E_UNAUTHORIZED, "Chữ ký không hợp lệ hoặc đã hết hạn")
        if len(seen) < 4096:
            seen[sig] = now
        return sig

    def parse(body: bytes) -> dict[str, Any]:
        try:
            obj = orjson.loads(body)
        except orjson.JSONDecodeError as e:
            raise _Reject(P.E_BAD_REQUEST, "Thân yêu cầu không phải JSON") from e
        if not isinstance(obj, dict):
            raise _Reject(P.E_BAD_REQUEST, "Thân yêu cầu phải là đối tượng JSON")
        rid = obj.get("request_id")
        if not isinstance(rid, str) or not P.REQUEST_ID_RE.fullmatch(rid):
            raise _Reject(P.E_BAD_REQUEST, "request_id không hợp lệ")
        return obj

    def session_of(obj: dict[str, Any]) -> bytes:
        """Tệp token agy gửi kèm yêu cầu: chuỗi JSON đối tượng ≤ 64 KiB (khuôn tối thiểu như kho phiên của api)."""
        raw = obj.get("session")
        data = raw.encode() if isinstance(raw, str) else b""
        if not valid_token_json(data):
            raise _Reject(P.E_BAD_REQUEST, "session phải là tệp phiên Antigravity (đối tượng JSON ≤ 64 KiB)")
        return data

    async def run_job(request: Request, kind: str) -> Response:
        rid: str | None = None
        sig: str | None = None
        started = time.monotonic()
        code = "ok"
        try:
            body = await read_body(request)
            sig = authenticate(request, body)
            obj = parse(body)
            rid = obj["request_id"]
            session = session_of(obj)
            if kind == "generate":
                prompt, model, effort = obj.get("prompt"), obj.get("model"), obj.get("effort")
                if not isinstance(prompt, str) or not prompt.strip():
                    raise _Reject(P.E_BAD_REQUEST, "prompt phải là chuỗi không rỗng")
                if not isinstance(model, str) or not model:
                    raise _Reject(P.E_BAD_REQUEST, "model phải là chuỗi không rỗng")
                if effort is not None and not isinstance(effort, str):
                    raise _Reject(P.E_BAD_REQUEST, "effort phải là chuỗi hoặc null")
                if not isinstance(obj.get("json_mode", False), bool):
                    raise _Reject(P.E_BAD_REQUEST, "json_mode phải là true/false")
                if len(prompt.encode()) > P.MAX_PROMPT_BYTES:
                    raise _Reject(P.E_TOO_LARGE, "Prompt quá dài cho CLI")
                timeout = _number(obj.get("timeout_s"), P.DEFAULT_TIMEOUT_S, P.MIN_TIMEOUT_S, P.MAX_TIMEOUT_S)
            else:
                timeout = _number(obj.get("timeout_s"), P.DEFAULT_MODELS_TIMEOUT_S, P.MIN_TIMEOUT_S, P.MAX_TIMEOUT_S)
            if state["active"] >= cfg.max_jobs:
                raise _Reject(P.E_BUSY, "Hộp đang bận", retry_after=P.BUSY_RETRY_AFTER_S)
            state["active"] += 1
            try:
                # Không có kho phiên: `cli_home` không dùng tới khi có `session` (không đọc, không ghi, không khoá).
                agy = AgyClient(cfg.cli_binary, "/nonexistent/agy-box", timeout=timeout, session=session)
                if kind == "generate":
                    assert isinstance(prompt, str) and isinstance(model, str)  # đã kiểm ở trên (cho mypy)
                    c = await agy.generate(model, [Message("user", prompt)], json_mode=bool(obj.get("json_mode")),
                                           temperature=0.0, effort=effort)
                    out = {"request_id": rid, "text": c.text, "tokens_in": c.tokens_in, "tokens_out": c.tokens_out,
                           "raw": {k: v for k, v in c.raw.items() if isinstance(v, (int, float, str, type(None)))}}
                else:
                    models = await agy.discover_models()
                    out = {"request_id": rid, "models": models, "raw_text": agy.last_models_raw}
            finally:
                state["active"] -= 1
            return reply(200, out, sig)
        except _Reject as r:
            code = r.code
            return fail(r.code, r.message, request_id=rid, req_sig=sig if r.code != P.E_UNAUTHORIZED else None,
                        **r.extra)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — mọi lỗi của agy đổi thành mã lỗi có cấu trúc
            code, message, extra = _error_for(e)
            if code == P.E_INTERNAL:
                log.exception("agy-box: lỗi nội bộ (yêu cầu %s)", rid)
            return fail(code, message, request_id=rid, req_sig=sig, **extra)
        finally:
            log.info("agy-box: %s %s -> %s trong %d ms", kind, rid or "-", code,
                     int((time.monotonic() - started) * 1000))

    async def agy_version() -> str | None:
        async with version_lock:
            now = time.monotonic()
            if now - state["version_at"] < VERSION_TTL_S:
                return state["version"]
            version: str | None = None
            home = make_turn_home(None)
            try:
                proc = await asyncio.create_subprocess_exec(
                    cfg.cli_binary, "--version", stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, env=cli_env("", home=home), start_new_session=True)
                try:
                    out, _ = await asyncio.wait_for(proc.communicate(), 10)
                except TimeoutError:
                    AgyClient._kill_group(proc.pid)  # noqa: SLF001
                    await proc.wait()
                    out = b""
                m = _VERSION_RE.search(out.decode(errors="replace"))
                version = m.group(0) if m else None
            except OSError:
                version = None
            finally:
                shutil.rmtree(home, ignore_errors=True)
            state["version"], state["version_at"] = version, now
            return version

    async def healthz(request: Request) -> Response:
        # Hộp không giữ phiên (token đến theo từng yêu cầu) ⇒ `cli_logged_in` luôn null; api tự biết có phiên hay không.
        return reply(200, {"ok": True, "service": P.SERVICE, "protocol": P.PROTOCOL_VERSION,
                           "agy_version": await agy_version(), "cli_logged_in": None})

    async def generate(request: Request) -> Response:
        return await run_job(request, "generate")

    async def models(request: Request) -> Response:
        return await run_job(request, "models")

    async def http_error(request: Request, exc: Exception) -> Response:
        status = exc.status_code if isinstance(exc, HTTPException) else 500
        code = {404: P.E_NOT_FOUND, 405: P.E_METHOD}.get(status, P.E_INTERNAL)
        return fail(code, "Không có đường này" if status == 404 else "Sai phương thức")

    return Starlette(
        routes=[Route(P.PATH_HEALTHZ, healthz, methods=["GET"]), Route(P.PATH_GENERATE, generate, methods=["POST"]),
                Route(P.PATH_MODELS, models, methods=["POST"])],
        exception_handlers={404: http_error, 405: http_error})


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    cfg = load_config(os.environ)
    scrubbed = scrub_environ(os.environ)
    if scrubbed:
        log.info("agy-box: đã xoá %d biến GH_* ngoài danh sách khỏi môi trường tiến trình", len(scrubbed))
    app = create_app(cfg)
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="warning", access_log=False, server_header=False,
                timeout_keep_alive=5)


if __name__ == "__main__":
    main()
