"""Vòng lặp một lượt Gen: plan → tool → observe (docs/design/gen-v1.md §3.3).

Mỗi vòng model (`core.gen` qua ModelRouter) trả một envelope `{"steps": [...]}`. Bước `say`/`ui`/`suggest` được kiểm
(gh.gen.validator) rồi đẩy NGAY xuống web qua WS `gen.step` (chỉ người hỏi nhận — `to_user`) và lưu vào trạng thái
lượt trong Redis (`GET /gen/turns/{id}` — đường dự phòng khi WS rớt). Bước `tool` chạy tool đọc (gh.gen.tools) và
kết quả được đưa lại model ở vòng kế. Tối đa 6 vòng. Mọi bước ghi Action Log: actor_type="agent", actor_id="gen",
detail.on_behalf_of = người hỏi (không ghi nội dung câu hỏi/trả lời — chỉ digest).
"""

import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

import orjson
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from gh import realtime
from gh.auth import service
from gh.chassis import actionlog
from gh.gen import decider as decmod
from gh.gen import envelope, registry, store
from gh.gen.tools import ToolRunner, tools_for
from gh.gen.validator import Validator
from gh.providers.clients import Message
from gh.providers.router import ModelRouter, ModelUnavailable

log = logging.getLogger("gh.gen")

AGENT_KEY = "core.gen"
MAX_ROUNDS = 6
TURN_TTL_S = 3600
HISTORY_MESSAGES = 10

NOT_UNDERSTOOD = "Gen chưa hiểu, {addr} hỏi lại giúp em nhé."
NO_MODEL = ("Gen chưa có model để trả lời. {addr} gán model cho mục \"Gen — trợ lý quản trị\" ở màn API & Model "
            "(hoặc đăng nhập Antigravity CLI) rồi hỏi lại nhé.")
FAILED = "Gen gặp lỗi khi trả lời, {addr} thử lại sau giúp em."

ACTION_NAMES = {"navigate": "gen.navigate", "highlight": "gen.highlight", "tour": "gen.tour"}


def turn_key(turn_id: Any) -> str:
    return f"gh:gen:turn:{turn_id}"


def digest(value: Any) -> str:
    return hashlib.sha256(orjson.dumps(value, option=orjson.OPT_SORT_KEYS, default=str)).hexdigest()[:16]


@dataclass
class TurnInput:
    turn_id: uuid.UUID
    conversation_id: uuid.UUID
    text: str
    route: str
    screen_key: str | None
    visible_targets: list[str] = field(default_factory=list)


class Turn:
    """Một lượt đang chạy: phát bước, ghi trạng thái, ghi Action Log."""

    def __init__(self, sm: async_sessionmaker[AsyncSession], redis: Redis, user: service.CurrentUser,
                 inp: TurnInput):
        self.sm, self.redis, self.user, self.inp = sm, redis, user, inp
        self.steps: list[dict[str, Any]] = []
        self.model: str | None = None
        self.provider: str | None = None
        self.decider: str = "llm"

    @property
    def addr(self) -> str:
        return str((self.user.addressing or {}).get("bot_calls_me") or "Sếp")

    async def save_state(self, status: str) -> None:
        state = {"turn_id": str(self.inp.turn_id), "conversation_id": str(self.inp.conversation_id),
                 "user_id": str(self.user.id), "status": status, "steps": self.steps}
        await self.redis.set(turn_key(self.inp.turn_id), orjson.dumps(state), ex=TURN_TTL_S)

    async def emit(self, step: dict[str, Any]) -> None:
        ev = {"turn_id": str(self.inp.turn_id), "conversation_id": str(self.inp.conversation_id),
              "seq": len(self.steps), "step": step}
        self.steps.append(ev)
        await self.save_state("running")
        await realtime.publish(self.redis, "gen.step", ev, org_id=self.user.org_id, to_user=self.user.id)

    async def log(self, action: str, *, result: str = "ok", target_type: str | None = None,
                  target_id: str | None = None, target_label: str | None = None, **extra: Any) -> None:
        detail = {"on_behalf_of": str(self.user.id), "conversation_id": str(self.inp.conversation_id),
                  "turn_id": str(self.inp.turn_id), "model": self.model, "provider": self.provider,
                  "decider": self.decider, **extra}
        async with self.sm() as db:
            await actionlog.record(db, org_id=self.user.org_id, actor_type="agent", actor_id="gen", action=action,
                                   target_type=target_type, target_id=target_id, target_label=target_label,
                                   autonomy_level=1, result=result, detail=detail, ip=self.user.ip)
            await db.commit()

    async def finish(self, status: str) -> None:
        says = [s["step"] for s in self.steps]
        async with self.sm() as db:
            await store.add_message(db, self.user.org_id, self.inp.conversation_id, "assistant", {"steps": says},
                                    self.inp.turn_id)
            await db.commit()
        await self.save_state(status)
        await realtime.publish(self.redis, "gen.done",
                               {"turn_id": str(self.inp.turn_id), "conversation_id": str(self.inp.conversation_id),
                                "status": status}, org_id=self.user.org_id, to_user=self.user.id)


