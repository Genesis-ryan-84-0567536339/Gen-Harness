"""Review lần 2 gói sửa v0.1.63 — các mục P3 phía agy trong tiến trình (`gh.providers.clients`).

- P3-1: chép ngược token làm mới (`sync_token_back`) không lấy được khoá ⇒ BỎ ghi (trước: đi tiếp ghi không khoá); lượt
  agy chờ khoá đó trong luồng phụ (trước: `time.sleep` của `_try_flock` chặn vòng lặp sự kiện tới 2 giây).
- P3-5: `_workdir()` rò khi `make_turn_home` ném lỗi; HOME tạm `gh-agy-home-*` (chứa token) / `gh-agy-*` còn lại sau khi
  tiến trình bị SIGKILL (api/worker không có tmpfs /tmp) được dọn khi khởi động."""

import asyncio
import json
import threading
import time
from pathlib import Path

from gh.providers import clients
from gh.providers.clients import TOKEN_FILE
from tests.test_agy_home_tam_v0163fix import TOKEN, _agy, _say, vol  # noqa: F401 — fixture dùng chung

NEW = json.dumps({**json.loads(TOKEN), "access_token": "tok-moi"}).encode()


# ─── P3-1 ──────────────────────────────────────────────────────────────────────────────────────────────────────

def test_sync_back_without_the_lock_skips_the_write(vol: Path) -> None:  # noqa: F811
    with clients.token_flock(vol, exclusive=True, wait=1) as held:   # người ghi khác đang giữ khoá
        assert held
        assert clients.sync_token_back(str(vol), TOKEN, NEW, wait=0.2) is False
        assert (vol / TOKEN_FILE).read_bytes() == TOKEN
    assert clients.sync_token_back(str(vol), TOKEN, NEW, wait=0.2) is True   # có khoá ⇒ ghi
    assert (vol / TOKEN_FILE).read_bytes() == NEW


async def test_turn_waits_for_the_sync_lock_off_the_event_loop(tmp_path: Path, vol: Path) -> None:  # noqa: F811
    """Một người ghi khác giữ khoá 3 giây: lượt REFRESH chờ khoá (2 giây) KHÔNG chặn vòng lặp, rồi bỏ ghi."""
    release = threading.Event()
    holding = threading.Event()

    def hold() -> None:
        with clients.token_flock(vol, exclusive=True, wait=1):
            holding.set()
            release.wait(10)

    t = threading.Thread(target=hold)
    t.start()
    assert holding.wait(5)
    worst = 0.0
    stop = False

    async def tick() -> None:
        nonlocal worst
        while not stop:
            t0 = time.monotonic()
            await asyncio.sleep(0.05)
            worst = max(worst, time.monotonic() - t0)

    ticker = asyncio.create_task(tick())
    try:
        assert await _say(_agy(tmp_path, vol), "REFRESH") == "echo:REFRESH"
    finally:
        stop = True
        await ticker
        release.set()
        t.join(10)
    assert worst < 1.0, f"vòng lặp sự kiện bị chặn {worst:.2f}s"
    assert (vol / TOKEN_FILE).read_bytes() == TOKEN                  # không có khoá ⇒ không ghi đè
