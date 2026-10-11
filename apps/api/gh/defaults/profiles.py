"""Hồ sơ model tiêu chuẩn theo VAI (v0.1.55, G1 — "Chế độ tiêu chuẩn").

Cài xong chưa gán model nào mà Gen vẫn trả lời được: bộ định tuyến (`gh.providers.router.ModelRouter._chain`) tự
chọn model cho từng VAI theo bảng A1 dưới đây — dữ liệu theo (vai × loại nguồn), KHÔNG ghi cứng tên model: nguồn nào
đang bật thì chọn trong `agent.models` đã bật của nguồn đó theo TẦNG (`gh.providers.catalog.tier_of`: fast / balanced
/ strong). Thiếu tầng thì lấy tầng gần nhất; KHÔNG tự thêm dòng model nào. Dòng `agent.bindings` Owner đã đổi luôn
thắng hồ sơ.

Luật cứng KHÔNG đổi (bảng A1 chỉ chọn trong phạm vi đã được phép):
- việc nền (sàng lọc tin `core.refinery`, trực việc `agent:*`, Bản tin `core.briefing`) KHÔNG BAO GIỜ chạy
  Antigravity CLI (F-22); Claude Code CLI chỉ khi Owner đã cho phép việc nền (F-86); thiếu nguồn khoá API thì giữ
  hành vi cũ (hết chuỗi → cảnh báo), KHÔNG tự chuyển sang CLI;
- Antigravity CLI chỉ cho `core.gen` của Owner (`allow_agy`).

`resolve()` THUẦN (không DB) để test ma trận; phần truy vấn DB nằm ở `load_rows` / `standard_for` / `choice_options`.
"""

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from gh.providers import catalog

KIND_CLAUDE = "claude_code_cli"
KIND_AGY = "antigravity_cli"
KIND_API = "api"
API_KINDS = ("gemini", "deepseek", "openai_compat")
CLI_KINDS = (KIND_AGY, KIND_CLAUDE)

TIER_ORDER = catalog.TIERS                   # ("fast", "balanced", "strong")
TIER_LABEL = {"fast": "Nhanh", "balanced": "Cân bằng", "strong": "Kỹ hơn"}
#: Tầng của khung chat (TurnIn.model_choice.tier): 'deep' ↔ 'strong'; 'auto' = hồ sơ tiêu chuẩn.
CHOICE_TIERS = ("auto", "fast", "balanced", "deep")
CHOICE_EFFORTS = ("low", "medium", "high")   # chat chỉ cho chọn ba mức này (Thấp/Vừa/Cao)

ROLE_GEN, ROLE_BRIEFING, ROLE_REFINERY, ROLE_REPLY, ROLE_AGENT = (
    "core.gen", "core.briefing", "core.refinery", "core.reply", "agent:*")
#: Vai chạy nền (không có Sếp ngồi trước màn hình): luật F-22/F-86 áp bất kể `purpose` bên gọi truyền.
BACKGROUND_ROLES = frozenset({ROLE_BRIEFING, ROLE_REFINERY, ROLE_AGENT})


@dataclass(frozen=True)
class Profile:
    tier: str
    effort: str | None
    temperature: float
    context_tokens: int


# Bảng A1 — vai × loại nguồn → hồ sơ. Vắng mục = vai đó KHÔNG dùng loại nguồn ấy.
PROFILES: dict[str, dict[str, Profile]] = {
    # Gen: CLI cân bằng/vừa; agy cân bằng (flash)/vừa; khoá API cân bằng.
    ROLE_GEN: {KIND_CLAUDE: Profile("balanced", "medium", 0.3, 6000),
               KIND_AGY: Profile("balanced", "medium", 0.3, 6000),
               KIND_API: Profile("balanced", None, 0.3, 6000)},
    # Bản tin Gen: khoá API nhanh; CLI nhanh CHỈ khi Owner cho phép việc nền; agy KHÔNG.
    ROLE_BRIEFING: {KIND_API: Profile("fast", None, 0.2, 6000),
                    KIND_CLAUDE: Profile("fast", None, 0.2, 6000)},
    # Sàng lọc: khoá API nhanh t=0,2 (JSON sai hai lần: runner hiện có tự lên balanced — ở đây chỉ cấp tầng); không agy.
    ROLE_REFINERY: {KIND_API: Profile("fast", None, 0.2, 6000),
                    KIND_CLAUDE: Profile("fast", None, 0.2, 6000)},
    # Soạn lại / dịch nháp: CLI cân bằng/thấp; khoá API cân bằng; agy KHÔNG (F-22).
    ROLE_REPLY: {KIND_CLAUDE: Profile("balanced", "low", 0.3, 6000),
                 KIND_API: Profile("balanced", None, 0.3, 6000)},
    # Agent trực việc: khoá API cân bằng t=0,3 ngữ cảnh 6000; CLI chỉ khi cho phép việc nền; agy KHÔNG.
    ROLE_AGENT: {KIND_API: Profile("balanced", None, 0.3, 6000),
                 KIND_CLAUDE: Profile("balanced", None, 0.3, 6000)},
}


