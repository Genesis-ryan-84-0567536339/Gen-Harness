"""Định tuyến lượt gọi model: gán theo vai trò, xoay vòng khoá, hạn mức, ngắt mạch, chuỗi chuyển hướng.

Theo `failoverRules` của thiết kế (ARCHITECTURE §11):
- 429 → khoá đó nghỉ (cooldown), sang khoá kế; hết khoá → nhà cung cấp kế.
- hết hạn mức ngày của model → nhà cung cấp kế tiếp trong chuỗi.
- lỗi tạm thời liên tiếp → ngắt mạch nhà cung cấp 60 giây (giữ nguyên việc, lượt sau thử lại).
- hết chuỗi → ném ModelUnavailable (việc nằm chờ) và báo Sếp qua hàng đợi (tối đa 1 lần / giờ).
- còn < 20% hạn mức ở bất kỳ model nào → cảnh báo (1 lần / ngày / model).
Mọi lượt gọi (thành công hay không) ghi `agent.model_calls`.
"""

import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import httpx
from redis.asyncio import Redis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from gh import crypto
from gh.config import get_settings
from gh.providers.clients import (
    AgyClient,
    AuthFailed,
    BadRequest,
    Completion,
    GeminiClient,
    Message,
    OpenAICompatClient,
    ProviderError,
    QuotaExhausted,
    RateLimited,
)

log = logging.getLogger("gh.providers")

KEY_COOLDOWN_S = 60
AUTH_COOLDOWN_S = 3600
BREAKER_OPEN_S = 60
BREAKER_FAILS = 3
LOW_QUOTA = 0.20
KEY_AAD = b"provider_key"
CLI_AAD = b"cli_token"


class ModelUnavailable(Exception):  # noqa: N818
    def __init__(self, reasons: list[str]):
        super().__init__("; ".join(reasons) or "Chưa cấu hình model")
        self.reasons = reasons


@dataclass
class Routed:
    text: str
    provider: str
    model: str
    tokens_in: int | None
    tokens_out: int | None
    attempts: list[str] = field(default_factory=list)


def _today() -> str:
    return datetime.now(UTC).strftime("%Y%m%d")


def quota_key(model_id: Any) -> str:
    return f"gh:quota:{model_id}:{_today()}"


def cooldown_key(key_id: Any) -> str:
    return f"gh:cooldown:key:{key_id}"


def breaker_key(provider_id: Any) -> str:
    return f"gh:breaker:provider:{provider_id}"


async def owner_user_id(db: AsyncSession, org_id: uuid.UUID) -> uuid.UUID | None:
    return (await db.execute(text("""
        SELECT u.id FROM core.users u JOIN core.user_roles ur ON ur.user_id = u.id
        JOIN core.roles r ON r.id = ur.role_id AND r.code = 'owner'
        WHERE u.org_id = :o AND u.is_active ORDER BY u.created_at LIMIT 1"""), {"o": org_id})).scalar_one_or_none()


async def raise_alert(db: AsyncSession, org_id: uuid.UUID, *, alert_type: str, priority: str, title: str,
                      summary: str, suggested: str | None = None, subject_type: str | None = None,
                      subject_id: Any = None, evidence: list[dict[str, Any]] | None = None,
                      personnel_related: bool = False) -> None:
    import orjson

    code = (await db.execute(text("SELECT core.next_code('ALR')"))).scalar_one()
    await db.execute(text("""
        INSERT INTO biz.alerts (org_id, code, alert_type, priority, recipient_user_id, subject_type, subject_id,
                                title, summary, suggested_action, evidence, personnel_related)
        VALUES (:o, :c, :t, :p, :u, :st, :si, :ti, :su, :sa, CAST(:ev AS jsonb), :pr)"""),
        {"o": org_id, "c": code, "t": alert_type, "p": priority, "u": await owner_user_id(db, org_id),
         "st": subject_type, "si": subject_id, "ti": title, "su": summary, "sa": suggested,
         "ev": orjson.dumps(evidence or []).decode(), "pr": personnel_related})


