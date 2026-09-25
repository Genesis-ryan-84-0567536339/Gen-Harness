"""/plugins — danh sách, bật/tắt, gỡ plugin (màn đầy đủ ở giai đoạn 4)."""

from typing import Any

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac, service
from gh.auth.deps import require, require_pin
from gh.chassis import actionlog
from gh.chassis.plugins import PluginError, PluginManager
from gh.db import DB
from gh.errors import ApiError, conflict, not_found

router = APIRouter(prefix="/plugins", tags=["plugins"])


class ToggleIn(BaseModel):
    enabled: bool


def _manager(request: Request) -> PluginManager:
    return request.app.state.plugins


def _plugin_error(e: PluginError) -> ApiError:
    if e.code == "NOT_FOUND":
        return not_found("Plugin")
    return conflict(e.code, str(e))


@router.get("")
async def list_plugins(request: Request, user: service.CurrentUser = Depends(require("system.read", rbac.ALL)),
                       db: AsyncSession = DB) -> list[dict[str, Any]]:
    live = {r["package"]: r for r in _manager(request).reports()}
    rows = (await db.execute(text("""
        SELECT p.package, p.name, p.layer, p.origin, p.version, p.is_enabled, p.load_order, p.sandbox,
               p.permissions, p.signature_ok, p.installed_at, p.manifest,
               COALESCE(array_agg(d.depends_on) FILTER (WHERE d.depends_on IS NOT NULL), '{}') AS deps
        FROM ops.plugins p LEFT JOIN ops.plugin_dependencies d ON d.plugin_id = p.id
        GROUP BY p.id ORDER BY p.origin <> 'core', p.load_order NULLS LAST, p.package"""))).all()
    out = []
    for r in rows:
        rep = live.get(r.package, {})
        manifest = r.manifest or {}
        out.append({
            "package": r.package, "name": r.name, "layer": r.layer, "origin": r.origin, "version": r.version,
            "description": manifest.get("description"), "enabled": r.is_enabled, "load_order": r.load_order,
            "removable": r.origin != "core" and bool(manifest.get("removable", True)),
            "can_disable": bool(manifest.get("can_disable", True)),
            "sandbox": r.sandbox, "permissions": r.permissions, "signature_ok": r.signature_ok,
            "installed_at": r.installed_at.isoformat(), "dependencies": list(r.deps),
            "health": rep.get("health", "healthy" if r.is_enabled else "disabled"),
            "breaker": rep.get("breaker", {"state": "closed", "total_errors": 0, "last_error": None}),
        })
    return out


@router.patch("/{package:path}/toggle")
async def toggle(package: str, body: ToggleIn, request: Request,
                 _: service.CurrentUser = Depends(require("system.manage", rbac.ALL)),
                 user: service.CurrentUser = Depends(require_pin("plugin.toggle")),
                 db: AsyncSession = DB) -> dict[str, Any]:
    pm = _manager(request)
    try:
        lp = await (pm.enable(package) if body.enabled else pm.disable(package))
    except PluginError as e:
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="plugin.enable" if body.enabled else "plugin.disable", target_type="plugin",
                               target_id=package, result="blocked", detail={"code": e.code, "reason": str(e)},
                               ip=user.ip)
        await db.commit()
        raise _plugin_error(e) from e
    await pm.broadcast("enable" if body.enabled else "disable", package, user.actor_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="plugin.enable" if body.enabled else "plugin.disable", target_type="plugin",
                           target_id=package, target_label=lp.manifest.name, ip=user.ip)
    return lp.report()


@router.delete("/{package:path}", status_code=204)
async def uninstall(package: str, request: Request, response: Response,
                    _: service.CurrentUser = Depends(require("system.manage", rbac.ALL)),
                    user: service.CurrentUser = Depends(require_pin("plugin.uninstall")),
                    db: AsyncSession = DB) -> Response:
    pm = _manager(request)
    try:
        name = pm.get(package).manifest.name
        await pm.uninstall(package)
    except PluginError as e:
        await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                               action="plugin.uninstall", target_type="plugin", target_id=package,
                               result="blocked", detail={"code": e.code, "reason": str(e)}, ip=user.ip)
        await db.commit()
        raise _plugin_error(e) from e
    await pm.broadcast("uninstall", package, user.actor_id)
    await actionlog.record(db, org_id=user.org_id, actor_type="user", actor_id=user.actor_id,
                           action="plugin.uninstall", target_type="plugin", target_id=package, target_label=name,
                           ip=user.ip)
    response.status_code = 204
    return response
