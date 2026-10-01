"""Danh sách model cho nguồn CLI (v0.1.31 — Boss: "không thấy model và nhóm model nào để chọn").

- Antigravity CLI: `agy models` liệt kê model của gói (cần đã đăng nhập; chưa đăng nhập thì thoát 1 với "Please sign
  in to view available models" — đo thật trên agy 1.2.9). Định dạng dòng chưa đo được khi đã đăng nhập, nên bộ đọc
  chấp nhận cả "mã-model" lẫn "Tên hiển thị (Mức)" ở bất kỳ vị trí nào trong dòng, rồi nhóm theo họ model.
- Claude Code CLI: không có lệnh liệt kê model (`claude --help` 2.1.286) → dùng bí danh chính thức của `--model`
  (`claude --help`: "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet')"; tài liệu: thêm 'haiku').
- Danh mục dự phòng chỉ là GỢI Ý: mọi model được gọi thử thật trước khi lưu (gh.providers.router.probe_model), CLI từ
  chối thì không lưu — không bao giờ ghi một mã model "bịa".
"""

import re
from typing import Any

_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r")
# Mã model: họ đã biết + phần đuôi chữ/số/chấm/gạch (gemini-3.8-flash-high, claude-sonnet-4-6, gpt-oss-120b…).
_SLUG = re.compile(r"(?<![\w./-])((?:gemini|claude|gpt-oss|gpt|o\d|deepseek|llama|qwen|mistral)[a-z0-9]*"
                   r"(?:[-.][a-z0-9]+)+)(?![\w/-])", re.I)
# Tên hiển thị khi dòng không có mã: "Gemini 3.8 Flash (High)", "Claude Sonnet 4.6 (Thinking)".
_DISPLAY = re.compile(r"\b(Gemini|Claude|GPT-OSS)\s+([A-Za-z0-9. ]+?)\s*(?:\(([A-Za-z ]+)\))?\s*$")
_SKIP = re.compile(r"available models|fetching|error|sign in|please|usage:|^\s*$", re.I)

GROUP_ORDER = ("Gemini", "Claude (qua Antigravity)", "Claude", "GPT-OSS", "Khác")
TIER_HINT = {"fast": "nhanh, rẻ", "balanced": "cân bằng", "strong": "mạnh, chậm hơn, tốn hạn mức hơn"}

# Antigravity: các mã có trong agy 1.2.9 (chuỗi trong tệp chạy) — vẫn gọi thử trước khi lưu.
AGY_FALLBACK: tuple[str, ...] = (
    "gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high",
    "gemini-3.1-pro-low", "gemini-3.1-pro-high",
    "claude-sonnet-4-6", "claude-opus-4-6",
)
# Claude Code: bí danh của `claude --model` (tự trỏ tới bản mới nhất mà gói cho dùng).
CLAUDE_CODE_MODELS: tuple[dict[str, str], ...] = (
    {"id": "haiku", "label": "Haiku (bản mới nhất)", "tier": "fast"},
    {"id": "sonnet", "label": "Sonnet (bản mới nhất)", "tier": "balanced"},
    {"id": "opus", "label": "Opus (bản mới nhất)", "tier": "strong"},
    {"id": "fable", "label": "Fable (bản mới nhất)", "tier": "strong"},
)


def strip_ansi(s: str) -> str:
    return _ANSI.sub("", s)


def _display_to_slug(family: str, rest: str, level: str | None) -> str:
    parts = [family.lower(), *rest.lower().split()]
    if level:
        parts += level.lower().split()
    return "-".join(p for p in parts if p)


def parse_agy_models(text: str) -> list[dict[str, Any]]:
    """Đọc đầu ra `agy models` → [{id, label?, current}] theo thứ tự xuất hiện, không trùng."""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in strip_ansi(text).splitlines():
        line = raw.strip().lstrip("*•->› ").strip()
        if not line or (_SKIP.search(line) and not _SLUG.search(line)):
            continue
        current = bool(re.search(r"\(current\)|\(default\)|\bcurrent\b|^\s*[*>›]", raw, re.I))
        m = _SLUG.search(line)
        if m:
            slug = m.group(1).lower()
            label = (line[:m.start()] + line[m.end():]).strip(" -—:|()[]")
            label = re.sub(r"\s*\((current|default)\)\s*", " ", label, flags=re.I).strip()
        else:
            d = _DISPLAY.search(re.sub(r"\s*\((current|default)\)\s*$", "", line, flags=re.I))
            if not d:
                continue
            slug = _display_to_slug(d.group(1), d.group(2), d.group(3))
            label = d.group(0).strip()
        if slug in seen:
            continue
        seen.add(slug)
        out.append({"id": slug, "label": label or None, "current": current})
    return out


def family(kind: str, model_id: str) -> str:
    m = model_id.lower()
    if m.startswith("gemini"):
        return "Gemini"
    if m.startswith("claude") or m in {"haiku", "sonnet", "opus", "fable", "opusplan"} or m.split("[")[0] in {
            "sonnet", "opus"}:
        return "Claude (qua Antigravity)" if kind == "antigravity_cli" else "Claude"
    if m.startswith("gpt-oss") or m.startswith("gpt"):
        return "GPT-OSS"
    return "Khác"


def tier(model_id: str) -> str:
    m = model_id.lower()
    if any(t in m for t in ("lite", "-low", "haiku", "nano", "mini", "-20b")):
        return "fast"
    if any(t in m for t in ("-pro", "opus", "fable", "-high", "ultra", "-120b")):
        return "strong"
    return "balanced"


def _pretty(model_id: str) -> str:
    words = re.split(r"[-_]", model_id)
    return " ".join(w.upper() if w in {"gpt", "oss"} else w.capitalize() for w in words if w)


def describe(kind: str, model_id: str, *, label: str | None = None, source: str = "cli",
             tier_hint: str | None = None) -> dict[str, Any]:
    t = tier_hint or tier(model_id)
    return {"id": model_id, "label": label or _pretty(model_id), "group": family(kind, model_id), "tier": t,
            "hint": TIER_HINT[t], "source": source}


def fallback(kind: str) -> list[dict[str, Any]]:
    if kind == "claude_code_cli":
        return [describe(kind, m["id"], label=m["label"], source="catalog", tier_hint=m["tier"])
                for m in CLAUDE_CODE_MODELS]
    if kind == "antigravity_cli":
        return [describe(kind, m, source="catalog") for m in AGY_FALLBACK]
    return []


def grouped(models: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """[{label, models}] theo GROUP_ORDER; trong nhóm giữ thứ tự gốc."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for m in models:
        groups.setdefault(m["group"], []).append(m)
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    return [{"label": g, "models": ms} for g, ms in sorted(groups.items(), key=lambda kv: order.get(kv[0], 99))]


def build(kind: str, discovered: list[str] | list[dict[str, Any]] | None) -> dict[str, Any]:
    """Danh sách cuối cho Console: model CLI liệt kê được (nguồn "cli"), không có thì danh mục dự phòng ("catalog")."""
    items: list[dict[str, Any]] = []
    for d in discovered or []:
        if isinstance(d, dict):
            items.append(describe(kind, d["id"], label=d.get("label")))
        elif not re.search(r"embed", d, re.I):
            items.append(describe(kind, d))
    source = "cli" if items else "catalog"
    if not items:
        items = fallback(kind)
    return {"models_source": source, "model_groups": grouped(items), "models": [m["id"] for m in items]}
