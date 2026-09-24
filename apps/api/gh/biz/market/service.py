"""Nền dùng chung của cụm Cơ hội & Thị trường (docs/api/phase-3-market.md): hình dạng dòng, phạm vi, chấm
điểm ghép Cung ↔ Cầu.

Tín hiệu cung/cầu sinh ra từ `clean.meaning_units.side` (`demand|supply`, do quy tắc R-01/R-02 của
`gh.refinery.presets` gán) — xem `gh.biz.market.jobs.market_signal_capture`. `entities` dùng đúng khoá mà
`gh.refinery.extract` yêu cầu model trả: `product`, `qty`, `unit`, `budget_vnd`, `place`, `deadline`,
`competitor` (không có khoá `category`/`location` riêng — `place` đóng vai trò "khu vực" cho chấm điểm ghép).
"""

import re
import uuid
from datetime import date, datetime
from typing import Any

from gh.biz.core.scope import Scope

# Cùng ngưỡng chip cao/trung bình/thấp của docs/api/phase-3.md ("confidence của đơn vị/điểm là số 0–1").
CONF_HIGH, CONF_MED = 0.8, 0.6

# 9 cột của Bảng cơ hội (PLAN §3.8 / spec §5). `CLOSED` không tính vào tổng pipeline đang mở.
STAGES = ("raw_signal", "validated", "matched", "approaching", "negotiating", "handed_off", "won", "lost", "dormant")
CLOSED_STAGES = frozenset({"won", "lost", "dormant"})
OPEN_STAGES = tuple(s for s in STAGES if s not in CLOSED_STAGES)

MIN_MATCH_SCORE = 40.0  # dưới ngưỡng này: không đáng để lưu thành gợi ý ghép (tránh nhiễu — spec E3 "tránh spam")


def confidence_bucket(value: float | None) -> str:
    if value is None:
        return "low"
    if value >= CONF_HIGH:
        return "high"
    if value >= CONF_MED:
        return "medium"
    return "low"


