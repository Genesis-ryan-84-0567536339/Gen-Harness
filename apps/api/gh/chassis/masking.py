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
_SECRET_PREFIXED = (
    r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{8,}"
    r"|\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|xox[abprs]|glpat|AIza|ya29|ghh|gha)[-_.][A-Za-z0-9._-]{8,}"
    r"|\bAIza[A-Za-z0-9_-]{20,}")
_RE_SECRET = re.compile(_SECRET_PREFIXED + r"|\b[A-Za-z0-9_-]{40,}\b")
# v0.1.49 (QD-16): id kỹ thuật (Gmail/sự kiện lịch/tệp Drive…) dưới khoá `keep_keys` được giữ nguyên — chỉ khi toàn
# chuỗi là ký tự id thường gặp, không có '@' (calendarId dạng email vẫn che) và không giống khoá/token có tiền tố.
# (Chuỗi dài ≥ 40 ký tự KHÔNG bị loại: id tệp Drive dài 33–44 ký tự.)
_RE_KEEP_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_RE_SECRET_PREFIXED = re.compile(_SECRET_PREFIXED)
_SECRET_KEYS = re.compile(
    r"(?i)(?:^|[_\s-])(?:password|passwd|mat_?khau|mật khẩu|secret|token|api_?key|pin)(?:$|[_\s-])")
MASK = "[đã che]"

# F123 (v0.1.62): mã/mật khẩu ngắn đứng cạnh từ khoá trong thư (hình dạng chuỗi không lộ ra, chỉ ngữ cảnh mới lộ).
# Từ khoá mã dùng một lần (có/không dấu, vi/en) và từ đệm thường gặp giữa từ khoá với mã ("của bạn là", "is", ":").
_OTP_WORDS = (r"(?:m[ãa] (?:x[áa]c (?:minh|th[ựu]c|nh[ậa]n)|b[ảa]o m[ậa]t|đ[ăa]ng nh[ậa]p|m[ộo]t l[ầa]n|otp|pin)"
              r"|otp|passcode|pin|code|(?:verification|security|confirmation|login|sign-in|auth(?:entication)?|"
              r"one-time|access|reset) (?:code|pin|passcode)|m[ậa]t kh[ẩa]u|password)")
_FILLER = (r"(?:(?:c[ủu]a|b[ạa]n|anh/ch[ịi]|anh|ch[ịi]|em|qu[ýy] kh[áa]ch|l[àa]|is|are|your|the|n[àa]y|"
           r"t[ạa]m(?: th[ờo]i)?|m[ớo]i|sau|sau đ[âa]y|như sau|one-time|temporary|new|for|to|use|with)\b[\s,]*"
           r"|[:=\-–—]\s*)*")
_CODE = r"(\d{4,8}|\d{3}[ -]\d{3})(?![\d@])"
_RE_OTP_AFTER = re.compile(rf"(?i)(?<![\w-])({_OTP_WORDS})\b[\s]*{_FILLER}{_CODE}")
_RE_OTP_BEFORE = re.compile(
    rf"(?i)(?<![\w])((?:[A-Z]{{1,3}}-)?)(\d{{4,8}})(?![\d@])"
    rf"(?=\s+(?:l[àa]|is)\s+(?:(?:your|the|m[ãa]|\w+) ){{0,2}}{_OTP_WORDS}\b)")
# Mật khẩu có chữ: giá trị đứng ngay sau dấu ':'/'=' (che mọi giá trị), hoặc sau "là/is" (chỉ khi có chữ số hoặc ký tự
# đặc biệt — tránh che "mật khẩu của bạn là bắt buộc").
_PW_WORDS = r"(?:m[ậa]t kh[ẩa]u|passcode|password|passwd)"
_PW_FILLER = (r"(?:(?:c[ủu]a|b[ạa]n|anh/ch[ịi]|anh|ch[ịi]|em|qu[ýy] kh[áa]ch|your|the|t[ạa]m(?: th[ờo]i)?|m[ớo]i|"
              r"temporary|new|one-time|initial|default|m[ặa]c đ[ịi]nh|ban đ[ầa]u)\b\s*)*")
_RE_PW_EXPLICIT = re.compile(rf"(?i)(?<![\w-])({_PW_WORDS}\b\s*{_PW_FILLER}\s*[:=]\s*)([^\s\"'<>]{{4,128}})")
_RE_PW_IS = re.compile(rf"(?i)(?<![\w-])({_PW_WORDS}\b\s*{_PW_FILLER}(?:l[àa]|is)\s+)([^\s\"'<>]{{4,128}})")
# Tham số bí mật trong URL (?token=…, &code=…) và đường dẫn đặt lại/xác minh có mã dài.
_RE_URL_PARAM = re.compile(
    r"(?i)([?&;](?:access_?token|refresh_?token|id_?token|reset_?token|auth_?token|token|code|otp|key|api_?key|apikey|"
    r"auth|sig|signature|secret|password|passwd|pwd|verification_?code)=)([^&\s#\"'<>)\]]+)")
