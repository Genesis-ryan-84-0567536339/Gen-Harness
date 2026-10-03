"""Lớp che dữ liệu dùng chung (gen-v1 §9.2) — chuyển từ `gh.hub_link.service` (v0.1.45, F-57).

Dùng cho nội dung Kho sang model đám mây (liên kết Gen-hub), kết quả tool MCP lưu ở `agent.mcp_calls.result_summary`
và sự kiện WS `mcp.call`, tham số tool ghi trong bản nháp chờ duyệt, thân lỗi từ máy chủ ngoài. Đặt ở `gh.chassis`
để `gh.mcp_api.invoke` và `gh.hub_link.service` cùng dùng mà không vòng import.
"""

import re
from typing import Any

from gh.data.common import mask_text

_RE_LONGNUM = re.compile(r"(?<!\d)(\d[\d .-]{7,22}\d)(?!\d)")
_RE_DATE = re.compile(r"\d{4}-\d{1,2}-\d{1,2}(?: \d{1,2})?|\d{1,2}[.-]\d{1,2}[.-]\d{4}")
_RE_EMAIL = re.compile(r"\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
_RE_SECRET = re.compile(
    r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"
    r"|\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AIza|ya29|ghh|gha)[-_.][A-Za-z0-9._-]{8,}"
    r"|\bAIza[A-Za-z0-9_-]{20,}"
    r"|\b[A-Za-z0-9_-]{40,}\b")
_SECRET_KEYS = re.compile(
    r"(?i)(?:^|[_\s-])(?:password|passwd|mat_?khau|mật khẩu|secret|token|api_?key|pin)(?:$|[_\s-])")
MASK = "[đã che]"


def _mask_str(s: str, extra: tuple[str, ...]) -> str:
    for secret in extra:
        if secret:
            s = s.replace(secret, MASK)
    s = _RE_SECRET.sub(MASK, s)
    s = _RE_EMAIL.sub(lambda m: f"{m.group(1)}•••@{m.group(2)}", s)

    def num(m: re.Match[str]) -> str:
        whole = m.group(1)
        if _RE_DATE.fullmatch(whole.strip()):
            return whole  # ngày tháng không phải dữ liệu nhạy cảm — Kho dùng rất nhiều
        return mask_text(whole, False) or whole

    return _RE_LONGNUM.sub(num, s)


def mask_for_model(data: Any, *, secrets: tuple[str, ...] = ()) -> Any:
    """Che đệ quy mọi chuỗi: số dài ≥ 8 chữ số (tài khoản, thẻ, SĐT — trừ ngày), email, khoá/token; giá trị của
    khoá có tên kiểu mật khẩu/token bị thay hẳn. `secrets` = chuỗi phải xoá tuyệt đối (token của chính liên kết)."""
    if isinstance(data, str):
        return _mask_str(data, secrets)
    if isinstance(data, list):
        return [mask_for_model(v, secrets=secrets) for v in data]
    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for k, v in data.items():
            key = str(k)
            if _SECRET_KEYS.search(key) and isinstance(v, str | int) and not isinstance(v, bool) and v != "":
                out[key] = MASK
            else:
                out[key] = mask_for_model(v, secrets=secrets)
        return out
    return data


def mask_error(message: str, *, secrets: tuple[str, ...] = (), limit: int = 200) -> str:
    """Thân lỗi từ máy chủ ngoài (có thể phản chiếu header/tham số): che rồi cắt `limit` ký tự."""
    return _mask_str(message[:4000], secrets)[:limit]  # che TRƯỚC khi cắt — không để nửa token lọt qua regex


__all__ = ["MASK", "mask_error", "mask_for_model"]