def role_of(agent_key: str) -> str | None:
    """Khoá agent → vai của bảng A1; khoá lạ (core.embedding…) không có hồ sơ ⇒ None (chuỗi chỉ theo hạng như cũ)."""
    if agent_key in PROFILES:
        return agent_key
    if agent_key.startswith("agent:"):
        return ROLE_AGENT
    return None


def kind_class(kind: str) -> str | None:
    if kind in (KIND_CLAUDE, KIND_AGY):
        return kind
    if kind in API_KINDS:
        return KIND_API
    return None


def normalize_tier(tier: str | None) -> str | None:
    """'deep' (chat) → 'strong'; 'auto'/None/giá trị lạ → None (hồ sơ tiêu chuẩn tự chọn)."""
    if tier == "deep":
        return "strong"
    return tier if tier in TIER_ORDER else None


def _g(row: Any, name: str, default: Any = None) -> Any:
    if isinstance(row, Mapping):
        return row.get(name, default)
    return getattr(row, name, default)


def allowed_efforts(kind: str, model_name: str) -> tuple[str, ...]:
    """Mức suy nghĩ model cho phép: theo nguồn ĐÃ xác minh (`known_efforts`), không biết thì theo CLI (`valid_efforts`).
    Nguồn khoá API không có mức suy nghĩ ⇒ rỗng; haiku ⇒ rỗng."""
    if kind not in CLI_KINDS:
        return ()
    base = catalog.split_variant(kind, model_name.split("[")[0])[0]
    known = catalog.known_efforts(kind, base)
    if known is None and kind == KIND_AGY:
        # Danh mục agy (biến thể trong tệp chạy `agy`): gemini-3.1-pro chỉ nhận low/high — gửi "medium" là CLI từ chối.
        for m in catalog.AGY_FALLBACK:
            if m["id"] == base.lower():
                known = tuple(m["efforts"])
    return tuple(known) if known is not None else catalog.valid_efforts(kind)


def effort_for(kind: str, model_name: str, effort: str | None) -> str | None:
    """`effort` nếu model hỗ trợ đúng mức đó, ngược lại None (không bao giờ gửi mức model không có)."""
    return effort if effort and effort in allowed_efforts(kind, model_name) else None


def _model_ok(m: Any) -> bool:
    name = str(_g(m, "model_name", ""))
    return bool(_g(m, "is_enabled", True)) and "embedding" not in name.lower()


def pick_model(kind: str, models: Sequence[Any], wanted: str) -> tuple[Any, str] | None:
    """Model của MỘT nguồn theo tầng `wanted`: đúng tầng (giữ thứ tự đầu vào: mặc định trước), thiếu tầng thì tầng
    gần nhất (hoà thì tầng rẻ hơn). Chỉ chọn trong model đã bật; không có model ⇒ None. Trả (dòng model, tầng thực)."""
    best: tuple[int, int, int, Any, str] | None = None
    want = TIER_ORDER.index(wanted)
    for i, m in enumerate(models):
        if not _model_ok(m):
            continue
        t = catalog.tier_of(kind, str(_g(m, "model_name", "")))
        if t is None:
            continue
        ti = TIER_ORDER.index(t)
        key = (abs(ti - want), ti, i)
        if best is None or key < best[:3]:
            best = (*key, m, t)
    return None if best is None else (best[3], best[4])


def _rank_key(p: Any) -> tuple[int, int]:
    r = _g(p, "failover_rank")
    return (1, 0) if r is None else (0, int(r))


