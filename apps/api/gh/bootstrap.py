"""Khởi tạo hệ thống khi khởi động (idempotent).

Một bản cài = một tổ chức. Lần đầu: tạo tổ chức, vai trò, quyền theo ma trận mặc định, ranh giới có trách nhiệm,
dòng plugin nền, trạng thái thiết lập kèm mã thiết lập một lần. Chạy lại không ghi đè chỉnh sửa của Owner,
trừ các khoá cứng (ARCHITECTURE §7.4) luôn được đặt lại đúng giá trị.
"""

import json
import logging
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.auth import rbac
from gh.chassis import policy
from gh.chassis.plugins import Manifest, read_manifests
from gh.config import get_settings
from gh.crypto import new_token, token_digest

log = logging.getLogger("gh.bootstrap")

DEFAULT_ORG_NAME = "Gen-Harness"


@dataclass(frozen=True)
class Boundary:
    code: str
    enabled: bool
    locked: bool
    params: dict[str, object] | None = None


# Ranh giới có trách nhiệm (thiết kế: boundaries) + các khoá cứng không có công tắc trên màn hình.
BOUNDARIES = (
    Boundary("listen_authorized_only", True, True),
    Boundary("disclose_staff_observation", True, False),
    Boundary("hide_sensitive_below_owner", True, True),
    Boundary("personnel_alert_requires_evidence", True, True),
    Boundary("observe_external_market", True, False),
    Boundary("auto_personnel_decisions", False, True),
    Boundary("approval_gate", True, True, {"approval_threshold_vnd": policy.DEFAULT_APPROVAL_THRESHOLD_VND}),
    Boundary("mcp_write_requires_approval", True, True),
)


@dataclass
class BootstrapResult:
    org_id: uuid.UUID
    setup_token: str | None       # chỉ có khi vừa sinh mới (in ra log một lần)
    setup_finished: bool


def plugins_root() -> Path:
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "plugins").is_dir() and (parent / "plugins" / "chassis-kernel").is_dir():
            return parent / "plugins"
    return Path("/app/plugins")


async def bootstrap(db: AsyncSession, *, manifests: list[Manifest] | None = None) -> BootstrapResult:
    await db.execute(text("SELECT pg_advisory_xact_lock(hashtext('gh.bootstrap'))"))
    org_id = (await db.execute(text("SELECT id FROM core.organizations ORDER BY created_at LIMIT 1"))).scalar()
    if org_id is None:
        org_id = (await db.execute(text(
            "INSERT INTO core.organizations (name, settings) VALUES (:n, CAST(:s AS jsonb)) RETURNING id"),
            {"n": DEFAULT_ORG_NAME, "s": json.dumps({"autonomy_level": policy.DEFAULT_AUTONOMY})})).scalar_one()
        log.info("Đã tạo tổ chức %s", org_id)

    await _permissions(db, org_id)
    await _boundaries(db, org_id)
    await _chassis_plugins(db, manifests if manifests is not None else read_manifests(plugins_root()))
    token, finished = await _setup_state(db, org_id)
    return BootstrapResult(org_id=org_id, setup_token=token, setup_finished=finished)


async def _permissions(db: AsyncSession, org_id: uuid.UUID) -> None:
    for code, label in rbac.PERMISSIONS.items():
        await db.execute(text("""INSERT INTO core.permissions (code, label_vi) VALUES (:c, :l)
                                 ON CONFLICT (code) DO UPDATE SET label_vi = EXCLUDED.label_vi"""),
                         {"c": code, "l": label})
    for role in rbac.ROLES:
        role_id = (await db.execute(text("""
            INSERT INTO core.roles (org_id, code, name, is_system) VALUES (:o, :c, :n, true)
            ON CONFLICT (org_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id"""),
            {"o": org_id, "c": role.code, "n": role.name})).scalar_one()
        for perm, scope in rbac.DEFAULT_MATRIX[role.code].items():
            # Không ghi đè ô Owner đã chỉnh.
            await db.execute(text("""INSERT INTO core.role_permissions (role_id, permission_code, scope)
                                     VALUES (:r, :p, :s) ON CONFLICT DO NOTHING"""),
                             {"r": role_id, "p": perm, "s": scope})
    # Khoá cứng: Owner luôn giữ toàn quyền; Auditor không bao giờ có quyền ghi.
    await db.execute(text("""
        UPDATE core.role_permissions rp SET scope = 'all' FROM core.roles r
        WHERE rp.role_id = r.id AND r.org_id = :o AND r.code = 'owner' AND rp.scope <> 'all'"""), {"o": org_id})
    await db.execute(text("""
        UPDATE core.role_permissions rp SET scope = 'none' FROM core.roles r
        WHERE rp.role_id = r.id AND r.org_id = :o AND r.code = 'auditor' AND rp.scope <> 'none'
          AND rp.permission_code = ANY(:w)"""), {"o": org_id, "w": list(rbac.WRITE_PERMISSIONS)})


