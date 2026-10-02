"""/boss-checks — kiểm thật từng dòng trang "Việc Sếp cần làm" (v0.1.39). CHỈ Owner (+ `system.manage`).

- `GET /boss-checks` — chốt các lượt đọc Facebook đang chờ rồi trả {rows, results, required_done, required_total}.
- `POST /boss-checks/{key}/run` — chạy một mục kiểm (`hub`, `facebook`, `agy_call`, `agy_switch`, `claude_call`, `jev`)
  và GHI kết quả. Lỗi nghiệp vụ (chưa cấu hình, 409/429 từ dịch vụ, gọi thử lỗi) vẫn 200 với `status: 'fail'` + mã lỗi
  thống nhất; chỉ 401/403/422/423 mới ném. `hub` và `agy_switch` cần phiên PIN (423 → web hỏi PIN rồi gửi lại).
- Phản hồi cho Owner được kèm email ĐẦY ĐỦ (`account`); CSDL chỉ lưu email đã che.
"""

import uuid
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import require, require_owner
from gh.boss_checks import service as boss
from gh.chassis import actionlog
from gh.db import DB
from gh.errors import ApiError, field_errors, not_found, pin_required
from gh.hub_link import service as hub
from gh.providers import cli as climod
from gh.social import service as social_service

router = APIRouter(prefix="/boss-checks", tags=["boss-checks"])
MANAGE = require("system.manage", rbac.ALL)
PIN_KEYS = ("hub", "agy_switch")
RAISE_STATUSES = (401, 403, 422, 423)
CALL_KINDS = {"agy_call": "antigravity_cli", "claude_call": "claude_code_cli", "jev": "system_one"}
NOT_READY = {
    "agy_call": ("AGY_NOT_LOGGED_IN", "Chưa đăng nhập Google (Antigravity CLI) — bấm Đăng nhập Google trước"),
    "claude_call": ("CLAUDE_NOT_LOGGED_IN", "Chưa đăng nhập Claude Code — bấm Đăng nhập Claude Code trước"),
    "jev": ("JEV_NOT_CONFIGURED", "Chưa thêm Jev — mục này không bắt buộc; thêm khoá Jev ở Agent & Model nếu Sếp cần"),
}
SOCIAL_NO_ACCOUNT_MSG = "Chưa có tài khoản Facebook — mở trang Tài khoản mạng xã hội để thêm và đăng nhập"


class BossRunIn(BaseModel):
    profile_id: uuid.UUID | None = None
    account_id: uuid.UUID | None = None


@router.get("")
async def get_checks(_m: service.CurrentUser = Depends(MANAGE), user: service.CurrentUser = Depends(require_owner),
                     db: AsyncSession = DB) -> dict[str, Any]:
    await boss.resolve_pending(db, user.org_id)
    await db.commit()
    return await boss.overview(db, user.org_id)


@router.post("/{key}/run")
async def run_check(key: str, request: Request, body: BossRunIn | None = None,
                    _m: service.CurrentUser = Depends(MANAGE), user: service.CurrentUser = Depends(require_owner),
                    db: AsyncSession = DB) -> dict[str, Any]:
    if key not in boss.RUNNABLE:
        raise not_found("Mục kiểm")
    if key in PIN_KEYS and not user.pin_active():
        raise pin_required()
    body = body or BossRunIn()
    if key == "agy_switch" and body.profile_id is None:
        raise field_errors({"profile_id": "Chọn tài khoản Google cần đổi sang"})
    try:
        if key == "hub":
            return await _run_hub(request, db, user)
        if key == "facebook":
            return await _run_facebook(request, db, user, body.account_id)
        if key == "agy_switch":
            assert body.profile_id is not None
            return await _run_switch(request, db, user, body.profile_id)
        return await _run_call(request, db, user, key)
    except ApiError as e:
        if e.status in RAISE_STATUSES:
            raise
        # Lỗi nghiệp vụ (409/429/404…): câu của dịch vụ đã thân thiện → ghi thành một lần kiểm "Lỗi".
        await db.rollback()
        return await boss.record(db, user.org_id, key, "fail", error_code=e.code, message=e.title,
                                 user_id=user.id)


# ─── từng mục ───────────────────────────────────────────────────────────────

async def _run_hub(request: Request, db: AsyncSession, user: service.CurrentUser) -> dict[str, Any]:
    client = hub.client_for(getattr(request.app.state, "mcp_transport", None))
    r = await hub.test_link(db, request.app.state.redis, client, user=user)
    ok = bool(r["ok"])
    detail = {"latency_ms": r.get("latency_ms"), "exposed_tools": len(r.get("exposed_tools") or []),
              "missing_tools": list(r.get("missing_tools") or [])}
    return await boss.record(db, user.org_id, "hub", "pass" if ok else "fail",
                             error_code=None if ok else (r.get("error_code") or "HUB_ERROR"),
                             message=None if ok else r.get("error"), detail=detail, user_id=user.id)


async def _run_facebook(request: Request, db: AsyncSession, user: service.CurrentUser,
                        account_id: uuid.UUID | None) -> dict[str, Any]:
    if account_id is None:
        account_id = (await db.execute(text("""
            SELECT id FROM core.social_accounts WHERE org_id = :o AND platform LIKE 'facebook%'
            ORDER BY (status = 'active') DESC, created_at LIMIT 1"""), {"o": user.org_id})).scalar_one_or_none()
    if account_id is None:
        return await boss.record(db, user.org_id, "facebook", "fail", error_code="SOCIAL_NO_ACCOUNT",
                                 message=SOCIAL_NO_ACCOUNT_MSG, user_id=user.id)
    job = await social_service.request_read(db, request.app.state.redis, org_id=user.org_id, account_id=account_id,
                                            via="user", user=user)
    return await boss.record(db, user.org_id, "facebook", "pending", detail={"job_status": job["status"]},
                             ref_id=uuid.UUID(job["id"]), user_id=user.id)


