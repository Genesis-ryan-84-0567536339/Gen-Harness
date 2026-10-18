"""Tin 1-1 của Sếp tới bot (kênh quản trị). Lõi lệnh dùng chung với Telegram (`gh.owner_cmd`: chỉ đọc + ĐỀ
XUẤT), thêm lệnh
nhóm (`group_cmds`: đổi cấu hình). Lời đáp đi qua cửa `send_auto(owner_dm)` — mọi kiểm tra Owner làm LẠI ở đó."""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from gh.chassis.bus import EventBus
from gh.owner_channel import group_cmds
from gh.owner_channel.autosend import send_auto
from gh.owner_channel.basis import Basis, Trigger
from gh.owner_channel.identity import owner_ids
from gh.owner_cmd import core as owner_core
from gh.owner_cmd import parse as owner_parse

log = logging.getLogger("gh.owner_channel.dm")

REPLY_MAX = 3800
RATE_TEXT = "Sếp nhắn nhanh quá, em chờ một chút rồi mới trả lời tiếp được ạ."
GROUP_HELP = (
    "\nLệnh nhóm (chỉ ở kênh này):\n"
    "/nhom — các nhóm em đang ở\n"
    "/nghe <mã> · /bo <mã> — trả lời câu hỏi nhóm mới\n"
    "/ho_tro — xem nhóm đang bật hỗ trợ · /ho_tro <mã nhóm> bat|tat\n"
    "/xac_nhan <mã> — xác nhận bật hỗ trợ"
)


async def build_reply(sm: async_sessionmaker[AsyncSession], redis: Redis, router: Any, org_id: uuid.UUID, oi: Any,
                      p: dict[str, Any]) -> str:
    kind, args = owner_parse.parse_text(str(p.get("text") or ""))
    if kind in group_cmds.KINDS:
        async with sm() as db:
            out = await group_cmds.handle(db, redis, org_id, oi, kind, args)
            await db.commit()
        return out
    cmd = owner_core.OwnerCommand(via=oi.channel, kind=kind, text=args, message_ref=str(p.get("external_msg_id") or ""),
                                  received_at=datetime.now(UTC))
    ctx = owner_core.Context(sm=sm, redis=redis, router=router, org_id=org_id, owner_user_id=oi.owner_user_id)
    reply = await owner_core.handle(cmd, ctx)
    text_ = reply.plain()
    if kind in ("start", "tro_giup", "help"):
        text_ += GROUP_HELP
    return text_


async def handle_dm(sm: async_sessionmaker[AsyncSession], redis: Redis, bus: EventBus, router: Any,
                    org_id: uuid.UUID, p: dict[str, Any]) -> str:
    """Consumer `dm`. Trả nhãn kết quả ('replied' | 'rate' | 'ignored:<lý do>' | 'refused:<mã>'). Không ném."""
    ch, msg_id = str(p.get("channel") or ""), str(p.get("external_msg_id") or "")
    try:
        async with sm() as db:
            oi = await owner_ids(db, org_id, ch)
            await db.rollback()
        if not oi.enabled or str(oi.session_id) != str(p.get("session_id")):
            return "ignored:not_enabled"
        trigger = Trigger("owner_message", f"{ch}:{msg_id}")
        if not await owner_core.rate_ok(redis, org_id, ch):
            if await redis.set(f"gh:owner:ratemsg:{org_id}:{ch}", 1, nx=True, ex=60):
                async with sm() as db:
                    await send_auto(db, bus, redis, org_id=org_id, channel=ch, basis=Basis.OWNER_DM, trigger=trigger,
                                    text=RATE_TEXT)
            return "rate"
        body = (await build_reply(sm, redis, router, org_id, oi, p))[:REPLY_MAX]
        async with sm() as db:
            r = await send_auto(db, bus, redis, org_id=org_id, channel=ch, basis=Basis.OWNER_DM, trigger=trigger,
                                text=body)
        return "replied" if r.ok else f"refused:{r.code}"
    except Exception:  # noqa: BLE001 — một tin hỏng không được chặn các tin sau
        log.exception("kênh quản trị: xử lý tin 1-1 lỗi")
        return "error"

