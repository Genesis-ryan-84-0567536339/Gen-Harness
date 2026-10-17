"""Gói sửa review v0.1.63 — các mục P3 của hộp riêng Antigravity (giao thức, server, client)."""

import json
from typing import Any

import httpx
import pytest

from gh.agybox import protocol, server
from tests.test_agybox_v0163 import KEY, SESSION, URL, _body, _raw, box  # noqa: F401 — fixture dùng chung


def _signed(box: Any, rid: str) -> tuple[bytes, dict[str, str]]:  # noqa: F811
    body = json.dumps({"request_id": rid, "session": SESSION}).encode()
    return body, protocol.sign_request(KEY, "POST", "/v1/models", body, box.clock())


# ─── P3: bộ nhớ chữ ký chống phát lại không được "đầy rồi thôi ghi" ───────────────────────────────────────────

async def test_replay_cache_full_rejects_instead_of_forgetting(box, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    """Trước: đủ 4096 chữ ký còn hạn thì NGỪNG ghi ⇒ chữ ký mới phát lại được. Nay: đầy ⇒ từ chối (bận, thử lại),
    chữ ký đã nhận luôn bị nhớ tới khi hết cửa sổ."""
    monkeypatch.setattr(server, "SEEN_MAX", 2)
    app = server.create_app(box.cfg, clock=box.clock)
    t = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=t, base_url=URL) as c:
        for rid in ("a-1", "a-2"):
            body, h = _signed(box, rid)
            assert (await c.post("/v1/models", content=body, headers=h)).status_code == 200
        body3, h3 = _signed(box, "a-3")
        full = await c.post("/v1/models", content=body3, headers=h3)
        assert full.status_code == 429 and full.json()["error"]["code"] == "busy"
        again = await c.post("/v1/models", content=body3, headers=h3)
        assert again.status_code == 429                                      # chưa từng chạy ⇒ không bao giờ "lọt"
        box.clock.t += 2 * protocol.MAX_SKEW_S + 1                           # hết cửa sổ ⇒ mục cũ được dọn
        body4, h4 = _signed(box, "a-4")
        assert (await c.post("/v1/models", content=body4, headers=h4)).status_code == 200
        assert (await c.post("/v1/models", content=body4, headers=h4)).status_code == 401   # phát lại ⇒ 401


# ─── P3: chữ ký có ký tự ngoài ASCII ⇒ 401 (không ném lỗi), client so chữ ký thời gian hằng ─────────────────────

def test_verify_request_non_ascii_signature_is_bad_signature() -> None:
    now = 1_800_000_000.0
    h = protocol.sign_request(KEY, "POST", "/v1/models", b"{}", now)
    h[protocol.SIG_HEADER] = "é" + h[protocol.SIG_HEADER][1:]
    assert protocol.verify_request(KEY, "POST", "/v1/models", b"{}", h, now) == "bad_signature"
    h[protocol.TS_HEADER] = "١٨٠٠٠٠٠٠٠٠"                                   # chữ số Ả Rập: không nhận
    assert protocol.verify_request(KEY, "POST", "/v1/models", b"{}", h, now) == "bad_timestamp"


async def test_server_answers_401_for_non_ascii_signature(box) -> None:  # noqa: F811
    body, h = _signed(box, "n-1")
    h[protocol.SIG_HEADER] = "é" * 64
    async with httpx.AsyncClient(transport=box.transport, base_url=URL) as c:
        r = await c.post("/v1/models", content=body, headers={k: v.encode("latin-1") for k, v in h.items()})
    assert r.status_code == 401 and r.json()["error"]["code"] == "unauthorized"


async def test_client_rejects_non_ascii_response_signature(box) -> None:  # noqa: F811
    from gh.agybox.client import AgyBoxClient
    from gh.providers.clients import ProviderError

    inner = box.transport

    class Evil(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
            r = await inner.handle_async_request(request)
            body = await r.aread()
            headers = [(k, v) for k, v in r.headers.raw if k.lower() not in (b"x-gh-sig", b"content-length")]
            return httpx.Response(r.status_code, headers=[*headers, (b"x-gh-sig", "é".encode("latin-1") * 64)],
                                  content=body)

    c = AgyBoxClient(URL, str(box.keyfile), 20, cli_home=str(box.home), transport=Evil(), clock=box.clock)
    with pytest.raises(ProviderError, match="chữ ký"):
        await c.list_models()


def test_client_compares_signatures_in_constant_time() -> None:
    import inspect

    from gh.agybox import client as boxclient

    src = inspect.getsource(boxclient.AgyBoxClient._call)
    assert "signature_equal" in src and "sig == P.response_signature" not in src
    assert "compare_digest" in inspect.getsource(protocol.signature_equal)
