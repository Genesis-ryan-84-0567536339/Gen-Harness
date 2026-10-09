"""v0.1.49 (QD-16) — Bản tin Gen có 3 mục từ Gen-hub: "Lịch hôm nay", "Mail cần trả lời", "Việc đang mở".

`gh.hub_link.service.briefing_read` được thay bằng bản giả (không phụ thuộc chi tiết Gen-hub): kiểm thứ tự mục, trạng
thái ok/empty/error/breaker, mục bị ẩn (chưa nối / thiếu quyền) gom thành MỘT dòng nhắc + nút "Mở Gen-hub", chuông,
và Telegram chỉ có số đếm (không tiêu đề mail/lịch)."""

from datetime import datetime
from typing import Any

import orjson
import pytest
from sqlalchemy import text

from gh.db import sessionmaker
from gh.gen import briefing
from gh.hub_link import service as hub
from gh.telegram import service as telegram
from tests.phase2 import org_id
from tests.test_briefing_v0141 import _bells, _messages, _router, _says, _today

TOKEN = "ghtok_SieuBiMat_1234567890abcdef"
OLD_KEYS = ["tasks_due", "hot_customers", "drafts_pending", "incidents"]
HUB_BUTTON = {"kind": "suggest", "items": [{"label": "Mở Gen-hub", "action": {
    "type": "navigate", "screen": "connections"}}]}

CAL = [{"start": "2026-10-09T09:00:00+07:00", "all_day": False, "title": "Họp nhà cung cấp ván MDF"},
       {"start": "2026-10-09", "all_day": True, "title": "Nghỉ lễ"}]
MAIL = [{"id": "18c2f41234567890", "from": "Anh Bảo <[đã che]>", "subject": "Báo giá ván MDF E1", "date": ""},
        {"id": "18c2f41234567891", "from": "Công ty Hải Long", "subject": "Xác nhận lịch giao", "date": ""},
        {"id": "18c2f41234567892", "from": "", "subject": "Hỏi bảo hành", "date": ""}]
TASKS = [{"id": "task-1", "title": "Gọi nhà cung cấp keo", "due": "2026-10-10T00:00:00.000Z"}]
ITEMS = {"calendar_today": CAL, "mail_reply": MAIL, "tasks_open": TASKS}
SCOPE = {"calendar_today": "calendar", "mail_reply": "mail", "tasks_open": "tasks"}


class FakeRead:
    """Thay `hub.briefing_read`: `states[kind]` = ok|empty|off|missing_scope|breaker_open|error|raise."""

    def __init__(self, **states: str) -> None:
        self.states = states
        self.calls: list[str] = []

    async def __call__(self, sm: Any, redis: Any, *, org_id: Any, kind: str, now: datetime,
                       transport: Any = None) -> dict[str, Any]:
        self.calls.append(kind)
        st = self.states.get(kind, "ok")
        base: dict[str, Any] = {"state": st, "items": [], "error_code": None, "detail": None, "scope": SCOPE[kind]}
        if st == "ok":
            base["items"] = ITEMS[kind]
        elif st == "empty":
            base["state"] = "ok"
        elif st == "off":
            base.update(error_code="HUB_LINK_OFF", detail="Chưa nối Gen-hub")
        elif st == "missing_scope":
            base.update(error_code="HUB_TOOL_MISSING", detail="Thiếu tool")
        elif st == "breaker_open":
            base.update(error_code="HUB_BREAKER_OPEN", detail="Gen-hub tạm không trả lời — thử lại sau ít phút")
        elif st == "error":
            base.update(error_code="HUB_UNAVAILABLE", detail="Gen-hub trả 502")
        elif st == "raise":
            raise RuntimeError(f"hỏng {TOKEN}")
        return base


async def _linked(db: Any, enabled: bool = True) -> None:
    org = await org_id(db)
    await db.execute(text("""INSERT INTO agent.hub_links (org_id, enabled) VALUES (:o, :e)
                             ON CONFLICT (org_id) DO UPDATE SET enabled = :e"""), {"o": org, "e": enabled})
    await db.commit()


async def _run(db: Any, redis: Any, monkeypatch: pytest.MonkeyPatch, fake: FakeRead, *,
               linked: bool | None = True) -> dict[str, Any]:
    monkeypatch.setattr(hub, "briefing_read", fake)
    if linked is not None:
        await _linked(db, enabled=linked)
    out = await briefing.run_briefing(sessionmaker(), redis, _router(redis), now=_today(7, 31))
    assert out[str(await org_id(db))] == "sent"
    return (await _messages(db))[0]