def person_ref(r: Any, prefix: str = "p") -> dict[str, Any] | None:
    pid = getattr(r, f"{prefix}_id", None)
    if pid is None:
        return None
    return {"id": str(pid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "type": getattr(r, f"{prefix}_type", None), "org_name": getattr(r, f"{prefix}_org", None)}


def group_ref(r: Any, prefix: str = "g") -> dict[str, Any] | None:
    gid = getattr(r, f"{prefix}_id", None)
    if gid is None:
        return None
    return {"id": str(gid), "code": getattr(r, f"{prefix}_code", None), "name": getattr(r, f"{prefix}_name", None),
            "channel": getattr(r, f"{prefix}_channel", None)}


def user_ref(id_: Any, name: str | None, role: str | None = None) -> dict[str, Any] | None:
    if id_ is None:
        return None
    return {"id": str(id_), "name": name, "role": role}


# LATERAL đúng một dòng vai trò của người dùng — người có thể có nhiều vai trò, lấy vai trò đầu tiên (đủ cho
# hiển thị UserRef; cùng cách `gh.biz.relations.routes` đã dùng).
USER_ROLE_JOIN = """LEFT JOIN LATERAL (SELECT r2.code FROM core.user_roles ur2 JOIN core.roles r2
                                        ON r2.id = ur2.role_id WHERE ur2.user_id = {alias}.id LIMIT 1) {out} ON true"""


def person_or_group_scope_sql(sc: Scope, person_col: str, group_col: str) -> tuple[str, dict[str, Any]]:
    """Biểu thức phạm vi cho một dòng có thể gắn với người **hoặc** nhóm (một trong hai cột có thể NULL) —
    `biz.market_signals`, `clean.meaning_units` (Kho hội thoại). Thấy được khi người **hoặc** nhóm nằm trong
    phạm vi; cột NULL tự động không khớp (EXISTS trên NULL không có dòng nào)."""
    if sc.is_all:
        return "TRUE", {}
    pw, pp = sc.person_id_sql(person_col)
    gw, gp = sc.group_id_sql(group_col)
    return f"(({person_col} IS NOT NULL AND {pw}) OR ({group_col} IS NOT NULL AND {gw}))", {**pp, **gp}


_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")


def parse_needed_by(value: Any) -> date | None:
    """`entities.deadline` là văn bản tự do (LLM trích) — chỉ nhận khi đã ở dạng `YYYY-MM-DD…`; văn bản khác
    (vd "cuối tháng sau") không tự suy diễn ngày, để trống còn hơn đoán sai (quyết định tự đưa ra)."""
    if not value or not isinstance(value, str):
        return None
    m = _DATE_RE.match(value.strip())
    if not m:
        return None
    try:
        return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None


def _num(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def signal_from_entities(entities: dict[str, Any] | None, conclusion: str) -> dict[str, Any]:
    """Suy `item/category/quantity/unit/value_vnd/location` từ `entities` của một đơn vị ý nghĩa cho
    `biz.market_signals` — dùng ở cả hook ghi tín hiệu và khi build ngữ cảnh chấm điểm."""
    e = entities or {}
    item = (e.get("product") or "").strip() or (conclusion or "")[:200]
    return {"item": item[:300], "category": (e.get("category") or None), "quantity": _num(e.get("qty")),
            "unit": e.get("unit"), "value_vnd": _num(e.get("budget_vnd")), "location": e.get("place"),
            "needed_by": parse_needed_by(e.get("deadline"))}


def _norm_words(text_: str | None) -> set[str]:
    if not text_:
        return set()
    return {w for w in re.split(r"[^\w]+", text_.casefold(), flags=re.UNICODE) if len(w) >= 2}


def score_match(demand: dict[str, Any], supply: dict[str, Any]) -> tuple[float, list[str]]:
    """Chấm điểm ghép một tín hiệu cầu với một tín hiệu cung, 0–100, kèm lý do có thể kiểm chứng lại bằng tay
    (mỗi lý do ghi rõ số điểm đã cộng). Hàm thuần (không đọc CSDL) nên test được trực tiếp.

    Cổng bắt buộc: không cùng mặt hàng (theo từ khoá chung) và không cùng ngành hàng → điểm 0, không tạo gợi ý
    (tránh ghép bừa — spec E3 "tránh tiếp cận bừa"). Sau đó cộng thêm theo số lượng, ngân sách, khu vực.
    """
    reasons: list[str] = []
    score = 0.0
    d_words, s_words = _norm_words(demand.get("item")), _norm_words(supply.get("item"))
    item_match = bool(d_words & s_words)
    cat_match = bool(demand.get("category")) and demand.get("category") == supply.get("category")
    if item_match:
        score += 50
        reasons.append(f"Cùng mặt hàng: \"{demand.get('item')}\" ~ \"{supply.get('item')}\" (+50)")
    elif cat_match:
        score += 30
        reasons.append(f"Cùng ngành hàng: {demand.get('category')} (+30)")
    else:
        return 0.0, ["Không cùng mặt hàng hay ngành hàng — không đủ căn cứ để ghép"]

    dq, sq = demand.get("quantity"), supply.get("quantity")
    if dq and sq and dq > 0 and sq > 0:
        ratio = min(dq, sq) / max(dq, sq)
        pts = round(ratio * 20, 1)
        score += pts
        reasons.append(f"Số lượng khớp {round(ratio * 100)}%: cầu {dq:g} {demand.get('unit') or ''} · "
                       f"cung {sq:g} {supply.get('unit') or ''} (+{pts:g})".replace("  ", " "))

    dv, sv = demand.get("value_vnd"), supply.get("value_vnd")
    if dv and sv and dv > 0:
        if sv <= dv:
            score += 20
            reasons.append(f"Trong ngân sách: cung {sv:,.0f}₫ ≤ ngân sách {dv:,.0f}₫ (+20)".replace(",", "."))
        else:
            over = (sv - dv) / dv
            pts = round(max(0.0, 20 * (1 - over)), 1)
            score += pts
            if pts > 0:
                reasons.append(f"Vượt ngân sách {round(over * 100)}%: cung {sv:,.0f}₫ > ngân sách {dv:,.0f}₫ "
                               f"(+{pts:g})".replace(",", "."))

    dl, sl = demand.get("location"), supply.get("location")
    if dl and sl and str(dl).strip().casefold() == str(sl).strip().casefold():
        score += 10
        reasons.append(f"Cùng khu vực: {dl} (+10)")

    return round(min(score, 100.0), 2), reasons


def when(value: Any) -> datetime | None:
    if value is None or isinstance(value, datetime):
        return value
    return datetime.fromisoformat(str(value).replace("Z", "+00:00"))


def uid_or_none(value: Any) -> uuid.UUID | None:
    if value is None:
        return None
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))