def provider_allowed(kind: str, *, bg: bool, bg_cli_allowed: set[str] | frozenset[str], allow_agy: bool) -> bool:
    """Luật cứng F-22/F-86 cho MỘT loại nguồn (hồ sơ tiêu chuẩn chỉ chọn trong phạm vi này)."""
    if kind == KIND_AGY:
        return allow_agy and not bg
    if kind == KIND_CLAUDE:
        return (not bg) or kind in bg_cli_allowed
    return kind in API_KINDS


def resolve(providers_rows: Sequence[Any], models_rows: Sequence[Any], agent_key: str, *, background: bool,
            bg_cli_allowed: set[str] | frozenset[str], allow_agy: bool,
            tier_override: str | None = None) -> list[dict[str, Any]]:
    """Hồ sơ tiêu chuẩn của MỘT vai → danh sách ứng viên (nguồn + model), THỨ TỰ theo hạng nguồn (failover_rank).

    - `providers_rows`: id, kind, name, is_enabled (mặc định True), failover_rank, has_key (chỉ nguồn khoá API; vắng =
      coi như có). `models_rows`: id, provider_id, model_name, is_enabled, effort… (thứ tự vào = ưu tiên trong tầng).
    - `background`: purpose của lượt gọi là việc nền; các VAI nền (sàng lọc, trực việc, bản tin) luôn bị coi là việc
      nền.
    - `bg_cli_allowed`: CLI Owner đã cho chạy việc nền (chỉ `claude_code_cli`); `allow_agy`: lượt Gen của Owner.
    - `tier_override`: ép tầng (chat chọn Nhanh / Cân bằng / Kỹ hơn) — vẫn tôn trọng mọi luật trên.
    Hàm thuần: không DB, không Redis. Thiếu tầng ⇒ tầng gần nhất; KHÔNG tự thêm dòng model."""
    role = role_of(agent_key)
    if role is None:
        return []
    forced = normalize_tier(tier_override)
    bg = background or role in BACKGROUND_ROLES
    by_provider: dict[str, list[Any]] = {}
    for m in models_rows:
        by_provider.setdefault(str(_g(m, "provider_id")), []).append(m)
    out: list[dict[str, Any]] = []
    for p in sorted(providers_rows, key=_rank_key):
        kind = str(_g(p, "kind", ""))
        kc = kind_class(kind)
        prof = PROFILES[role].get(kc) if kc else None
        if prof is None or not _g(p, "is_enabled", True):
            continue
        if kc == KIND_API and _g(p, "has_key", True) is False:
            continue
        if not provider_allowed(kind, bg=bg, bg_cli_allowed=bg_cli_allowed, allow_agy=allow_agy):
            continue
        wanted = forced or prof.tier
        picked = pick_model(kind, by_provider.get(str(_g(p, "id")), []), wanted)
        if picked is None:
            continue
        m, actual = picked
        out.append({"provider_id": _g(p, "id"), "provider_kind": kind, "provider_name": _g(p, "name"),
                    "model_id": _g(m, "id"), "model_name": str(_g(m, "model_name")), "tier": actual,
                    "wanted_tier": wanted, "effort": effort_for(kind, str(_g(m, "model_name")), prof.effort),
                    "temperature": prof.temperature, "context_tokens": prof.context_tokens, "role": role,
                    "source": "profile"})
    return out


REASON_NEED_API = "cần khoá API (Antigravity chỉ dùng cho Gen)"
REASON_NEED_API_OR_CLAUDE = "cần khoá API hoặc Claude Code CLI"
REASON_NO_SOURCE = "chưa có nguồn phù hợp"


