"""`Decider` — bộ quyết định nhanh cho Gen (docs/design/gen-v1.md §5, quyết định §9.6).

- `JevDecider`: gọi Jev (nguồn model kind `system_one`) chọn ý định câu hỏi và mục tiêu UI kế tiếp từ danh sách hữu
  hạn. Có trần thời gian (~1,5 s); lỗi/chậm/độ tin cậy thấp → trả None = bên gọi đi đường LLM.
- `LlmDecider`: mặc định khi chưa cấu hình Jev — không gọi thêm model nào, để planner LLM (`core.gen`) tự quyết
  (tránh cộng thêm một lượt gọi model vào độ trễ mỗi câu).
- `classify` (v0.1.25, Đợt C1): lọc đầu Hộp thư (rác / chất lượng) — `gh.refinery.triage`; None → quy tắc tất định.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass
from typing import Any, Protocol

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh import crypto
from gh.gen import jev
from gh.gen.registry import Target

log = logging.getLogger("gh.gen.decider")

TIMEOUT_S = 1.5
MIN_CONFIDENCE = 0.5
INTENTS: dict[str, str] = {
    "data": "hỏi dữ liệu / tóm tắt tình hình",
    "guide": "hỏi cách làm / cần dẫn đường trên giao diện",
    "report": "xin báo cáo có số liệu",
    "out_of_scope": "ngoài phạm vi quản trị app (code, máy chủ, nói chuyện với khách)",
}


@dataclass
class Decision:
    value: str
    confidence: float | None
    latency_ms: int
    source: str


class Decider(Protocol):
    name: str

    async def intent(self, question: str) -> Decision | None: ...

    async def next_target(self, question: str, candidates: list[Target]) -> Decision | None: ...

    async def classify(self, question: str, options: dict[str, str], context: str) -> Decision | None: ...


class LlmDecider:
    name = "llm"

    async def intent(self, question: str) -> Decision | None:
        return None

    async def next_target(self, question: str, candidates: list[Target]) -> Decision | None:
        return None

    async def classify(self, question: str, options: dict[str, str], context: str) -> Decision | None:
        return None


class JevDecider:
    name = "jev"

    def __init__(self, client: jev.JevClient, timeout: float = TIMEOUT_S):
        self.client = client
        self.timeout = timeout
        self.last_error: str | None = None

    async def _choose(self, question: str, options: dict[str, str], context: str) -> Decision | None:
        labels = list(options.values())
        started = time.monotonic()
        try:
            c = await asyncio.wait_for(self.client.choose(question, labels, context), timeout=self.timeout)
        except (TimeoutError, jev.JevError) as e:
            self.last_error = str(e) or "timeout"
            log.info("Jev không quyết định được (%s) — dùng LLM", self.last_error)
            return None
        if c.confidence is not None and c.confidence < MIN_CONFIDENCE:
            self.last_error = f"độ tin cậy thấp {c.confidence:.2f}"
            return None
        key = next(k for k, v in options.items() if v == c.label)
        return Decision(key, c.confidence, int((time.monotonic() - started) * 1000), self.name)

    async def intent(self, question: str) -> Decision | None:
        return await self._choose(question, INTENTS, "Phân loại câu hỏi của chủ doanh nghiệp trong Console.")

    async def next_target(self, question: str, candidates: list[Target]) -> Decision | None:
        static = [t for t in candidates if t.dynamic is None][:40]
        if not static:
            return None
        return await self._choose(question, {t.id: f"{t.label} — {t.description}" for t in static},
                                  "Chọn phần tử giao diện cần làm sáng để dẫn người dùng.")

    async def classify(self, question: str, options: dict[str, str], context: str) -> Decision | None:
        """Phân loại tự do (Đợt C1 — lọc đầu Hộp thư): khoá → nhãn; None = bên gọi tự rơi về quy tắc/LLM."""
        return await self._choose(question, options, context)


async def load_decider(db: AsyncSession, org_id: uuid.UUID, *,
                       transport: httpx.AsyncBaseTransport | None = None) -> Decider:
    """Nguồn Jev đầu tiên đang bật và có khoá → JevDecider; không có → LlmDecider (chỉ LLM)."""
    from gh.providers.router import KEY_AAD

    row: Any = (await db.execute(text("""
        SELECT p.endpoint, k.secret_enc,
               (SELECT m.model_name FROM agent.models m WHERE m.provider_id = p.id AND m.is_enabled
                ORDER BY m.id LIMIT 1) AS model_name
        FROM agent.providers p JOIN agent.provider_keys k ON k.provider_id = p.id AND k.is_enabled
        WHERE p.org_id = :o AND p.kind = 'system_one' AND p.is_enabled
        ORDER BY p.failover_rank NULLS LAST, k.rotation_order LIMIT 1"""), {"o": org_id})).one_or_none()
    if row is None:
        return LlmDecider()
    try:
        secret = crypto.decrypt(bytes(row.secret_enc), KEY_AAD).decode()
    except Exception:  # noqa: BLE001 — khoá master đổi: coi như chưa có Jev
        log.error("Không giải mã được khoá Jev")
        return LlmDecider()
    return JevDecider(jev.JevClient(row.endpoint, secret, row.model_name, transport=transport))