def _target_lines() -> str:
    lines = []
    for t in registry.load().targets.values():
        suffix = " (dòng: dùng '" + t.id + ":<id từ kết quả tool>')" if t.dynamic else ""
        params = f" [cần tab={t.params['tab']}]" if t.params and "tab" in t.params else ""
        lines.append(f"- {t.id} · màn {t.screen} · {t.label}{params}{suffix}")
    return "\n".join(lines)


def system_prompt(user: service.CurrentUser, inp: TurnInput, hints: list[str]) -> str:
    addr = str((user.addressing or {}).get("bot_calls_me") or "Sếp")
    tools = "\n".join(f"- {t.name}: {t.description}" for t in tools_for(user))
    screens = "\n".join(f"- {s['key']}: {s['title']}" for s in registry.visible_screens(user.permissions))
    hint = ("\nGợi ý nhanh từ bộ quyết định Jev (tham khảo, không bắt buộc):\n" + "\n".join(hints)) if hints else ""
    return f"""Bạn là Gen — trợ lý quản trị trong Gen-Harness Console. Người đang hỏi: {user.display_name} \
(vai trò {user.role_name}). Gọi người dùng là "{addr}", xưng "em". Trả lời tiếng Việt có dấu, NGẮN, đi thẳng vào việc.
Nguyên tắc: v1 chỉ ĐỌC và DẪN ĐƯỜNG — không bấm nút, không gửi tin, không sửa gì. Không bịa số liệu: cần số liệu thì
gọi tool. Không bịa màn, mục tiêu hay id: chỉ dùng khoá/id trong danh sách dưới hoặc id vừa có trong kết quả tool.
Ngoài phạm vi (code, máy chủ, nói chuyện với khách bên ngoài) → nói rõ là không làm.

Mỗi lần trả lời, in DUY NHẤT một JSON {{"steps": [...]}}; các bước:
{{"kind":"say","text":"..."}}
{{"kind":"tool","name":"<tool>","args":{{...}}}}  → kết quả gửi lại ở vòng sau; sau bước tool đừng viết tiếp.
{{"kind":"ui","action":{{"type":"navigate","screen":"<khoá màn>","params":{{"tab":"..."}}}}}}
{{"kind":"ui","action":{{"type":"highlight","target":"<id mục tiêu>","message":"..."}}}}  (mục tiêu phải thuộc màn
đang mở — navigate trước nếu cần)
{{"kind":"ui","action":{{"type":"tour","steps":[{{"screen":"<khoá màn>","target":"<id>","message":"..."}}]}}}}
{{"kind":"suggest","items":[{{"label":"...","action":<một action ui như trên>}}]}}  (tối đa 3, cuối câu trả lời)
{{"kind":"done"}}

Tool đọc dữ liệu được dùng:
{tools}

Màn {addr} được xem (khoá: tên):
{screens}

Mục tiêu làm sáng:
{_target_lines()}

Màn đang mở: {inp.screen_key or "không rõ"} ({inp.route}).{hint}"""


