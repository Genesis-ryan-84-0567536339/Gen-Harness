# ruff: noqa: E501
"""v0.1.73 — Xác nhận trong chat: sổ các đề xuất Gen soạn từ KÊNH QUẢN TRỊ (Zalo / WhatsApp) đang chờ Sếp trả lời «OK».

Đề xuất vẫn nằm trong Redis như cũ (`proposals.save`, hạn `PROPOSAL_TTL_S`). Sổ này chỉ là chỉ mục theo (tổ chức, kênh) để biết
«đề xuất nào Sếp vừa được hỏi trong chat» — đề xuất soạn ở Console / Telegram KHÔNG vào sổ nên «OK» trong chat không bao giờ
xác nhận được chúng. Mục giữ thêm 48 giờ sau khi đề xuất hết hạn để báo đúng «đã hết hạn» thay vì «không có gì».
Module chỉ ghi Redis và dựng chữ — không có đường thực thi nào ở đây (thực thi: `gh.owner_channel.chat_confirm`).
"""

import time
from typing import Any

from redis.asyncio import Redis

from gh.gen import proposals
from gh.owner_cmd import text as otext

#: Kênh quản trị hỗ trợ Xác nhận trong chat. Telegram giữ nguyên (Console + PIN) — ghi Nợ ở docs/ROADMAP.md.
CHAT_VIAS: tuple[str, ...] = ("zalo", "whatsapp")
KEEP_S = 48 * 3600
MAX_ENTRIES = 30
#: Tin gửi người ngoài dài hơn mức này không đọc trọn trong chat được ⇒ để Console (phải thấy NGUYÊN VĂN mới được OK).
OUTBOUND_TEXT_MAX = 1500
SUFFIX_NEEDS_PIN = " Chỉ ghi khi Sếp bấm Xác nhận và nhập mã PIN (qua Gen-hub)."


def key(org_id: Any, via: str) -> str:
    return f"gh:owner:chatprop:{org_id}:{via}"


def code_of(pid: str) -> str:
    """'#A3F9C2' — cùng mã ngắn Console hiện (`owner_cmd.core.short_id`)."""
    return "#" + str(pid).replace("-", "")[:6].upper()


async def register(redis: Redis, org_id: Any, via: str, pid: str) -> None:
    now = time.time()
    await redis.zadd(key(org_id, via), {str(pid): now})
    await redis.zremrangebyscore(key(org_id, via), "-inf", now - KEEP_S)
    await redis.zremrangebyrank(key(org_id, via), 0, -(MAX_ENTRIES + 1))
    await redis.expire(key(org_id, via), KEEP_S + 3600)


async def forget(redis: Redis, org_id: Any, via: str, pid: str) -> None:
    await redis.zrem(key(org_id, via), str(pid))


async def entries(redis: Redis, org_id: Any, via: str) -> list[str]:
    """Mã đề xuất đã hỏi trong chat, mới nhất trước."""
    got = await redis.zrevrange(key(org_id, via), 0, MAX_ENTRIES - 1)
    return [x.decode() if isinstance(x, bytes) else str(x) for x in got]


def kind_of(p: dict[str, Any]) -> str:
    """'internal' (OK là làm) | 'outbound' (gửi tin cho người ngoài: OK riêng + mã + nguyên văn) | 'console' (chỉ Console)."""
    t = p.get("type")
    if t in proposals.SOCIAL_TYPES:
        return "console"      # đăng lên mạng xã hội: giữ Xác nhận + PIN ở Console
    if t == "draft_message":
        subj = (p.get("fields") or {}).get("subject") or {}
        if subj.get("type") == "group":
            return "console" if len(str((p.get("fields") or {}).get("text") or "")) > OUTBOUND_TEXT_MAX else "outbound"
    return "internal"


def question(p: dict[str, Any]) -> str:
    """Câu hỏi gửi Sếp cho MỘT đề xuất (đã kiểm). Tóm tắt do hệ thống viết; tin gửi ra ngoài nêu người nhận + NGUYÊN VĂN (không
    defang: Sếp phải thấy đúng từng ký tự sẽ được gửi)."""
    code = code_of(p["id"])
    kind = kind_of(p)
    if kind == "outbound":
        f = p["fields"]
        who = (p.get("labels") or {}).get("subject") or "nhóm đã chọn"
        return (f"Đề xuất {code} — GỬI TIN cho nhóm «{otext.defang(otext.line(str(who)))}», nguyên văn:\n"
                f"“{f['text']}”\n"
                f"Trả lời «OK {code}» để em gửi đúng nội dung này, hoặc HUỶ {code}.")
    if kind == "console":
        return (f"Đề xuất {code}: {otext.defang(str(p['summary']).replace(SUFFIX_NEEDS_PIN, ''))}\n"
                "Việc này em chưa làm được từ chat — Sếp mở Console để Xác nhận (và nhập mã PIN).")
    body = f"Đề xuất {code}: {otext.defang(str(p['summary']).replace(SUFFIX_NEEDS_PIN, ''))}"
    if p.get("type") == "draft_message":      # nháp chỉ lưu ở Bàn làm việc, không gửi — vẫn cho Sếp thấy nội dung
        body += f"\nNội dung nháp: “{p['fields']['text']}”"
    return f"{body}\nTrả lời OK để em làm (mã {code}), hoặc HUỶ."
