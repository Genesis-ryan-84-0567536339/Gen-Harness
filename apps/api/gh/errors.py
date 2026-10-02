"""Lỗi theo RFC 7807 với mã máy đọc được (xem docs/api/phase-1.md)."""

import errno
import logging
import socket
from typing import Any
from uuid import uuid4

import orjson
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from redis import exceptions as redis_exc
from sqlalchemy.exc import InterfaceError, OperationalError

log = logging.getLogger("gh.errors")

#: v0.1.35 (F-43): lớp lỗi "mất kết nối hạ tầng" → 503 SERVICE_UNAVAILABLE. redis-py có ConnectionError/TimeoutError
#: riêng (không phải lớp con OSError) nên phải liệt kê thêm. `socket.gaierror` (lớp con OSError trực tiếp, không phải
#: ConnectionError): container `db`/`redis` dừng → Docker DNS không phân giải được tên → asyncpg ném gaierror thô.
INFRA_ERRORS: tuple[type[Exception], ...] = (ConnectionError, TimeoutError, socket.gaierror,
                                                 redis_exc.ConnectionError, redis_exc.TimeoutError)

#: errno của `OSError` thường (không phải lớp con ConnectionError) vẫn nghĩa là "không tới được máy chủ hạ tầng".
_INFRA_ERRNOS = frozenset({errno.EHOSTUNREACH, errno.ENETUNREACH, errno.ECONNREFUSED, errno.EHOSTDOWN,
                           errno.ENETDOWN})


def is_infra_os_error(exc: BaseException) -> bool:
    """OSError mất kết nối hạ tầng mà không thuộc INFRA_ERRORS: errno không tới được máy/mạng, hoặc
    `OSError('Multiple exceptions: …')` asyncio ném khi MỌI địa chỉ của máy (IPv4+IPv6) đều kết nối thất bại."""
    if isinstance(exc, INFRA_ERRORS):
        return True
    if not isinstance(exc, OSError):
        return False
    if exc.errno in _INFRA_ERRNOS:
        return True
    msg = str(exc.args[0]) if exc.args and exc.errno is None else ""
    return msg.startswith("Multiple exceptions")

INTERNAL_TITLE = "Hệ thống gặp lỗi khi xử lý yêu cầu — đã ghi nhật ký"


class JsonResponse(JSONResponse):
    """JSON qua orjson (giữ nguyên tiếng Việt, hỗ trợ UUID/datetime)."""

    def render(self, content: Any) -> bytes:
        return orjson.dumps(content, default=str, option=orjson.OPT_NON_STR_KEYS)


class ApiError(Exception):
    def __init__(self, status: int, code: str, title: str, detail: Any = None, **extra: Any):
        self.status, self.code, self.title, self.detail, self.extra = status, code, title, detail, extra


def unauthenticated() -> ApiError:
    return ApiError(401, "UNAUTHENTICATED", "Chưa đăng nhập hoặc phiên đã hết hạn")


def forbidden(detail: str | None = None) -> ApiError:
    return ApiError(403, "FORBIDDEN", "Vai trò của bạn không có quyền thao tác này", detail)


def not_found(what: str = "Đối tượng") -> ApiError:
    return ApiError(404, "NOT_FOUND", f"{what} không tồn tại hoặc nằm ngoài phạm vi của bạn")


def conflict(code: str, title: str, detail: Any = None) -> ApiError:
    return ApiError(409, code, title, detail)


def pin_required() -> ApiError:
    return ApiError(423, "PIN_REQUIRED", "Thao tác này cần nhập mã PIN")


MODEL_UNAVAILABLE_HINT = "Chưa có model AI nào hoạt động — vào Agent & Model (Hướng dẫn bước 4) để chọn hoặc sửa model."