def _history_text(msgs: list[dict[str, Any]]) -> list[Message]:
    out: list[Message] = []
    for m in msgs[-HISTORY_MESSAGES:]:
        c = m["content"] or {}
        if m["role"] == "user":
            out.append(Message("user", str(c.get("text", ""))[:1000]))
        else:
            said = " ".join(s.get("text", "") for s in c.get("steps", []) if s.get("kind") == "say")
            if said:
                out.append(Message("assistant", said[:1500]))
    return out


async def _hints(turn: Turn, dec: decmod.Decider, text: str, inp: TurnInput) -> list[str]:
    turn.decider = dec.name
    if dec.name == "llm":
        return []
    hints: list[str] = []
    intent = await dec.intent(text)
    await turn.log("gen.decide", result="ok" if intent else "failed", target_type="decider",
                   target_id="intent", value=intent.value if intent else None,
                   latency_ms=intent.latency_ms if intent else None,
                   error=getattr(dec, "last_error", None) if intent is None else None)
    if intent is None:
        turn.decider = "llm"  # rơi về LLM
        return []
    hints.append(f"- ý định: {intent.value} ({decmod.INTENTS[intent.value]})")
    if intent.value == "guide":
        candidates = [t for t in registry.load().targets.values()
                      if registry.can_see(turn.user.permissions, t.screen)]
        choice = await dec.next_target(text, candidates)
        if choice is not None:
            t = registry.resolve_target(choice.value)
            if t is not None:
                hints.append(f"- mục tiêu nên làm sáng: {t.id} (màn {t.screen}"
                             f"{', tab=' + t.params['tab'] if t.params and 'tab' in t.params else ''})")
    return hints


async def run_turn(*, app: Any, sm: async_sessionmaker[AsyncSession], redis: Redis, router: ModelRouter,
                   user: service.CurrentUser, session_token: str, inp: TurnInput,
                   decider: decmod.Decider | None = None) -> None:
    turn = Turn(sm, redis, user, inp)
    await turn.save_state("running")
    try:
        await _run(turn, app=app, router=router, session_token=session_token, decider=decider)
        await turn.finish("done")
    except Exception:  # noqa: BLE001 — lượt lỗi không được làm treo khung chat
        log.exception("Lượt Gen %s lỗi", inp.turn_id)
        try:
            await turn.emit({"kind": "say", "text": FAILED.format(addr=turn.addr)})
            await turn.finish("failed")
        except Exception:  # noqa: BLE001
            log.exception("Không kết thúc được lượt Gen %s", inp.turn_id)