def missing_reason(providers_rows: Sequence[Any], models_rows: Sequence[Any], agent_key: str,
                   bg_cli_allowed: set[str] | frozenset[str] = frozenset()) -> str:
    """v0.1.58 — vì sao `resolve()` không ra ứng viên cho vai này (hàm thuần, KHÔNG đổi `resolve` / `pick_model`).

    Gọi khi `resolve` rỗng; câu trả về nối sau "Chuẩn: " ở web. Thứ tự:
    1. có nguồn ĐƯỢC PHÉP dùng cho vai này (đúng luật F-22/F-86) nhưng 0 model ⇒ "chưa có model — bấm Kiểm tra kết nối
       ở <nguồn>" (đường tự sửa của Sếp);
    2. vai nền chỉ còn Antigravity (không được dùng) / không có khoá API ⇒ "cần khoá API (Antigravity chỉ dùng cho
       Gen)";
    3. trả lời lại / soạn nháp (core.reply) ⇒ "cần khoá API hoặc Claude Code CLI";
    4. còn lại ⇒ "chưa có nguồn phù hợp"."""
    role = role_of(agent_key)
    if role is None:
        return REASON_NO_SOURCE
    bg, agy = role_flags(agent_key)
    has_model = {str(_g(m, "provider_id")) for m in models_rows if _model_ok(m)}
    for p in sorted(providers_rows, key=_rank_key):
        kind = str(_g(p, "kind", ""))
        kc = kind_class(kind)
        if kc is None or PROFILES[role].get(kc) is None or not _g(p, "is_enabled", True):
            continue
        if kc == KIND_API and _g(p, "has_key", True) is False:
            continue
        if not provider_allowed(kind, bg=bg, bg_cli_allowed=bg_cli_allowed, allow_agy=agy):
            continue
        if str(_g(p, "id")) not in has_model:
            return f"chưa có model — bấm Kiểm tra kết nối ở {_g(p, 'name') or kind}"
    if bg:
        return REASON_NEED_API
    if role == ROLE_REPLY:
        return REASON_NEED_API_OR_CLAUDE
    return REASON_NO_SOURCE


def profile_effort(agent_key: str, kind: str, model_name: str) -> str | None:
    """Mức suy nghĩ của hồ sơ cho (vai, loại nguồn, model); None khi vai/nguồn không có hoặc model không hỗ trợ."""
    role = role_of(agent_key)
    kc = kind_class(kind)
    prof = PROFILES[role].get(kc) if role and kc else None
    return effort_for(kind, model_name, prof.effort) if prof else None


# ─── truy vấn DB ──────────────────────────────────────────────────────────────

