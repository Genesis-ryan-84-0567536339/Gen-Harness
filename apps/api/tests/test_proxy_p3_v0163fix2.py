"""Review lần 2 gói sửa v0.1.63 — P3 phía api: tin proxy chuyển tiếp.

- P3-2: tên trong `GH_TRUSTED_PROXIES` (mặc định `proxy`) được phân giải lại mỗi 30 giây bằng `getaddrinfo` — trước
  đây chạy ngay trong luồng xử lý yêu cầu (chặn vòng lặp sự kiện khi DNS chậm). Nay phân giải trong luồng nền; yêu cầu
  dùng kết quả gần nhất (lần đầu chưa có ⇒ chỉ loopback + IP/CIDR ghi sẵn — đóng an toàn); api làm ấm lúc khởi động."""

import threading
import time
from pathlib import Path
from typing import Any

import pytest

from gh.auth import deps
from gh.config import get_settings
from tests.test_forwarded_tin_proxy_v0163fix import _req

API_DIR = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _fresh(monkeypatch: pytest.MonkeyPatch):  # type: ignore[no-untyped-def]
    deps.reset_trusted_proxy_cache()
    monkeypatch.setattr(get_settings(), "access_mode", "")
    monkeypatch.setattr(get_settings(), "bind_addr", "")
    monkeypatch.setattr(get_settings(), "trusted_proxies", "proxy")
    yield
    deps.reset_trusted_proxy_cache()


def _slow_resolver(monkeypatch: pytest.MonkeyPatch, ip: str, delay: float = 0.5) -> list[int]:
    threads: list[int] = []

    def resolve(host: str) -> list[str]:
        threads.append(threading.get_ident())
        time.sleep(delay)
        return [ip] if host == "proxy" else []

    monkeypatch.setattr(deps, "_resolve", resolve)
    return threads


def _wait_trusted(peer: str, timeout: float = 5.0) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if deps.client_ip(_req({"X-Forwarded-For": "203.0.113.7"}, peer)) == "203.0.113.7":
            return True
        time.sleep(0.05)
    return False


def test_name_resolution_never_blocks_the_request(monkeypatch: pytest.MonkeyPatch) -> None:
    threads = _slow_resolver(monkeypatch, "172.18.0.9")
    t0 = time.monotonic()
    first = deps.client_ip(_req({"X-Forwarded-For": "203.0.113.7"}, "172.18.0.9"))
    assert time.monotonic() - t0 < 0.3                       # không chờ DNS
    assert first == "172.18.0.9"                              # chưa phân giải xong ⇒ chưa tin (đóng an toàn)
    assert _wait_trusted("172.18.0.9")
    assert threads and threading.get_ident() not in threads    # getaddrinfo chạy ở luồng nền


def test_stale_cache_is_used_while_refreshing_in_background(monkeypatch: pytest.MonkeyPatch) -> None:
    _slow_resolver(monkeypatch, "172.18.0.9", delay=0.0)
    deps.refresh_trusted_proxies()                            # làm ấm (lúc khởi động api)
    assert deps.client_ip(_req({"X-Forwarded-For": "203.0.113.7"}, "172.18.0.9")) == "203.0.113.7"
    threads = _slow_resolver(monkeypatch, "172.18.0.20")      # proxy tạo lại đổi IP
    raw = get_settings().trusted_proxies
    ts, nets = deps._trust_cache[raw]                         # noqa: SLF001
    deps._trust_cache[raw] = (ts - 3600, nets)                # noqa: SLF001 — quá hạn 30 giây
    t0 = time.monotonic()
    assert deps.client_ip(_req({"X-Forwarded-For": "203.0.113.7"}, "172.18.0.9")) == "203.0.113.7"   # bản cũ
    assert time.monotonic() - t0 < 0.3
    assert _wait_trusted("172.18.0.20")
    assert threading.get_ident() not in threads


def test_literal_entries_need_no_dns(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(host: str) -> list[str]:
        raise AssertionError("không được phân giải")

    monkeypatch.setattr(deps, "_resolve", boom)
    monkeypatch.setattr(get_settings(), "trusted_proxies", "172.18.0.0/16, 10.0.0.1")
    assert deps.client_ip(_req({"X-Forwarded-For": "203.0.113.7"}, "172.18.0.5")) == "203.0.113.7"


def test_api_warms_the_trusted_proxy_cache_at_startup() -> None:
    src = (API_DIR / "gh" / "app.py").read_text(encoding="utf-8")
    assert "asyncio.to_thread(deps.refresh_trusted_proxies)" in src


def test_resolution_is_not_called_inline(monkeypatch: pytest.MonkeyPatch) -> None:
    """Gọi `_trusted_networks()` từ luồng chính không bao giờ gọi `_resolve` ngay trong luồng đó."""
    seen: list[Any] = []

    def resolve(host: str) -> list[str]:
        seen.append(threading.get_ident())
        return ["172.18.0.9"]

    monkeypatch.setattr(deps, "_resolve", resolve)
    deps._trusted_networks()                                  # noqa: SLF001
    deps._trusted_networks()                                  # noqa: SLF001
    end = time.monotonic() + 5
    while not seen and time.monotonic() < end:
        time.sleep(0.02)
    assert seen and threading.get_ident() not in seen