def model_unavailable(title: str, reasons: list[str]) -> ApiError:
    """v0.1.30: 503 MODEL_UNAVAILABLE đúng khuôn lỗi chung — `detail` là CÂU CHỮ cho người đọc (web hiện thẳng),
    lý do kỹ thuật từng nhà cung cấp nằm ở `reasons` cấp ngoài cùng (chuỗi). Trước đây `detail={"reasons": …}` (đối
    tượng) → web vẽ thẳng làm React child → sập màn (React error #31)."""
    clean = [str(r) for r in reasons if str(r).strip()]
    return ApiError(503, "MODEL_UNAVAILABLE", title, MODEL_UNAVAILABLE_HINT, reasons=clean)


def field_errors(errors: dict[str, str]) -> ApiError:
    return ApiError(422, "VALIDATION", "Dữ liệu chưa hợp lệ", errors=errors)


def _body(status: int, code: str, title: str, detail: Any, extra: dict[str, Any]) -> dict[str, Any]:
    """v0.1.35 (F-14): `detail` LUÔN là chuỗi hoặc null. Giá trị khác (dict/list…) là lỗi lập trình — ghi cảnh báo,
    chuyển nguyên giá trị sang khoá `context` (nếu chưa có) để không mất thông tin, và đặt `detail=None`."""
    extra = dict(extra)
    if detail is not None and not isinstance(detail, str):
        log.warning("problem+json %s: detail không phải chuỗi (%s) — chuyển sang 'context'", code,
                    type(detail).__name__)
        extra.setdefault("context", detail)
        detail = None
    return {"type": f"https://gen-harness.local/errors/{code.lower()}", "title": title,
            "status": status, "code": code, "detail": detail, **extra}


def _problem(status: int, code: str, title: str, detail: str | None = None, **extra: Any) -> JsonResponse:
    return JsonResponse(_body(status, code, title, detail, extra), status_code=status,
                        media_type="application/problem+json")


def _internal(request: Request, message: str) -> JsonResponse:
    """500 INTERNAL thân thiện: chi tiết kỹ thuật CHỈ nằm trong log server, người dùng nhận mã lỗi để tra cứu.

    v0.1.36 (F-4): `error_id`, `method`, `path` đi kèm bản ghi log dưới dạng trường riêng (`extra=`) — log JSON
    (gh.app.JsonFormatter) tra thẳng theo mã lỗi người dùng gửi về."""
    error_id = uuid4().hex[:8]
    log.exception("%s [%s] %s %s", message, error_id, request.method, request.url.path,
                  extra={"error_id": error_id, "method": request.method, "path": request.url.path})
    return _problem(500, "INTERNAL", INTERNAL_TITLE, f"Mã lỗi {error_id} — gửi mã này cho người hỗ trợ",
                    error_id=error_id)


async def api_error_handler(_: Request, exc: Exception) -> JsonResponse:
    assert isinstance(exc, ApiError)
    return JsonResponse(_body(exc.status, exc.code, exc.title, exc.detail, exc.extra), status_code=exc.status,
                          media_type="application/problem+json")


#: SQLSTATE nghĩa là "mất/không có kết nối": lớp 08 (connection exception), 57P01–57P03 (admin/crash shutdown,
#: cannot connect now — Postgres đang tắt/khởi động). asyncpg ném các lỗi này dưới dạng PostgresError chung nên
#: SQLAlchemy bọc thành DBAPIError gốc (không phải OperationalError).
#: Thêm lỗi quá tải tạm thời — client nên thử lại, không phải lỗi mã: lớp 53 (insufficient resources: 53300
#: too_many_connections, 53100 disk_full, 53200 out_of_memory…) và 57014 (query_canceled / statement_timeout).
_DISCONNECT_SQLSTATES = ("08", "53", "57P01", "57P02", "57P03", "57014")


def _db_disconnected(exc: Exception) -> bool:
    if isinstance(exc, (OperationalError, InterfaceError)) or getattr(exc, "connection_invalidated", False):
        return True
    orig = getattr(exc, "orig", None)
    state = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
    return isinstance(state, str) and state.startswith(_DISCONNECT_SQLSTATES)