async def load_rows(db: AsyncSession, org_id: uuid.UUID) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Nguồn sinh văn bản đang bật + model đã bật của tổ chức, đúng thứ tự chuỗi (hạng nguồn, model mặc định trước)."""
    prov = (await db.execute(text("""
        SELECT p.id, p.kind, p.name, p.is_enabled, p.failover_rank, p.auth_state, p.created_at,
               EXISTS (SELECT 1 FROM agent.provider_keys k WHERE k.provider_id = p.id AND k.is_enabled) AS has_key
        FROM agent.providers p
        WHERE p.org_id = :o AND p.is_enabled AND p.kind NOT IN ('embedding', 'system_one')
        ORDER BY p.failover_rank NULLS LAST, p.created_at"""), {"o": org_id})).all()
    mods = (await db.execute(text("""
        SELECT m.id, m.provider_id, m.model_name, m.effort, m.is_default, m.is_enabled
        FROM agent.models m JOIN agent.providers p ON p.id = m.provider_id
        WHERE p.org_id = :o AND m.is_enabled AND m.model_name NOT ILIKE '%embedding%'
        ORDER BY m.is_default DESC, m.id"""), {"o": org_id})).all()
    providers = [{"id": r.id, "kind": r.kind, "name": r.name, "is_enabled": r.is_enabled,
                  "failover_rank": r.failover_rank, "auth_state": r.auth_state,
                  "has_key": bool(r.has_key) if r.kind in API_KINDS else True} for r in prov]
    models = [{"id": r.id, "provider_id": r.provider_id, "model_name": r.model_name, "effort": r.effort,
               "is_default": r.is_default, "is_enabled": r.is_enabled} for r in mods]
    return providers, models


def role_flags(agent_key: str) -> tuple[bool, bool]:
    """(background, allow_agy) mặc định của một vai khi hiển thị "Chuẩn: …" — việc nền cho vai nền; agy chỉ cho Gen."""
    role = role_of(agent_key)
    return role in BACKGROUND_ROLES, role == ROLE_GEN


async def standard_with_reasons(
        db: AsyncSession, org_id: uuid.UUID, agent_keys: Sequence[str],
) -> tuple[dict[str, dict[str, Any] | None], dict[str, str | None]]:
    """Như `standard_for` + (v0.1.58) LÝ DO khi một vai chưa có model chuẩn (`missing_reason`; vai đã có ⇒ None)."""
    from gh.providers.router import background_cli_allowed

    providers, models = await load_rows(db, org_id)
    bg_cli = await background_cli_allowed(db, org_id)
    std: dict[str, dict[str, Any] | None] = {}
    why: dict[str, str | None] = {}
    for key in agent_keys:
        bg, agy = role_flags(key)
        cands = resolve(providers, models, key, background=bg, bg_cli_allowed=bg_cli, allow_agy=agy)
        std[key] = cands[0] if cands else None
        why[key] = None if cands else missing_reason(providers, models, key, bg_cli)
    return std, why


async def standard_for(db: AsyncSession, org_id: uuid.UUID,
                       agent_keys: Sequence[str]) -> dict[str, dict[str, Any] | None]:
    """Model hồ sơ tiêu chuẩn đang phủ từng khoá agent (ứng viên đầu tiên) — dùng cho "Chuẩn: <model> (tự chọn)" ở
    Bộ não AI / API & Model và mục Về mặc định. Khoá không có nguồn phù hợp ⇒ None."""
    return (await standard_with_reasons(db, org_id, agent_keys))[0]


def standard_public(c: dict[str, Any] | None) -> dict[str, Any] | None:
    """Ứng viên → khối JSON cho web (chỉ chuỗi/số/null — web không render object)."""
    if c is None:
        return None
    return {"model_name": str(c["model_name"]), "provider_name": str(c["provider_name"]), "tier": str(c["tier"]),
            "tier_label": TIER_LABEL[str(c["tier"])], "effort": c["effort"], "temperature": float(c["temperature"]),
            "context_tokens": int(c["context_tokens"])}


def standard_text(c: dict[str, Any] | None, reason: str | None = None) -> str:
    """"Chuẩn: <model> (tự chọn)" hoặc "Chuẩn: <lý do>" (v0.1.58: lý do cụ thể từ `missing_reason`)."""
    return f"Chuẩn: {reason or REASON_NO_SOURCE}" if c is None else f"Chuẩn: {c['model_name']} (tự chọn)"


async def choice_options(db: AsyncSession, org_id: uuid.UUID, *, owner: bool, tainted: bool) -> dict[str, Any]:
    """Tầng + mức suy nghĩ mà khung chat (G3) được phép mời Owner chọn — hợp đồng G1 → G3.

    `{'tiers': [{'tier': 'auto'|'fast'|'balanced'|'deep', 'available': bool, 'efforts': [...]}]}`; 'deep' ↔ tầng
    'strong'. Một tầng `available` khi có nguồn DÙNG ĐƯỢC (đang bật; khoá API có khoá; CLI chưa hết hạn đăng nhập) có
    model đã bật ở đúng tầng đó. Người không phải Owner hoặc lượt đang đọc nội dung bên ngoài (`tainted`) không được
    dùng Antigravity CLI ⇒ tầng chỉ phục vụ được bằng agy ⇒ available=false. 'auto' (Tự động, chuẩn) khả dụng khi có
    bất kỳ nguồn nào. `efforts` ⊆ low/medium/high mà các model CLI của tầng ấy hỗ trợ (khoá API: rỗng)."""
    providers, models = await load_rows(db, org_id)
    allow_agy = owner and not tainted
    by_provider: dict[str, list[dict[str, Any]]] = {}
    for m in models:
        by_provider.setdefault(str(m["provider_id"]), []).append(m)
    avail: dict[str, bool] = dict.fromkeys(TIER_ORDER, False)
    efforts: dict[str, set[str]] = {t: set() for t in TIER_ORDER}
    any_source = False
    for p in providers:
        kind = str(p["kind"])
        if kind == KIND_AGY and not allow_agy:
            continue
        if kind in API_KINDS and not p["has_key"]:
            continue
        if kind in CLI_KINDS and p.get("auth_state") == "expired":
            continue
        for m in by_provider.get(str(p["id"]), []):
            t = catalog.tier_of(kind, str(m["model_name"]))
            if t is None:
                continue
            any_source = True
            avail[t] = True
            efforts[t] |= set(allowed_efforts(kind, str(m["model_name"]))) & set(CHOICE_EFFORTS)
    rows: list[dict[str, Any]] = [{"tier": "auto", "available": any_source, "efforts": []}]
    for name, tier in (("fast", "fast"), ("balanced", "balanced"), ("deep", "strong")):
        rows.append({"tier": name, "available": avail[tier], "efforts": catalog.sort_efforts(efforts[tier])})
    return {"tiers": rows}
