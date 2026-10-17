"""Gói sửa review v0.1.63 — các mục P3 của hộp riêng Antigravity (giao thức, server, client)."""

import json
from typing import Any

import httpx
import pytest

from gh.agybox import protocol, server
from tests.test_agybox_v0163 import KEY, SESSION, URL, _body, _raw, box  # noqa: F401 — fixture dùng chung


def _signed(box: Any, rid: str) -> tuple[bytes, dict[str, str]]:
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