class ModelRouter:
    def __init__(self, sm: async_sessionmaker[AsyncSession], redis: Redis, *,
                 transport: httpx.AsyncBaseTransport | None = None, cli_factory: Any = None):
        self.sm, self.redis, self.transport = sm, redis, transport
        s = get_settings()
        self.cli_factory = cli_factory or (lambda: AgyClient(s.cli_binary, s.cli_home))

    # ─── chuỗi ───────────────────────────────────────────────────────────────

    async def _chain(self, db: AsyncSession, org_id: uuid.UUID, agent_key: str) -> list[dict[str, Any]]:
        bound = (await db.execute(text("""SELECT m.id, m.provider_id FROM agent.bindings b
                                          JOIN agent.models m ON m.id = b.model_id
                                          WHERE b.org_id = :o AND b.agent_key = :k"""),
                                  {"o": org_id, "k": agent_key})).one_or_none()
        providers = (await db.execute(text("""
            SELECT id, kind, name, endpoint, auth_state FROM agent.providers
            WHERE org_id = :o AND is_enabled AND kind <> 'embedding'
            ORDER BY (id = :bp) DESC, failover_rank NULLS LAST, created_at"""),
            {"o": org_id, "bp": bound.provider_id if bound else None})).all()
        chain = []
        for p in providers:
            models = (await db.execute(text("""
                SELECT id, model_name, daily_quota, rate_limit_per_min FROM agent.models
                WHERE provider_id = :p AND is_enabled AND model_name NOT ILIKE '%embedding%'
                ORDER BY (id = :bm) DESC, id"""), {"p": p.id, "bm": bound.id if bound else None})).all()
            if not models:
                continue
            keys = (await db.execute(text("""
                SELECT id, label, secret_enc FROM agent.provider_keys
                WHERE provider_id = :p AND is_enabled ORDER BY rotation_order, created_at"""),
                                     {"p": p.id})).all()
            chain.append({"provider": p, "model": models[0], "keys": keys})
        return chain

    def _client(self, p: Any, secret: str | None) -> Any:
        if p.kind == "antigravity_cli":
            return self.cli_factory()
        if p.kind == "gemini":
            return GeminiClient(p.endpoint, secret or "", transport=self.transport)
        return OpenAICompatClient(p.endpoint or ("https://api.deepseek.com/v1" if p.kind == "deepseek" else None),
                                  secret or "", transport=self.transport)

    async def _record(self, org_id: uuid.UUID, model_id: Any, key_id: Any, agent_key: str, purpose: str,
                      status: str, started: float, c: Completion | None) -> None:
        async with self.sm() as db:
            await db.execute(text("""
                INSERT INTO agent.model_calls (org_id, model_id, key_id, agent_key, purpose, tokens_in, tokens_out,
                                               latency_ms, status)
                VALUES (:o, :m, :k, :a, :p, :ti, :to, :l, :s)"""),
                {"o": org_id, "m": model_id, "k": key_id, "a": agent_key, "p": purpose,
                 "ti": c.tokens_in if c else None, "to": c.tokens_out if c else None,
                 "l": int((time.monotonic() - started) * 1000), "s": status})
            await db.commit()

    async def _quota_ok(self, org_id: uuid.UUID, m: Any) -> bool:
        if m.daily_quota is None:
            return True
        used = int(await self.redis.get(quota_key(m.id)) or 0)
        return used < int(m.daily_quota)

    async def _count_use(self, org_id: uuid.UUID, p: Any, m: Any) -> None:
        k = quota_key(m.id)
        used = await self.redis.incr(k)
        if used == 1:
            await self.redis.expire(k, 2 * 86400)
        if m.daily_quota and used >= (1 - LOW_QUOTA) * int(m.daily_quota):
            if await self.redis.set(f"gh:alert:quota_low:{m.id}:{_today()}", "1", nx=True, ex=86400):
                left = max(0, int(m.daily_quota) - used)
                async with self.sm() as db:
                    await raise_alert(db, org_id, alert_type="model_quota_low", priority="P2",
                                      title=f"{m.model_name} còn dưới 20% hạn mức ngày",
                                      summary=f"{p.name} · còn {left} / {m.daily_quota} lượt hôm nay",
                                      suggested="Thêm khoá hoặc đổi thứ tự chuỗi chuyển hướng",
                                      subject_type="model", subject_id=m.id)
                    await db.commit()

    async def _fail(self, p: Any) -> None:
        k = f"gh:pfail:{p.id}"
        n = await self.redis.incr(k)
        await self.redis.expire(k, 300)
        if n >= BREAKER_FAILS:
            await self.redis.set(breaker_key(p.id), "open", ex=BREAKER_OPEN_S)
            await self.redis.delete(k)

    async def _set_auth_state(self, p: Any, state: str) -> None:
        async with self.sm() as db:
            await db.execute(text("UPDATE agent.providers SET auth_state = :s WHERE id = :i AND auth_state <> :s"),
                             {"s": state, "i": p.id})
            await db.commit()

    # ─── gọi ─────────────────────────────────────────────────────────────────

    async def generate(self, org_id: uuid.UUID, *, agent_key: str, purpose: str, messages: list[Message],
                       json_mode: bool = True, temperature: float = 0.2) -> Routed:
        async with self.sm() as db:
            chain = await self._chain(db, org_id, agent_key)
        reasons: list[str] = []
        for link in chain:
            p, m = link["provider"], link["model"]
            if await self.redis.exists(breaker_key(p.id)):
                reasons.append(f"{p.name}: đang ngắt mạch")
                continue
            if not await self._quota_ok(org_id, m):
                reasons.append(f"{p.name}: {m.model_name} hết hạn mức ngày")
                continue
            if m.rate_limit_per_min:
                rk = f"gh:rate:{m.id}:{int(time.time() // 60)}"
                n = await self.redis.incr(rk)
                await self.redis.expire(rk, 120)
                if n > int(m.rate_limit_per_min):
                    reasons.append(f"{p.name}: vượt {m.rate_limit_per_min} lượt/phút")
                    continue
            slots: list[tuple[Any, str | None]] = [(None, None)] if p.kind == "antigravity_cli" else []
            for k in link["keys"]:
                if await self.redis.exists(cooldown_key(k.id)):
                    continue
                try:
                    slots.append((k, crypto.decrypt(bytes(k.secret_enc), KEY_AAD).decode()))
                except Exception:  # noqa: BLE001 — khoá master đổi / dữ liệu hỏng: bỏ khoá này
                    log.error("Không giải mã được khoá %s", k.label)
            if not slots:
                reasons.append(f"{p.name}: không còn khoá khả dụng")
                continue
            for key, secret in slots:
                started = time.monotonic()
                kid = key.id if key else None
                try:
                    c = await self._client(p, secret).generate(m.model_name, messages, json_mode=json_mode,
                                                               temperature=temperature)
                except RateLimited as e:
                    await self._record(org_id, m.id, kid, agent_key, purpose, "rate_limited", started, None)
                    if key is not None:
                        await self.redis.set(cooldown_key(key.id), "429", ex=int(e.retry_after or KEY_COOLDOWN_S))
                    reasons.append(f"{p.name}{' ' + key.label if key else ''}: 429")
                    continue
                except QuotaExhausted:
                    await self._record(org_id, m.id, kid, agent_key, purpose, "quota", started, None)
                    await self.redis.set(quota_key(m.id), str(m.daily_quota or 10**9), ex=86400)
                    reasons.append(f"{p.name}: nhà cung cấp báo hết hạn mức")
                    break
                except AuthFailed as e:
                    await self._record(org_id, m.id, kid, agent_key, purpose, "auth", started, None)
                    if key is not None:
                        await self.redis.set(cooldown_key(key.id), "auth", ex=AUTH_COOLDOWN_S)
                    else:
                        await self._set_auth_state(p, "expired")
                    reasons.append(f"{p.name}: xác thực lỗi ({str(e)[:80]})")
                    continue
                except BadRequest as e:
                    await self._record(org_id, m.id, kid, agent_key, purpose, "error", started, None)
                    reasons.append(f"{p.name}: {str(e)[:120]}")
                    break
                except (ProviderError, TimeoutError) as e:
                    await self._record(org_id, m.id, kid, agent_key, purpose, "error", started, None)
                    await self._fail(p)
                    reasons.append(f"{p.name}: {str(e)[:120]}")
                    break
                await self._record(org_id, m.id, kid, agent_key, purpose, "ok", started, c)
                await self.redis.delete(f"gh:pfail:{p.id}")
                await self._count_use(org_id, p, m)
                return Routed(c.text, p.name, m.model_name, c.tokens_in, c.tokens_out, reasons)
        await self._chain_exhausted(org_id, reasons)
        raise ModelUnavailable(reasons)

    async def _chain_exhausted(self, org_id: uuid.UUID, reasons: list[str]) -> None:
        if not await self.redis.set(f"gh:alert:chain:{org_id}", "1", nx=True, ex=3600):
            return
        async with self.sm() as db:
            await raise_alert(db, org_id, alert_type="model_chain_exhausted", priority="P1",
                              title="Hết chuỗi model — việc AI đang xếp hàng chờ",
                              summary="; ".join(reasons)[:500] or "Chưa cấu hình nhà cung cấp nào",
                              suggested="Kiểm tra khoá, hạn mức hoặc đăng nhập lại Antigravity CLI")
            await db.commit()

    async def embed(self, org_id: uuid.UUID, texts: list[str]) -> list[list[float]] | None:
        """Embedding 768 chiều; không có model embedding hoặc lỗi → None (không chặn sàng lọc)."""
        if not texts:
            return []
        async with self.sm() as db:
            rows = (await db.execute(text("""
                SELECT p.id, p.kind, p.name, p.endpoint, m.id AS model_id, m.model_name
                FROM agent.providers p JOIN agent.models m ON m.provider_id = p.id
                WHERE p.org_id = :o AND p.is_enabled AND m.is_enabled AND m.model_name ILIKE '%embedding%'
                  AND p.kind IN ('gemini', 'openai_compat', 'deepseek', 'embedding')
                ORDER BY p.failover_rank NULLS LAST"""), {"o": org_id})).all()
            for r in rows:
                keys = (await db.execute(text("""SELECT id, secret_enc FROM agent.provider_keys
                                                 WHERE provider_id = :p AND is_enabled ORDER BY rotation_order"""),
                                         {"p": r.id})).all()
                for k in keys:
                    if await self.redis.exists(cooldown_key(k.id)):
                        continue
                    started = time.monotonic()
                    try:
                        secret = crypto.decrypt(bytes(k.secret_enc), KEY_AAD).decode()
                        client = (GeminiClient(r.endpoint, secret, transport=self.transport)
                                  if r.kind in ("gemini", "embedding")
                                  else OpenAICompatClient(r.endpoint, secret, transport=self.transport))
                        vecs = await client.embed(r.model_name, texts)
                    except RateLimited:
                        await self.redis.set(cooldown_key(k.id), "429", ex=KEY_COOLDOWN_S)
                        continue
                    except Exception as e:  # noqa: BLE001
                        log.warning("embedding lỗi (%s): %s", r.name, e)
                        await self._record(org_id, r.model_id, k.id, "core.embedding", "embedding", "error",
                                           started, None)
                        break
                    await self._record(org_id, r.model_id, k.id, "core.embedding", "embedding", "ok", started, None)
                    if len(vecs) == len(texts) and all(len(v) == 768 for v in vecs):
                        return vecs
                    return None
        return None

    async def test_provider(self, provider_id: uuid.UUID) -> dict[str, Any]:
        async with self.sm() as db:
            p = (await db.execute(text("SELECT id, kind, name, endpoint FROM agent.providers WHERE id = :i"),
                                  {"i": provider_id})).one()
            key = (await db.execute(text("""SELECT secret_enc FROM agent.provider_keys WHERE provider_id = :p
                                            AND is_enabled ORDER BY rotation_order LIMIT 1"""),
                                    {"p": provider_id})).scalar_one_or_none()
        started = time.monotonic()
        result: dict[str, Any] = {"ok": False, "latency_ms": None, "models": [], "error": None}
        try:
            if p.kind != "antigravity_cli" and key is None:
                raise AuthFailed("Chưa có khoá API")
            secret = crypto.decrypt(bytes(key), KEY_AAD).decode() if key is not None else None
            result["models"] = (await self._client(p, secret).list_models())[:50]
            result["ok"] = True
        except Exception as e:  # noqa: BLE001 — trả lỗi cho Console, không ném
            result["error"] = str(e)[:300]
        result["latency_ms"] = int((time.monotonic() - started) * 1000)
        state = "ok" if result["ok"] else ("expired" if "xác thực" in (result["error"] or "") or
                                            "401" in (result["error"] or "") else "error")
        async with self.sm() as db:
            import orjson

            await db.execute(text("""UPDATE agent.providers SET auth_state = :s,
                                     last_test = CAST(:t AS jsonb) WHERE id = :i"""),
                             {"s": state, "i": provider_id,
                              "t": orjson.dumps({**result, "at": datetime.now(UTC).isoformat()}).decode()})
            await db.commit()
        return result