def _secs(c: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {s["key"]: s for s in c["sections"]}


def _hub_buttons(c: dict[str, Any]) -> int:
    return sum(1 for st in c["steps"] if st == HUB_BUTTON)


async def test_three_sections_ok(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    fake = FakeRead()
    c = await _run(db, redis, monkeypatch, fake)
    assert fake.calls == ["calendar_today", "mail_reply", "tasks_open"]
    keys = [s["key"] for s in c["sections"]]
    assert keys == [*OLD_KEYS, "calendar_today", "mail_reply", "gtasks_open", "kho"]
    s = _secs(c)
    cal = s["calendar_today"]
    assert cal["title"] == "Lịch hôm nay" and cal["count"] == 2 and cal["state"] == "ok" and cal["external"] is True
    assert cal["lines"] == ["09:00 · Họp nhà cung cấp ván MDF", "Cả ngày · Nghỉ lễ"]
    assert cal["link"] == "/connections#genhub" and cal["detail"] is None
    mail = s["mail_reply"]
    assert mail["title"] == "Mail cần trả lời" and mail["count"] == 3 and mail["external"] is True
    assert mail["lines"] == ["Anh Bảo — Báo giá ván MDF E1", "Công ty Hải Long — Xác nhận lịch giao", "Hỏi bảo hành"]
    tasks = s["gtasks_open"]
    assert tasks["title"] == "Việc đang mở" and tasks["count"] == 1
    assert tasks["lines"] == ["Gọi nhà cung cấp keo — hạn 10/10"]
    # Thẻ Gen-hub do web vẽ từ `sections` ⇒ không có bước say trùng; không có dòng nhắc / nút Mở Gen-hub.
    says = _says(c)
    assert "Lịch hôm nay" not in says and "Mail cần trả lời" not in says and "Họp nhà cung cấp" not in says
    assert c["hub_hint"] is None and _hub_buttons(c) == 0
    bell = (await _bells(db))[0]
    assert "2 lịch hôm nay" in bell.body and "3 mail cần trả lời" in bell.body
    assert "1 việc Google đang mở" in bell.body
    tg = telegram.briefing_text("sáng 09/10", None, c["sections"])
    assert "• Lịch hôm nay (2)" in tg and "• Mail cần trả lời (3)" in tg and "• Việc đang mở (1)" in tg
    assert "Họp nhà cung cấp" not in tg and "Báo giá ván MDF" not in tg and "Gọi nhà cung cấp keo" not in tg


async def test_missing_scope_hidden_one_hint(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    c = await _run(db, redis, monkeypatch, FakeRead(mail_reply="missing_scope"))
    keys = [s["key"] for s in c["sections"]]
    assert "mail_reply" not in keys and "calendar_today" in keys and "gtasks_open" in keys
    hint = c["hub_hint"]
    assert isinstance(hint, str) and "đọc mail" in hint and "Kiểm tra" in hint and "mail cần trả lời" in hint
    assert "đọc lịch" not in hint
    says = [st["text"] for st in c["steps"] if st["kind"] == "say"]
    assert says.count(hint) == 1 and _hub_buttons(c) == 1


async def test_two_missing_scopes_one_line(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    c = await _run(db, redis, monkeypatch, FakeRead(calendar_today="missing_scope", mail_reply="missing_scope"))
    hint = c["hub_hint"]
    assert "lịch hôm nay, mail cần trả lời" in hint and "đọc lịch/đọc mail" in hint
    assert [s["key"] for s in c["sections"]] == [*OLD_KEYS, "gtasks_open", "kho"]
    assert sum(1 for st in c["steps"] if st["kind"] == "say" and st["text"] == hint) == 1
    assert _hub_buttons(c) == 1


async def test_off_hidden_hint_connect(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    c = await _run(db, redis, monkeypatch, FakeRead(calendar_today="off", mail_reply="off", tasks_open="off"),
                   linked=False)
    assert [s["key"] for s in c["sections"]] == OLD_KEYS          # khoá như v0.1.41 (liên kết tắt ⇒ không có Kho)
    assert c["hub_hint"] == briefing.HUB_HINT_OFF and "nối Gen-hub" in c["hub_hint"]
    assert _hub_buttons(c) == 1 and _says(c).count(briefing.HUB_HINT_OFF) == 1


async def test_never_configured_no_call_no_hint(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """Tổ chức chưa từng cấu hình Gen-hub ⇒ không gọi Gen-hub, không nhắc (không làm phiền mỗi bản tin)."""
    fake = FakeRead()
    c = await _run(db, redis, monkeypatch, fake, linked=None)
    assert fake.calls == [] and c["hub_hint"] is None and _hub_buttons(c) == 0
    assert [s["key"] for s in c["sections"]] == OLD_KEYS


async def test_breaker(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    fake = FakeRead(calendar_today="breaker_open", mail_reply="breaker_open", tasks_open="breaker_open")
    c = await _run(db, redis, monkeypatch, fake)
    assert fake.calls == ["calendar_today", "mail_reply", "tasks_open"]   # vẫn gọi đủ (hub tự chặn, không tốn mạng)
    for key in ("calendar_today", "mail_reply", "gtasks_open"):
        s = _secs(c)[key]
        assert s["state"] == "breaker" and s["lines"] == ["Gen-hub tạm không trả lời"] and s["count"] == 0
        assert s["detail"] == "HUB_BREAKER_OPEN" and s["external"] is True
    assert c["hub_hint"] is None
    tg = telegram.briefing_text("sáng 09/10", None, c["sections"])
    assert "• Lịch hôm nay: Gen-hub tạm không trả lời" in tg.splitlines()


async def test_error_and_exception(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    c = await _run(db, redis, monkeypatch, FakeRead(calendar_today="error", mail_reply="raise", tasks_open="empty"))
    s = _secs(c)
    cal = s["calendar_today"]
    assert cal["state"] == "error" and cal["lines"] == [briefing.SECTION_ERROR] and cal["count"] == 0
    assert isinstance(cal["detail"], str) and cal["detail"] == "HUB_UNAVAILABLE: Gen-hub trả 502"
    mail = s["mail_reply"]
    assert mail["state"] == "error" and mail["lines"] == [briefing.SECTION_ERROR]
    assert isinstance(mail["detail"], str) and "RuntimeError" in mail["detail"]
    assert s["gtasks_open"]["state"] == "empty" and s["gtasks_open"]["count"] == 0 and s["gtasks_open"]["lines"] == []
    body = orjson.dumps(c).decode()
    assert TOKEN not in body and "hỏng" not in body
    assert len(await _bells(db)) == 1                                       # bản tin vẫn gửi
    assert briefing.SECTION_ERROR not in _says(c)                          # lỗi mục Gen-hub nằm ở thẻ, không ở say


async def test_empty_state(owner_api, db, redis, monkeypatch) -> None:  # type: ignore[no-untyped-def]
    c = await _run(db, redis, monkeypatch, FakeRead(calendar_today="empty", mail_reply="empty", tasks_open="empty"))
    for key in ("calendar_today", "mail_reply", "gtasks_open"):
        assert _secs(c)[key]["state"] == "empty" and _secs(c)[key]["count"] == 0
    assert briefing.NOTHING in _says(c)                                    # NOTHING tính theo count mọi mục
    assert briefing.NOTHING in (await _bells(db))[0].body


def test_line_formats() -> None:
    assert briefing._event_line({"start": "2026-10-09T02:00:00Z", "all_day": False, "title": "A"}) == "09:00 · A"
    assert briefing._event_line({"start": "2026-10-09 14:30", "all_day": False, "title": "B"}) == "14:30 · B"
    assert briefing._event_line({"start": "9:05-10:00", "all_day": False, "title": "C"}) == "09:05 · C"
    assert briefing._event_line({"start": "", "all_day": False, "title": "D"}) == "D"
    assert briefing._event_line({"start": "2026-10-09", "all_day": True, "title": "E"}) == "Cả ngày · E"
    assert briefing._mail_line({"from": "", "subject": ""}) == "(không có tiêu đề)"
    assert briefing._mail_line({"from": '"Chị Mai" <x>', "subject": "Hỏi"}) == "Chị Mai — Hỏi"
    assert briefing._task_line({"title": "T", "due": ""}) == "T"


def test_telegram_counts_only() -> None:
    secs = [{"key": "tasks_due", "title": "Việc đến hạn", "count": 1, "lines": ["Gọi lại anh Bình"], "link": "/tasks"},
            {"key": "mail_reply", "title": "Mail cần trả lời", "count": 3, "external": True, "state": "ok",
             "lines": ["Anh Bảo — Báo giá ván MDF E1", "Chị Mai — Hỏi bảo hành"], "link": "/connections#genhub"},
            {"key": "calendar_today", "title": "Lịch hôm nay", "count": 0, "external": True, "state": "empty",
             "lines": [], "link": "/connections#genhub"}]
    out = telegram.briefing_text("sáng 09/10", None, secs)
    assert "• Mail cần trả lời (3)" in out.splitlines()
    assert "Báo giá ván MDF" not in out and "Anh Bảo" not in out and "Lịch hôm nay" not in out
    assert "• Việc đến hạn (1): Gọi lại anh Bình" in out                  # mục nội bộ giữ nguyên