async def _run(turn: Turn, *, app: Any, router: ModelRouter, session_token: str,
               decider: decmod.Decider | None) -> None:
    user, inp = turn.user, turn.inp
    runner = ToolRunner(app, user, session_token)
    screen = inp.screen_key if inp.screen_key and registry.screen_exists(inp.screen_key) else None
    validator = Validator(user.permissions, runner.seen_ids, screen)
    async with turn.sm() as db:
        history = await store.list_messages(db, inp.conversation_id)
        dec = decider or await decmod.load_decider(db, user.org_id)
    # Tin cuối trong lịch sử là chính câu hỏi này (routes đã lưu) — bỏ ra, đưa riêng ở cuối.
    prior = history[:-1] if history and history[-1]["role"] == "user" else history
    hints = await _hints(turn, dec, inp.text, inp)
    messages = [Message("system", system_prompt(user, inp, hints)), *_history_text(prior),
                Message("user", inp.text[:4000])]
    retried = False
    for _ in range(MAX_ROUNDS):
        try:
            routed = await router.generate(user.org_id, agent_key=AGENT_KEY, purpose="gen.turn", messages=messages,
                                           json_mode=True)
        except ModelUnavailable as e:
            await turn.emit({"kind": "say", "text": NO_MODEL.format(addr=turn.addr)})
            await turn.log("gen.answer", result="failed", target_type="model", reasons=e.reasons[:5])
            if registry.can_see(user.permissions, "api"):
                await _ui(turn, validator, envelope.Navigate(type="navigate", screen="api"))
                await _ui(turn, validator, envelope.Highlight(
                    type="highlight", target="api.bindings",
                    message="Chọn model cho dòng \"Gen — trợ lý quản trị\" (core.gen)"))
            return
        turn.model, turn.provider = routed.model, routed.provider
        try:
            env = envelope.parse(routed.text)
        except envelope.EnvelopeError as e:
            await turn.log("gen.answer", result="blocked", target_type="envelope", error=str(e)[:300])
            if retried:
                await turn.emit({"kind": "say", "text": NOT_UNDERSTOOD.format(addr=turn.addr)})
                return
            retried = True
            messages += [Message("assistant", routed.text[:2000]),
                         Message("user", f"JSON sai schema ({str(e)[:300]}). Trả lại đúng một JSON {{\"steps\": […]}}"
                                         " theo hướng dẫn, không thêm chữ nào khác.")]
            continue
        observations: list[str] = []
        finished = False
        for step in env.steps:
            if isinstance(step, envelope.Say):
                await turn.emit(envelope.dump_step(step))
            elif isinstance(step, envelope.ToolCall):
                res = await runner.run(step.name, step.args)
                await turn.log("gen.query", result="ok" if res.ok else "blocked", target_type="tool",
                               target_id=step.name, tool=step.name, args_digest=digest(step.args),
                               error=res.error)
                await turn.emit({"kind": "tool", "name": step.name, "args": step.args})
                observations.append(f"[kết quả {step.name}] {res.text}")
            elif isinstance(step, envelope.Ui):
                err = await _ui(turn, validator, step.action)
                if err:
                    observations.append(f"[bị chặn] {err}")
            elif isinstance(step, envelope.Suggest):
                await _suggest(turn, validator, step, observations)
            else:
                finished = True
                break
        # Xong khi model báo done, hoặc vòng này không có gì cần model xem lại (không tool, không bị chặn).
        if finished or not observations:
            return
        messages += [Message("assistant", routed.text[:3000]),
                     Message("user", "Kết quả / phản hồi của hệ thống:\n" + "\n".join(observations)[:12000])]
    await turn.log("gen.answer", result="failed", target_type="turn", error="hết số vòng")


async def _suggest(turn: Turn, validator: Validator, step: envelope.Suggest, observations: list[str]) -> None:
    ok_items = []
    for it in step.items:
        v = validator.check(it.action, commit=False)
        if v.ok:
            ok_items.append(it)
        else:
            observations.append(f"[đề xuất bị chặn] {it.label}: {v.reason}")
    if ok_items:
        await turn.emit(envelope.dump_step(envelope.Suggest(kind="suggest", items=ok_items)))
    await turn.log("gen.suggest", result="ok" if ok_items else "blocked", target_type="screen",
                   count=len(ok_items), blocked=len(step.items) - len(ok_items))


async def _ui(turn: Turn, validator: Validator, action: Any) -> str | None:
    v = validator.check(action)
    kind = ACTION_NAMES[action.type]
    target = getattr(action, "target", None) or getattr(action, "screen", None)
    if not v.ok:
        await turn.log(kind, result="blocked", target_type="screen", target_id=target, reason=v.reason)
        return v.reason
    await turn.emit({"kind": "ui", "action": action.model_dump(mode="json", exclude_none=True)})
    if isinstance(action, envelope.Tour):
        await turn.log(kind, target_type="screen", target_id=v.screen, steps=len(action.steps))
    else:
        await turn.log(kind, target_type="record" if ":" in (target or "") else "screen", target_id=target)
    return None