async def _provider(db: AsyncSession, org_id: uuid.UUID, kind: str) -> Any:
    return (await db.execute(text("""
        SELECT p.id, p.name, EXISTS (SELECT 1 FROM agent.cli_profiles c WHERE c.provider_id = p.id AND c.is_active
                                     AND c.token_enc IS NOT NULL) AS has_session
        FROM agent.providers p WHERE p.org_id = :o AND p.kind = :k ORDER BY p.created_at LIMIT 1"""),
        {"o": org_id, "k": kind})).one_or_none()


async def _probe(request: Request, db: AsyncSession, user: service.CurrentUser, p: Any, kind: str) -> dict[str, Any]:
    """Gọi thử thật (như POST /providers/{id}/test): hạn mức gọi thử cho CLI, commit trước lượt gọi dài."""
    from gh.system_api.routes import _probe_budget

    if kind in climod.CLI_KINDS:
        await _probe_budget(request.app.state.redis, user.org_id)
    await db.commit()
    result: dict[str, Any] = await request.app.state.model_router.test_provider(p.id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id, action="provider.tested",
                           target_type="provider", target_id=str(p.id), target_label=p.name,
                           result="ok" if result["ok"] else "failed",
                           detail={"error": result["error"], "via": "boss_checks"}, ip=user.ip)
    return result


def _call_detail(result: dict[str, Any]) -> dict[str, Any]:
    return {"latency_ms": result.get("latency_ms"), "probe_model": result.get("probe_model"),
            "models_count": len(result.get("models") or []), "models_source": result.get("models_source"),
            "account_masked": boss.mask_email(result.get("account"))}


async def _run_call(request: Request, db: AsyncSession, user: service.CurrentUser, key: str) -> dict[str, Any]:
    kind = CALL_KINDS[key]
    p = await _provider(db, user.org_id, kind)
    if p is None or (kind in climod.CLI_KINDS and not p.has_session):
        code, msg = NOT_READY[key]
        return await boss.record(db, user.org_id, key, "fail", error_code=code, message=msg, user_id=user.id)
    result = await _probe(request, db, user, p, kind)
    ok = bool(result["ok"])
    out = await boss.record(db, user.org_id, key, "pass" if ok else "fail",
                            error_code=None if ok else (result.get("error_code") or "PROVIDER_ERROR"),
                            message=None if ok else result.get("error"), detail=_call_detail(result),
                            user_id=user.id)
    if kind in climod.CLI_KINDS:
        out["account"] = result.get("account")
    return out


async def _run_switch(request: Request, db: AsyncSession, user: service.CurrentUser,
                      profile_id: uuid.UUID) -> dict[str, Any]:
    row = (await db.execute(text("""SELECT c.email, p.kind FROM agent.cli_profiles c
                                    JOIN agent.providers p ON p.id = c.provider_id
                                    WHERE c.id = :i AND c.org_id = :o"""),
                            {"i": profile_id, "o": user.org_id})).one_or_none()
    if row is None:
        raise not_found("Tài khoản Google")
    if row.kind != climod.AGY:
        raise field_errors({"profile_id": "Đây không phải tài khoản Google / Antigravity"})
    if request.app.state.cli_logins.busy(user.org_id, climod.AGY):
        return await boss.record(db, user.org_id, "agy_switch", "fail", error_code="CLI_LOGIN_IN_PROGRESS",
                                 message="Đang đăng nhập thêm một tài khoản — hoàn tất hoặc huỷ bước đó rồi đổi "
                                         "tài khoản", user_id=user.id)
    from gh.system_api.routes import _probe_budget

    # Đổi tài khoản rồi gọi thử THẬT — kiểm hạn mức trước để không đổi mà không kiểm được.
    await _probe_budget(request.app.state.redis, user.org_id)
    out = await climod.activate(db, user.org_id, profile_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="cli.account_switched", target_type="cli_profile", target_id=out["id"],
                           target_label=out["email"], detail={"via": "boss_checks"}, ip=user.ip)
    await db.commit()
    p = await _provider(db, user.org_id, climod.AGY)
    result: dict[str, Any] = await request.app.state.model_router.test_provider(p.id)
    expected, actual = out["email"], result.get("account")
    match = bool(expected and actual and str(expected).lower() == str(actual).lower())
    detail = {"expected_masked": boss.mask_email(expected), "account_masked": boss.mask_email(actual),
              "account_match": match, "latency_ms": result.get("latency_ms")}
    if not result["ok"]:
        status, code, msg = "fail", result.get("error_code") or "PROVIDER_ERROR", result.get("error")
    elif match:
        status, code, msg = "pass", None, None
    else:
        status, code = "fail", "AGY_ACCOUNT_MISMATCH"
        msg = (f"Đã đổi sang {boss.mask_email(expected) or 'tài khoản này'} nhưng lượt gọi thử vẫn chạy bằng tài khoản "
               "khác — bấm Đăng nhập lại tài khoản này")
    rec = await boss.record(db, user.org_id, "agy_switch", status, error_code=code, message=msg, detail=detail,
                            user_id=user.id)
    rec["account"] = actual
    return rec


__all__ = ["router"]