async def db_error_handler(request: Request, exc: Exception) -> JsonResponse:
    """Giai đoạn 5.4 + v0.1.35 (F-43): CHỈ lỗi mất kết nối CSDL mới là 503 DB_UNAVAILABLE.

    - `OperationalError`/`InterfaceError`, hoặc `connection_invalidated=True` (asyncpg `AdminShutdownError` lúc
      Postgres tắt bị SQLAlchemy bọc thành `DBAPIError` gốc nhưng đánh dấu kết nối hỏng) → 503, `detail` null
      (không lộ thông điệp driver). `pool_pre_ping=True` (gh/db.py) giúp request sau tự kết nối lại.
    - Mọi `DBAPIError` khác (IntegrityError, ProgrammingError, DataError…) là lỗi lập trình/dữ liệu → 500 INTERNAL
      kèm `error_id`; câu SQL, tham số, tên ràng buộc chỉ nằm trong log server, không bao giờ trong thân phản hồi."""
    if _db_disconnected(exc):
        return _problem(503, "DB_UNAVAILABLE",
                        "Mất kết nối cơ sở dữ liệu, hệ thống đang tự kết nối lại — hãy thử lại sau ít giây")
    return _internal(request, "Lỗi CSDL không mong đợi")


async def infra_error_handler(request: Request, exc: Exception) -> JsonResponse:
    """Giai đoạn 5.4 + v0.1.35 (F-43): lỗi kết nối hạ tầng (Postgres/Redis) khi CHƯA có kết nối (vd.
    `ConnectionRefusedError` lúc Postgres/Redis tắt hẳn) không được bọc thành `DBAPIError`. Đăng ký cho
    `ConnectionError` (ConnectionRefused/Reset, BrokenPipe…), `TimeoutError` (gồm asyncio.TimeoutError) và lỗi
    kết nối của redis-py → 503. `detail` null: `str(exc)` lộ địa chỉ IP/cổng nội bộ — chỉ ghi vào log."""
    log.warning("Mất kết nối hạ tầng %s %s: %r", request.method, request.url.path, exc)
    return _problem(503, "SERVICE_UNAVAILABLE",
                    "Mất kết nối tới dịch vụ hạ tầng (CSDL/Redis), hệ thống đang tự kết nối lại — "
                    "hãy thử lại sau ít giây")


async def os_error_handler(request: Request, exc: Exception) -> JsonResponse:
    """v0.1.35 (F-43): `OSError` còn lại (đĩa đầy, thiếu quyền, thiếu tệp…) không phải mất kết nối → 500 INTERNAL
    kèm `error_id`. Starlette chọn handler theo MRO nên `ConnectionError`/`TimeoutError`/`gaierror` vẫn về
    infra_error_handler; OSError thường mang errno EHOSTUNREACH/ENETUNREACH/ECONNREFUSED… hoặc "Multiple
    exceptions" (asyncio, máy hai ngăn xếp) cũng là mất kết nối → chuyển sang infra_error_handler (503)."""
    if is_infra_os_error(exc):
        return await infra_error_handler(request, exc)
    return _internal(request, "Lỗi hệ điều hành không mong đợi")


async def unhandled_error_handler(request: Request, exc: Exception) -> JsonResponse:
    """v0.1.35 (F-43): lưới cuối cho MỌI ngoại lệ chưa có handler riêng (KeyError, ValueError, AttributeError…).

    Thiếu nó Starlette trả `text/plain` "Internal Server Error" — không mã lỗi, không câu tiếng Việt. Đăng ký cho
    `Exception` nên Starlette gắn vào ServerErrorMiddleware: phản hồi là problem+json 500 INTERNAL kèm `error_id`,
    stack trace chỉ nằm trong log server."""
    return _internal(request, f"Lỗi không mong đợi ({type(exc).__name__})")


async def validation_error_handler(_: Request, exc: Exception) -> JsonResponse:
    assert isinstance(exc, RequestValidationError)
    errors: dict[str, str] = {}
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
        errors[".".join(loc) or "_"] = err.get("msg", "Không hợp lệ")
    return JsonResponse(_body(422, "VALIDATION", "Dữ liệu chưa hợp lệ", None, {"errors": errors}),
                          status_code=422, media_type="application/problem+json")
