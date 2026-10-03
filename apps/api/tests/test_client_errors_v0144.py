"""v0.1.44 (F-4b) — POST /client-errors: web báo lỗi giao diện về log máy chủ (logger gh.client)."""

import json
import logging
from typing import Any

import httpx
import pytest

from gh.app import JsonFormatter, RequestIdFilter
from tests.conftest import Api

TOKEN = "123456789:AAFakeTokenForTestOnly_abcdefghijkl"


def _body(**kw: Any) -> dict[str, Any]:
    return {"error_id": "ERR-K3J9-AB12", "message": f"Không tải được — token {TOKEN}", "name": "TypeError",
            "stack": f"at x (app.js:1)\nBearer sk-live-999 {TOKEN}", "component_stack": "in Overview",
            "path": "/overview", "request_id": "web-Req_12345678", "app_version": "v0.1.44", **kw}


async def _post(c: httpx.AsyncClient, body: dict[str, Any], ip: str = "10.0.0.1") -> httpx.Response:
    return await c.post("/api/v1/client-errors", json=body, headers={"X-Forwarded-For": ip})


async def test_accepts_and_logs_redacted(owner_api: Api, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="gh.client")
    caplog.handler.addFilter(RequestIdFilter())
    r = await _post(owner_api.c, _body())
    assert r.status_code == 202, r.text
    out = r.json()
    assert out["ok"] is True and out["request_id"] == r.headers["x-request-id"]
    [rec] = [x for x in caplog.records if x.name == "gh.client"]
    assert rec.levelno == logging.WARNING and rec.getMessage() == "Lỗi giao diện ERR-K3J9-AB12"
    assert rec.client_error_id == "ERR-K3J9-AB12"  # type: ignore[attr-defined]
    assert rec.client_request_id == "web-Req_12345678"  # type: ignore[attr-defined]
    assert rec.request_id == out["request_id"]  # type: ignore[attr-defined]
    assert rec.path == "/overview" and rec.app_version == "v0.1.44"  # type: ignore[attr-defined]
    assert rec.user_id  # type: ignore[attr-defined]  # có phiên đăng nhập
    assert TOKEN not in rec.client_message and "***" in rec.client_message  # type: ignore[attr-defined]
    line = JsonFormatter().format(rec)
    for secret in (TOKEN, "sk-live-999"):
        assert secret not in line
    data = json.loads(line)
    assert data["request_id"] == out["request_id"] and data["client_error_id"] == "ERR-K3J9-AB12"


@pytest.mark.parametrize("bad", [
    {"message": "x" * 1001}, {"stack": "x" * 4001}, {"component_stack": "x" * 4001}, {"path": "/" * 301},
    {"name": "x" * 101}, {"app_version": "v" * 41}, {"error_id": "ERR-lower-AB12"}, {"error_id": "ABC"},
    {"request_id": "ngan"}, {"request_id": "co dau!12345678"},
])
async def test_rejects_bad_bodies(owner_api: Api, bad: dict[str, Any]) -> None:
    r = await _post(owner_api.c, _body(**bad))
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION"
    assert r.json()["request_id"] == r.headers["x-request-id"]


async def test_rate_limit_per_ip(owner_api: Api) -> None:
    for _ in range(20):
        assert (await _post(owner_api.c, _body(), ip="10.0.0.2")).status_code == 202
    r = await _post(owner_api.c, _body(), ip="10.0.0.2")
    assert r.status_code == 429 and r.json()["code"] == "CLIENT_ERRORS_RATE_LIMITED"
    assert (await _post(owner_api.c, _body(), ip="10.0.0.3")).status_code == 202   # IP khác không bị chặn


async def test_works_before_setup_and_anonymous(client: httpx.AsyncClient, caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.WARNING, logger="gh.client")
    assert (await client.get("/api/v1/auth/me")).status_code == 428          # SetupGate đang chặn
    r = await _post(client, _body(request_id=None))
    assert r.status_code == 202, r.text
    [rec] = [x for x in caplog.records if x.name == "gh.client"]
    assert not hasattr(rec, "user_id") and rec.client_request_id is None  # type: ignore[attr-defined]
