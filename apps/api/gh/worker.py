"""Tiến trình nền (arq): chạy plugin tiêu thụ sự kiện + việc định kỳ.

- Giai đoạn 1: kiểm chuỗi Action Log hằng đêm, bảo trì phân vùng pg_partman.
- Giai đoạn 2: bộ kích hoạt sàng lọc (chu kỳ / ngưỡng / đường nhanh / chạy ngay), dò trùng định danh
  mỗi 10 phút, nén sổ tay hằng ngày.
"""

import logging
from typing import Any

from arq import cron
from arq.connections import RedisSettings
from redis.asyncio import Redis
from sqlalchemy import text

from gh.app import build_plugin_manager, configure_logging
from gh.bootstrap import bootstrap
from gh.chassis import actionlog
from gh.chassis.bus import EventBus
from gh.config import get_settings
from gh.db import dispose_engine, sessionmaker
from gh.identity import service as identity
from gh.memory import notebook
from gh.providers import cli as climod
from gh.providers.router import ModelRouter
from gh.refinery.runner import Refinery
from gh.refinery.scheduler import Scheduler

log = logging.getLogger("gh.worker")


async def startup(ctx: dict[str, Any]) -> None:
    configure_logging()
    async with sessionmaker()() as db:
        await bootstrap(db)
        await db.commit()
    s = get_settings()
    ctx["redis_bus"] = Redis.from_url(s.redis_url)
    ctx["plugins"] = await build_plugin_manager(EventBus(ctx["redis_bus"], s.stream_maxlen))
    ctx["plugins"].start_control_listener()
    sm = sessionmaker()
    bus = EventBus(ctx["redis_bus"], s.stream_maxlen)
    try:
        await climod.restore_active(sm)
    except Exception as exc:  # noqa: BLE001 — thiếu phiên CLI không chặn worker
        log.warning("Không khôi phục được phiên CLI: %s", exc)
    ctx["scheduler"] = Scheduler(sm, ctx["redis_bus"], Refinery(sm, ctx["redis_bus"], ModelRouter(sm, ctx["redis_bus"]),
                                                               bus))
    await ctx["scheduler"].start()
    log.info("Worker sẵn sàng")


async def shutdown(ctx: dict[str, Any]) -> None:
    await ctx["scheduler"].stop()
    await ctx["plugins"].shutdown()
    await ctx["redis_bus"].aclose()
    await dispose_engine()


async def verify_action_log(ctx: dict[str, Any]) -> dict[str, Any]:
    """Đứt chuỗi → cảnh báo P1 vào hàng đợi của Owner (không tự sửa gì)."""
    out: dict[str, Any] = {}
    async with sessionmaker()() as db:
        orgs = (await db.execute(text("SELECT id FROM core.organizations"))).scalars().all()
        for org in orgs:
            report = await actionlog.verify_chain(db, org)
            out[str(org)] = {"ok": report.ok, "checked": report.checked, "broken_at": report.broken_at}
            await actionlog.record(db, org_id=org, actor_type="system", actor_id="system:worker",
                                   action="audit.chain_verified", result="ok" if report.ok else "failed",
                                   detail={"checked": report.checked, "broken_at": report.broken_at})
            if not report.ok:
                code = (await db.execute(text("SELECT core.next_code('ALR')"))).scalar_one()
                await db.execute(text("""
                    INSERT INTO biz.alerts (org_id, code, alert_type, priority, recipient_user_id, subject_type,
                                            title, summary, evidence)
                    SELECT :o, :c, 'data_conflict', 'P1', u.id, 'action_log',
                           'Nhật ký hành động bị sửa ngoài hệ thống',
                           'Chuỗi băm đứt tại dòng ' || :b || '. Cần kiểm tra quyền truy cập CSDL.',
                           jsonb_build_array(jsonb_build_object('type', 'action_log', 'id', :b))
                    FROM core.users u JOIN core.user_roles ur ON ur.user_id = u.id
                    JOIN core.roles r ON r.id = ur.role_id AND r.code = 'owner'
                    WHERE u.org_id = :o LIMIT 1"""), {"o": org, "c": code, "b": report.broken_at})
        await db.commit()
    return out


async def partition_maintenance(ctx: dict[str, Any]) -> None:
    async with sessionmaker()() as db:
        await db.execute(text("SELECT partman.run_maintenance()"))
        await db.commit()


async def detect_identities(ctx: dict[str, Any]) -> dict[str, int]:
    """Dò cặp định danh có thể trùng (SĐT, tên gần giống, chung nhóm) → hàng chờ duyệt, không tự gộp."""
    out: dict[str, int] = {}
    async with sessionmaker()() as db:
        for org in (await db.execute(text("SELECT id FROM core.organizations"))).scalars().all():
            out[str(org)] = await identity.detect(db, org)
        await db.commit()
    return out


async def compact_notebooks(ctx: dict[str, Any]) -> int:
    """Nén hằng ngày các sổ tay có mục mới từ lần nén trước (mục ghim và luật cấm không bao giờ bị nén)."""
    n = 0
    async with sessionmaker()() as db:
        for org in (await db.execute(text("SELECT id FROM core.organizations"))).scalars().all():
            for nb in await notebook.due_for_daily(db, org):
                if await notebook.compact(db, nb, reason="daily"):
                    n += 1
        await db.commit()
    return n


class WorkerSettings:
    redis_settings = RedisSettings.from_dsn(get_settings().redis_url)
    on_startup = startup
    on_shutdown = shutdown
    functions = [verify_action_log, partition_maintenance, detect_identities, compact_notebooks]
    health_check_interval = 30
    cron_jobs = [
        cron(verify_action_log, hour={2}, minute={30}),        # 02:30 hằng đêm
        cron(partition_maintenance, minute={5}),                # mỗi giờ
        cron(detect_identities, minute=set(range(0, 60, 10))),  # mỗi 10 phút
        cron(compact_notebooks, hour={3}, minute={15}),         # 03:15 hằng ngày
    ]


def run() -> None:
    from arq import run_worker

    run_worker(WorkerSettings)  # type: ignore[arg-type]
