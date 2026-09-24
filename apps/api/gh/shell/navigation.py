"""Cây danh mục của Console — chép đúng NAV trong docs/design/Gen-Harness Console.dc.html.

Chỉ nhãn, icon, cấu trúc lấy từ thiết kế. Số badge KHÔNG lấy từ thiết kế (đó là số mẫu):
badge được tính từ dữ liệu thật qua `BadgeSource`; chưa có nguồn → `null`.
"""

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from gh.auth import rbac

OK, WARN, BAD, ACCENT = "ok", "warn", "bad", "accent"


def _s(key: str, icon: str, name: str, en: str, tone: str | None = None,
       children: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"key": key, "icon": icon, "name": name, "en": en, "badge_tone": tone, "children": children or []}


def _g(name: str, icon: str, children: list[dict[str, Any]]) -> dict[str, Any]:
    return {"key": None, "icon": icon, "name": name, "en": None, "badge_tone": None, "children": children}


NAV: list[dict[str, Any]] = [
    {"domain": "business", "label": "Kinh doanh", "crumb": "KINH DOANH", "icon": "ph-fill ph-briefcase", "tone": OK,
     "groups": [
         _s("overview", "ph ph-gauge", "Tổng quan điều hành", "Command Overview — màn hình 10 phút", BAD),
         _g("Hàng đợi & Hành động", "ph ph-tray", [
             _s("inbox", "ph ph-tray", "Hộp thư ý nghĩa", "Inbox of Meaning", WARN),
             _s("workbench", "ph ph-pen-nib", "Bàn làm việc", "Workbench — soạn & duyệt", WARN),
             _s("tasks", "ph ph-check-square", "Việc & Nhắc hẹn", "Tasks & Reminders", BAD),   # spec G1, PLAN Q5
         ]),
         _s("directory", "ph ph-address-book", "Nhóm & Con người", "Groups by channel · people filters"),
         _s("documents", "ph ph-files", "Tài liệu", "Documents"),                               # spec G1, PLAN Q5
         _s("graph", "ph ph-graph", "Bản đồ quan hệ", "Relationship Map", children=[
             _s("profile", "ph ph-identification-card", "Hồ sơ sống", "Living Profile — bấm một node để mở"),
             _s("notebook", "ph ph-notebook", "Sổ tay nhận thức", "Assistant notebook per ID"),
         ]),
         _g("Cơ hội & Thị trường", "ph ph-target", [
             _s("opportunity", "ph ph-target", "Bảng cơ hội", "Opportunity Board", OK),
             _s("supply", "ph ph-arrows-left-right", "Cung ↔ Cầu", "Supply & Demand", OK),
             _s("search", "ph ph-brain", "Kho hội thoại", "Knowledge & Search"),
             _s("deals", "ph ph-handshake", "Deal & Vụ việc", "Deals & Cases"),                 # spec G1, PLAN Q5
         ]),
         _g("Con người & Chất lượng", "ph ph-users-three", [
             _s("people", "ph ph-users-three", "Đánh giá con người", "People Review"),
             _s("care", "ph ph-heartbeat", "Chất lượng chăm sóc", "Care Quality"),
         ]),
     ]},
    {"domain": "tech", "label": "Kỹ thuật · Backend", "crumb": "KỸ THUẬT", "icon": "ph-fill ph-cpu", "tone": ACCENT,
     "groups": [
         _g("Tầng dữ liệu", "ph ph-database", [
             _s("raw", "ph ph-database", "Kho dữ liệu thô", "Raw Lake — bridge gom về", WARN),
             _s("rules", "ph ph-funnel", "Quy tắc sàng lọc", "Refinery Rules"),
             _s("clean", "ph ph-check-circle", "Kho sạch SSOT", "Clean store & working memory"),
             _s("identity", "ph ph-git-merge", "Hợp nhất danh tính", "Identity Resolution", WARN),
         ]),
         _g("Agent & Model", "ph ph-robot", [
             _s("agents", "ph ph-user-focus", "Danh tính Agent", "Agent Identity"),
             _s("api", "ph ph-plugs", "API & Model", "AI agent API settings"),
             _s("mcp", "ph ph-plugs-connected", "MCP Hub", "External MCP servers", OK),
         ]),
         _s("plugins", "ph ph-puzzle-piece", "Plugin & Tiện ích", "DSH base plugins & external add-ons", OK),
         _s("system", "ph ph-sliders-horizontal", "Điều khiển hệ thống", "System Control — kênh, quyền, nhật ký"),
     ]},
]

# Màn có badge trong thiết kế. Mỗi giai đoạn đăng ký nguồn số thật cho màn của mình.
BadgeSource = Callable[[Any], Awaitable[int | None]]
BADGE_SCREENS = ("overview", "inbox", "workbench", "tasks", "opportunity", "supply", "raw", "identity", "mcp", "plugins")


def format_badge(n: int | None) -> str | None:
    if n is None or n <= 0:
        return None
    if n >= 1000:
        k = n / 1000
        return f"{k:.0f}k" if k >= 10 else f"{k:.1f}k".replace(".0k", "k")
    return str(n)


def _filter(node: dict[str, Any], perms: Mapping[str, str], badges: Mapping[str, int | None]) -> dict[str, Any] | None:
    children = [c for c in (_filter(ch, perms, badges) for ch in node["children"]) if c is not None]
    key = node["key"]
    visible = key is not None and rbac.can_see_screen(dict(perms), key)
    if not visible and not children:
        return None
    value = format_badge(badges.get(key)) if key else None
    return {"key": key if visible else None, "icon": node["icon"], "name": node["name"], "en": node["en"],
            "badge": {"value": value, "tone": node["badge_tone"] or OK} if value else None,
            "children": children}


def _count(groups: list[dict[str, Any]]) -> int:
    # Cách đếm của thiết kế ("11 màn", "9 màn"): mỗi mục cấp 1 tính số con nếu có con, không thì tính 1.
    return sum(len(g["children"]) if g["children"] else 1 for g in groups)


def build(perms: Mapping[str, str], badges: Mapping[str, int | None] | None = None) -> list[dict[str, Any]]:
    out = []
    for dm in NAV:
        groups = [g for g in (_filter(n, perms, badges or {}) for n in dm["groups"]) if g is not None]
        if groups:
            out.append({k: dm[k] for k in ("domain", "label", "crumb", "icon", "tone")} |
                       {"count": _count(groups), "groups": groups})
    return out


def all_screen_keys() -> list[str]:
    keys: list[str] = []

    def walk(nodes: list[dict[str, Any]]) -> None:
        for n in nodes:
            if n["key"]:
                keys.append(n["key"])
            walk(n["children"])

    for dm in NAV:
        walk(dm["groups"])
    return keys
