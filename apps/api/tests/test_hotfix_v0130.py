"""v0.1.30 (hotfix) — lỗi "không có model" đúng khuôn lỗi chung.

Trước đây `ModelUnavailable` → `ApiError(503, …, detail={"reasons": […]})` và bước 8 trả `try_error = e.detail` (đối
tượng) → web vẽ đối tượng làm React child → màn /guide/8 sập (React error #31 "object with keys {reasons}").
Giờ: `detail` là câu chữ, `reasons` (danh sách chuỗi) ở cấp ngoài cùng; `try_error` luôn là chuỗi.
"""

from sqlalchemy import text

from gh.errors import MODEL_UNAVAILABLE_HINT, _body, model_unavailable
from tests.conftest import Api
from tests.phase2 import FakeRouter, org_id


def test_model_unavailable_body_has_code_message_and_top_level_reasons() -> None:
    e = model_unavailable("Chưa có model nào chạy được để dịch", ["gemini: 429", "", "deepseek: đang ngắt mạch"])
    body = _body(e.status, e.code, e.title, e.detail, e.extra)
    assert body["status"] == 503 and body["code"] == "MODEL_UNAVAILABLE"
    assert body["title"] == "Chưa có model nào chạy được để dịch"
    assert isinstance(body["detail"], str) and body["detail"] == MODEL_UNAVAILABLE_HINT
    assert body["reasons"] == ["gemini: 429", "deepseek: đang ngắt mạch"]


async def test_translate_503_detail_is_text_and_reasons_top_level(owner_api: Api, app) -> None:  # type: ignore[no-untyped-def]
    d = (await owner_api.send("POST", "/drafts", {"kind": "message", "title": "x", "text": "Chào anh"})).json()
    app.state.model_router = FakeRouter(down=True)
    for path, payload in ((f"/drafts/{d['id']}/translate", {"lang": "en"}), (f"/drafts/{d['id']}/regenerate", {})):
        r = await owner_api.send("POST", path, payload)
        assert r.status_code == 503
        body = r.json()
        assert body["code"] == "MODEL_UNAVAILABLE"
        assert isinstance(body["detail"], str) and "Agent & Model" in body["detail"]
        assert body["reasons"] == ["gemini: 429", "deepseek: đang ngắt mạch"]


async def test_step8_try_error_is_string_with_code_and_reasons(owner_api: Api, db, app) -> None:  # type: ignore[no-untyped-def]
    org = await org_id(db)
    await db.execute(text("UPDATE ops.setup_state SET completed = CAST(:c AS jsonb) WHERE org_id = :o"),
                     {"c": '{"steps": {"1": "done", "2": "done", "3": "done", "4": "done", "5": "done", '
                           '"6": "done", "7": "done"}}', "o": org})
    await db.commit()
    app.state.model_router = FakeRouter(down=True)
    r = await owner_api.send("PUT", "/setup/steps/8", {"name": "Trợ lý Mai", "role_desc": "Chăm sóc khách hàng",
                                                        "try_message": "Chào bạn"})
    assert r.status_code == 200, r.text
    agent = r.json()["agent"]
    assert agent["try_reply"] is None
    assert isinstance(agent["try_error"], str) and agent["try_error"] == MODEL_UNAVAILABLE_HINT
    assert agent["try_error_code"] == "MODEL_UNAVAILABLE"
    assert agent["try_reasons"] == ["gemini: 429", "deepseek: đang ngắt mạch"]
