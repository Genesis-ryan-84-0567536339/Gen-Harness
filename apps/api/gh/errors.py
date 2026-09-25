"""Lỗi theo RFC 7807 với mã máy đọc được (xem docs/api/phase-1.md)."""

from typing import Any

import orjson
from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import DBAPIError


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


def field_errors(errors: dict[str, str]) -> ApiError:
    return ApiError(422, "VALIDATION", "Dữ liệu chưa hợp lệ", errors=errors)


def _body(status: int, code: str, title: str, detail: Any, extra: dict[str, Any]) -> dict[str, Any]:
    return {"type": f"https://gen-harness.local/errors/{code.lower()}", "title": title,
            "status": status, "code": code, "detail": detail, **extra}


async def api_error_handler(_: Request, exc: Exception) -> JsonResponse:
    assert isinstance(exc, ApiError)
    return JsonResponse(_body(exc.status, exc.code, exc.title, exc.detail, exc.extra), status_code=exc.status,
                          media_type="application/problem+json")


async def db_error_handler(_: Request, exc: Exception) -> JsonResponse:
    """Giai đoạn 5.4: mất kết nối CSDL giữa chừng → lỗi rõ ràng (503), không phải 500 không rõ nguyên nhân.

    `DBAPIError` gói mọi lỗi tầng driver (asyncpg), gồm mất kết nối/ngắt kết nối khi Postgres dừng. Tiến
    trình API không sập: đây là một exception handler bình thường của FastAPI, chỉ request đang chạy nhận lỗi.
    `pool_pre_ping=True` (gh/db.py) khiến các request SAU đó tự dò lại kết nối khi Postgres khởi động lại,
    không cần khởi động lại tiến trình app."""
    return JsonResponse(_body(503, "DB_UNAVAILABLE",
                              "Mất kết nối cơ sở dữ liệu, hệ thống đang tự kết nối lại — hãy thử lại sau ít giây",
                              str(exc)[:200] if isinstance(exc, DBAPIError) else None, {}),
                         status_code=503, media_type="application/problem+json")


async def validation_error_handler(_: Request, exc: Exception) -> JsonResponse:
    assert isinstance(exc, RequestValidationError)
    errors: dict[str, str] = {}
    for err in exc.errors():
        loc = [str(p) for p in err.get("loc", []) if p not in ("body", "query", "path")]
        errors[".".join(loc) or "_"] = err.get("msg", "Không hợp lệ")
    return JsonResponse(_body(422, "VALIDATION", "Dữ liệu chưa hợp lệ", None, {"errors": errors}),
                          status_code=422, media_type="application/problem+json")
