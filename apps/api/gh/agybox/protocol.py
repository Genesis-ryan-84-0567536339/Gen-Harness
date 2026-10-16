"""Hợp đồng gọi `agy-box` (v0.1.63 H1) — dùng chung cho `server` (trong hộp) và `client` (api/worker).

Chỉ stdlib + orjson: module này nằm trong hộp nên KHÔNG được kéo theo `gh.config` / DB / Redis.

Đường HTTP (nghe `0.0.0.0:8090` trong mạng nội bộ `agy-bus`; hộp KHÔNG bao giờ gọi ngược api):
  GET  /healthz       không ký. {"ok": true, "service": "agy-box", "protocol": 1, "agy_version": "1.2.9"|null,
                           "cli_logged_in": bool}
  POST /v1/generate   ký. Yêu cầu  {request_id, model, effort|null, prompt, json_mode, timeout_s}
                           Trả lời {request_id, text, tokens_in, tokens_out, raw}
  POST /v1/models     ký. Yêu cầu  {request_id, timeout_s?}
                           Trả lời {request_id, models: [{id, ...}], raw_text}
Lỗi (mọi mã khác 2xx): {"error": {"code": <mã dưới đây>, "message": "...", ...}} — xem ERROR_STATUS.

Ký: header `X-GH-Ts` (giây UNIX, số nguyên) và `X-GH-Sig` = hex HMAC-SHA256(subkey("request"),
"gh-agybox-v1\\n" + METHOD + "\\n" + PATH + "\\n" + TS + "\\n" + thân). subkey(purpose) = sha256(khoá ‖ "gh-agybox:" ‖
purpose). Lệch giờ > 60 giây (cả hai
phía) hoặc chữ ký đã dùng trong cửa sổ đó ⇒ 401. Trả lời đã xác thực mang `X-GH-Sig` = hex HMAC(subkey("response"),
chữ ký yêu cầu + "\\n" + mã trạng thái + "\\n" + thân) — client kiểm trước khi tin. Lỗi 401 không ký."""

import base64
import binascii
import hashlib
import hmac
import re
from collections.abc import Mapping

PROTOCOL_VERSION = 1
SERVICE = "agy-box"
DEFAULT_PORT = 8090

SIG_HEADER = "X-GH-Sig"
TS_HEADER = "X-GH-Ts"
PATH_GENERATE = "/v1/generate"
PATH_MODELS = "/v1/models"
PATH_HEALTHZ = "/healthz"

MAX_SKEW_S = 60
MAX_PROMPT_BYTES = 120_000        # = AgyClient.MAX_PROMPT
MAX_BODY_BYTES = 1_048_576        # chặn trước khi xác thực (prompt toàn ký tự điều khiển nở 6 lần khi mã hoá JSON)
MIN_TIMEOUT_S = 1.0
MAX_TIMEOUT_S = 600.0
DEFAULT_TIMEOUT_S = 300.0
DEFAULT_MODELS_TIMEOUT_S = 60.0
#: Client chờ thêm chừng này so với `timeout_s` để hộp kịp trả lời lỗi hết giờ có cấu trúc.
HTTP_MARGIN_S = 10.0
BUSY_RETRY_AFTER_S = 5.0

REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Mã lỗi → HTTP status. Client dựng lại ngoại lệ từ `error.code` (xem client.raise_for_error).
E_BAD_REQUEST = "bad_request"              # 400 BadRequest (JSON hỏng, thiếu trường, model sai regex)
E_MODEL_REJECTED = "model_rejected"        # 400 ModelRejected (+ what, available, raw)
E_UNAUTHORIZED = "unauthorized"            # 401 thiếu/sai chữ ký, lệch giờ, chữ ký đã dùng
E_CLI_AUTH = "cli_auth_failed"             # 403 agy chưa đăng nhập / phiên hết hạn (AuthFailed)
E_NOT_FOUND = "not_found"                  # 404
E_METHOD = "method_not_allowed"            # 405
E_TOO_LARGE = "too_large"                  # 413 thân > MAX_BODY_BYTES hoặc prompt > MAX_PROMPT_BYTES
E_RATE_LIMITED = "rate_limited"            # 429 agy báo hết hạn mức (+ retry_after)
E_BUSY = "busy"                            # 429 hộp đang chạy đủ GH_AGYBOX_MAX_JOBS lượt (+ retry_after)
E_INTERNAL = "internal"                    # 500
E_PROVIDER = "provider_error"              # 502 agy lỗi khác (ProviderError)
E_TIMEOUT = "timeout"                      # 504 agy chạy quá timeout_s

ERROR_STATUS = {E_BAD_REQUEST: 400, E_MODEL_REJECTED: 400, E_UNAUTHORIZED: 401, E_CLI_AUTH: 403, E_NOT_FOUND: 404,
                E_METHOD: 405, E_TOO_LARGE: 413, E_RATE_LIMITED: 429, E_BUSY: 429, E_INTERNAL: 500,
                E_PROVIDER: 502, E_TIMEOUT: 504}


def decode_key(raw: str) -> bytes:
    """Khoá 32 byte dạng hex (64 ký tự) hoặc base64 — như `gh.crypto.decode_key`, viết lại để hộp không import
    gh.crypto."""
    raw = raw.strip()
    if len(raw) == 64:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    try:
        key = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error) as e:
        raise ValueError("khoá agy-box phải là 32 byte dạng hex hoặc base64") from e
    if len(key) != 32:
        raise ValueError("khoá agy-box phải đủ 32 byte")
    return key


def load_key(path: str) -> bytes:
    with open(path, encoding="utf-8") as f:
        return decode_key(f.read())


def subkey(key: bytes, purpose: str) -> bytes:
    return hashlib.sha256(key + b"gh-agybox:" + purpose.encode()).digest()


def request_signature(key: bytes, method: str, path: str, ts: int | str, body: bytes) -> str:
    msg = b"gh-agybox-v1\n" + method.upper().encode() + b"\n" + path.encode() + b"\n" + str(ts).encode() + b"\n" + body
    return hmac.new(subkey(key, "request"), msg, hashlib.sha256).hexdigest()


def response_signature(key: bytes, request_sig: str, status: int, body: bytes) -> str:
    msg = request_sig.encode() + b"\n" + str(status).encode() + b"\n" + body
    return hmac.new(subkey(key, "response"), msg, hashlib.sha256).hexdigest()


def sign_request(key: bytes, method: str, path: str, body: bytes, now: float) -> dict[str, str]:
    ts = int(now)
    return {TS_HEADER: str(ts), SIG_HEADER: request_signature(key, method, path, ts, body)}


def verify_request(key: bytes, method: str, path: str, body: bytes, headers: Mapping[str, str], now: float
                   ) -> str | None:
    """None nếu hợp lệ; ngược lại một lý do ngắn (`missing`, `bad_timestamp`, `stale`, `bad_signature`) — CHỈ để ghi
    log nội bộ / thông điệp, trả lời cho người gọi luôn là mã `unauthorized`."""
    get = headers.get
    ts_raw, sig = get(TS_HEADER) or get(TS_HEADER.lower()), get(SIG_HEADER) or get(SIG_HEADER.lower())
    if not ts_raw or not sig:
        return "missing"
    try:
        ts = int(ts_raw)
    except (TypeError, ValueError):
        return "bad_timestamp"
    if abs(now - ts) > MAX_SKEW_S:
        return "stale"
    if not hmac.compare_digest(request_signature(key, method, path, ts, body), str(sig).lower()):
        return "bad_signature"
    return None