_RE_URL_PATH = re.compile(
    r"(?i)(/(?:reset|verify|confirm|activate|magic|invite|unsubscribe|recover)[\w-]*/)([A-Za-z0-9_.~-]{16,})")


def is_secret_key(key: str) -> bool:
    """Tên khoá kiểu mật khẩu/token/api_key/pin — giá trị dưới khoá này bị thay hẳn bằng MASK (kể cả ngắn hay số)."""
    return _SECRET_KEYS.search(key) is not None


def _mask_pw_value(m: re.Match[str], *, need_mark: bool) -> str:
    value = m.group(2)
    tail = ""
    while value and value[-1] in ".,;!?)":
        value, tail = value[:-1], value[-1] + tail
    if len(value) < 4 or (need_mark and not any(not c.isalpha() for c in value)):
        return m.group(0)
    return m.group(1) + MASK + tail


def _mask_context_secrets(s: str) -> str:
    """F123: mã OTP/mật khẩu cạnh từ khoá và tham số bí mật trong URL — ngữ cảnh mới lộ, hình dạng chuỗi thì không."""
    s = _RE_URL_PARAM.sub(lambda m: m.group(1) + MASK, s)
    s = _RE_URL_PATH.sub(lambda m: m.group(1) + MASK, s)
    s = _RE_PW_EXPLICIT.sub(lambda m: _mask_pw_value(m, need_mark=False), s)
    s = _RE_PW_IS.sub(lambda m: _mask_pw_value(m, need_mark=True), s)
    s = _RE_OTP_AFTER.sub(lambda m: m.group(0)[: m.start(2) - m.start(0)] + MASK, s)
    return _RE_OTP_BEFORE.sub(lambda m: m.group(1) + MASK, s)


def _mask_str(s: str, extra: tuple[str, ...]) -> str:
    for secret in extra:
        if secret:
            s = s.replace(secret, MASK)
    s = _mask_context_secrets(s)
    s = _RE_SECRET.sub(MASK, s)
    s = _RE_EMAIL.sub(lambda m: f"{m.group(1)}•••@{m.group(2)}", s)

    def num(m: re.Match[str]) -> str:
        whole = m.group(1)
        if _RE_DATE.fullmatch(whole.strip()):
            return whole  # ngày tháng không phải dữ liệu nhạy cảm — Kho dùng rất nhiều
        return mask_text(whole, False) or whole

    return _RE_LONGNUM.sub(num, s)


def _keep_id(value: str, secrets: tuple[str, ...]) -> bool:
    """Giá trị dưới khoá `keep_keys` có được giữ nguyên không (id Gmail/sự kiện/tệp có thể chứa ≥ 8 chữ số liền —
    regex số dài sẽ phá id)? Chỉ khi là id thuần, không '@', không chứa token của liên kết, không giống khoá/token."""
    if "@" in value or not _RE_KEEP_ID.fullmatch(value) or _RE_SECRET_PREFIXED.search(value):
        return False
    return not any(secret and secret in value for secret in secrets)


def mask_for_model(data: Any, *, secrets: tuple[str, ...] = (), keep_keys: frozenset[str] = frozenset()) -> Any:
    """Che đệ quy mọi chuỗi: số dài ≥ 8 chữ số (tài khoản, thẻ, SĐT — trừ ngày), email, khoá/token; giá trị của
    khoá có tên kiểu mật khẩu/token bị thay hẳn. `secrets` = chuỗi phải xoá tuyệt đối (token của chính liên kết).

    `keep_keys` (v0.1.49, mặc định rỗng = hành vi cũ): giá trị CHUỖI dưới các khoá này (vd `id`, `messageId`) giữ
    nguyên khi là id thuần (`^[A-Za-z0-9_.:-]{1,128}$`, không '@'); không khớp thì vẫn che như thường. Truyền đệ quy."""
    if isinstance(data, str):
        return _mask_str(data, secrets)
    if isinstance(data, list):
        return [mask_for_model(v, secrets=secrets, keep_keys=keep_keys) for v in data]
    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for k, v in data.items():
            key = str(k)
            if is_secret_key(key) and isinstance(v, str | int) and not isinstance(v, bool) and v != "":
                out[key] = MASK
            elif key in keep_keys and isinstance(v, str) and _keep_id(v, secrets):
                out[key] = v
            else:
                out[key] = mask_for_model(v, secrets=secrets, keep_keys=keep_keys)
        return out
    return data


def mask_error(message: str, *, secrets: tuple[str, ...] = (), limit: int = 200) -> str:
    """Thân lỗi từ máy chủ ngoài (có thể phản chiếu header/tham số): che rồi cắt `limit` ký tự."""
    return _mask_str(message[:4000], secrets)[:limit]  # che TRƯỚC khi cắt — không để nửa token lọt qua regex


__all__ = ["MASK", "mask_error", "mask_for_model"]