async def _boundaries(db: AsyncSession, org_id: uuid.UUID) -> None:
    for b in BOUNDARIES:
        await db.execute(text("""
            INSERT INTO ops.policy_boundaries (org_id, code, is_enabled, is_locked, params)
            VALUES (:o, :c, :e, :l, CAST(:p AS jsonb)) ON CONFLICT (org_id, code) DO NOTHING"""),
            {"o": org_id, "c": b.code, "e": b.enabled, "l": b.locked, "p": json.dumps(b.params or {})})
        if b.locked:
            await db.execute(text("""UPDATE ops.policy_boundaries SET is_enabled = :e, is_locked = true
                                     WHERE org_id = :o AND code = :c"""), {"o": org_id, "c": b.code, "e": b.enabled})


async def _chassis_plugins(db: AsyncSession, manifests: list[Manifest]) -> None:
    for m in manifests:
        if m.layer != "chassis":
            continue
        await db.execute(text("""
            INSERT INTO ops.plugins (package, name, layer, origin, version, is_enabled, load_order, sandbox,
                                     permissions, signature_ok, manifest)
            VALUES (:pkg, :name, :layer, 'core', :ver, true, :lo, CAST(:sb AS jsonb), :perms, true,
                    CAST(:mf AS jsonb))
            ON CONFLICT (package) DO UPDATE SET name = EXCLUDED.name, version = EXCLUDED.version,
                origin = 'core', is_enabled = true, load_order = EXCLUDED.load_order, sandbox = EXCLUDED.sandbox,
                manifest = EXCLUDED.manifest"""),
            {"pkg": m.package, "name": m.name, "layer": m.layer, "ver": m.version, "lo": m.load_order,
             "sb": m.sandbox.model_dump_json(), "perms": m.permissions, "mf": m.model_dump_json()})
        pid = (await db.execute(text("SELECT id FROM ops.plugins WHERE package = :p"), {"p": m.package})).scalar_one()
        await db.execute(text("DELETE FROM ops.plugin_dependencies WHERE plugin_id = :i"), {"i": pid})
        for dep, spec in m.dependencies.items():
            await db.execute(text("""INSERT INTO ops.plugin_dependencies (plugin_id, depends_on, version_range)
                                     VALUES (:i, :d, :s)"""), {"i": pid, "d": dep, "s": spec})


async def _setup_state(db: AsyncSession, org_id: uuid.UUID) -> tuple[str | None, bool]:
    row = (await db.execute(text("SELECT finished_at, completed FROM ops.setup_state WHERE org_id = :o"),
                            {"o": org_id})).one_or_none()
    if row is None:
        await db.execute(text("INSERT INTO ops.setup_state (org_id, step, completed) VALUES (:o, 1, '{}')"),
                         {"o": org_id})
        finished, owner_created = False, False
    else:
        finished = row.finished_at is not None
        owner_created = (row.completed or {}).get("steps", {}).get("2") == "done"
    if finished or owner_created:
        # Mã thiết lập chỉ dùng tới khi có tài khoản Owner; sau đó vô hiệu.
        await db.execute(text("UPDATE ops.setup_state SET setup_token_hash = NULL WHERE org_id = :o"), {"o": org_id})
        return None, finished
    configured = get_settings().setup_token
    token = configured or new_token(9)
    await db.execute(text("UPDATE ops.setup_state SET setup_token_hash = :h WHERE org_id = :o"),
                     {"h": token_digest(token), "o": org_id})
    if not configured:
        log.warning("Mã thiết lập Owner (dùng một lần): %s — mở %s/setup?token=%s",
                    token, get_settings().public_url, token)
        return token, False
    return None, False
