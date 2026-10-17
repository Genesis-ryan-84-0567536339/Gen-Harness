"""v0.1.70 (E1) — câu chữ sạch ở máy chủ: tên màn "API & Model", "khoá", MỘT bản gợi ý thiếu khoá nền, câu sao lưu đúng
vòng đời thật (GFS 7/4/12), `channels_connected` của Mặt tiền không coi kênh mất phiên là "ngày đầu".

Chạy cả quyền superuser và `GH_TEST_APP_ROLE=1`: `pytest -q tests/test_cau_chu_v0170.py`.
"""

import re
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import text

from gh import backup, errors
from gh.defaults import registry
from gh.owner import service as svc
from gh.refinery import jev_routes
from tests.conftest import Api
from tests.test_owner_v0155 import _org
from tests.test_owner_v0159 import channel

GH_DIR = Path(errors.__file__).parent


def test_model_unavailable_hint_names_the_real_screen() -> None:
    assert "API & Model" in errors.MODEL_UNAVAILABLE_HINT
    assert "Agent & Model" not in errors.MODEL_UNAVAILABLE_HINT


def test_jev_texts_use_khoa_with_oa() -> None:
    """Chính tả repo là «khoá»: không còn «khóa» trong chuỗi hiển thị của Jev (tiêu đề lỗi, hướng dẫn)."""
    src = Path(jev_routes.__file__).read_text(encoding="utf-8")
    assert not re.search(r"\b[Kk]hóa\b(?! học)", src)
    assert jev_routes.key_missing().title == "Chưa có khoá OpenRouter cho Jev"


def test_background_key_missing_has_one_text() -> None:
    """Hai nơi cùng nêu gợi ý `background_key_missing` (registry mặc định, Mặt tiền) dùng chung MỘT bản chữ."""
    assert svc.BG_SUGGESTION is registry.BACKGROUND_KEY_SUGGESTION
    assert svc.BG_SUGGESTION["title"] == "Cần 1 khoá API để chạy lọc tin và bản tin"
    assert "khóa" not in svc.BG_SUGGESTION["title"] + svc.BG_SUGGESTION["body"]


def test_backup_text_states_the_real_retention() -> None:
    """Không còn câu "giữ N bản" lấy từ `retention_count` (trường KHÔNG dùng): nói đúng vòng đời GFS của backup.py."""
    cfg = {"frequency": "daily", "time_of_day": "02:00", "retention_count": 7, "destination": "local"}
    s = registry._backup_text(cfg)
    assert (backup.DAILY_KEEP, backup.WEEKLY_KEEP, backup.MONTHLY_KEEP) == (7, 4, 12)
    assert "giữ 7 bản theo ngày, 4 theo tuần, 12 theo tháng" in s
    assert "retention" not in s and "giữ 7 bản ·" not in s
    assert registry._backup_text({**cfg, "retention_count": 3}) == s


async def _session(db: Any, ch: uuid.UUID, state: str, *, started: bool, ended: bool) -> None:
    await db.execute(text("""INSERT INTO core.channel_sessions (channel_id, account_label, state, started_at, ended_at)
                             VALUES (:c, 'tk', :s, CASE WHEN :st THEN now() END, CASE WHEN :en THEN now() END)"""),
                     {"c": ch, "s": state, "st": started, "en": ended})
    await db.commit()


async def test_channels_connected_keeps_expired_channel(owner_api: Api, db: Any) -> None:
    """Kênh nhận tin từng đăng nhập mà phiên hết hạn vẫn là "đã nối" (Mặt tiền không về thẻ ngày đầu)."""
    org = await _org(db)
    assert await svc.channels_connected(db, org) == 0
    zalo = await channel(db, org, "zalo")
    await _session(db, zalo, "pending_qr", started=False, ended=False)       # chờ QR chưa bao giờ đăng nhập
    assert await svc.channels_connected(db, org) == 0
    await _session(db, zalo, "expired", started=True, ended=True)            # từng đăng nhập, nay mất phiên
    assert await svc.channels_connected(db, org) == 1


async def test_channels_connected_skips_non_intake_channels(owner_api: Api, db: Any) -> None:
    org = await _org(db)
    for kind in ("telegram", "facebook", "linkedin"):                        # không đưa tin khách về Thông tin
        await _session(db, await channel(db, org, kind), "active", started=True, ended=False)
    assert await svc.channels_connected(db, org) == 0
