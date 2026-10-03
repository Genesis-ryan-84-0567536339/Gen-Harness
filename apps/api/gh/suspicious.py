"""Mẫu chữ đáng ngờ dùng chung (v0.1.45, F-60).

- `SUSPICIOUS`: chữ thường gặp trong lừa đảo/tấn công prompt trên trang mạng xã hội (chuyển từ gh.social.service —
  hành vi không đổi). Chỉ để gắn cờ, nội dung vẫn là dữ liệu.
- `REVIEW_MANIPULATION`: câu lệnh cho AI hoặc xin điểm mà nhân viên có thể chèn vào tin nhắn để lách điểm đánh giá
  nhân sự. Job tính điểm chỉ GẮN CỜ 'Đáng ngờ' — không đổi điểm, không kỷ luật tự động (khoá cứng 2).
"""

import re
from collections.abc import Iterable

SUSPICIOUS = re.compile(
    r"(bỏ qua (mọi |các )?(chỉ dẫn|hướng dẫn|lệnh)|ignore (all |previous |the above )?instructions|system prompt|"
    r"mã (otp|xác (minh|nhận))|\botp\b|chuyển (tiền|khoản)|mật khẩu|password|gửi (mã|tiền)|click (vào )?link)",
    re.IGNORECASE)

REVIEW_MANIPULATION = re.compile(
    r"(bỏ qua (mọi |các |tất cả )?(chỉ dẫn|hướng dẫn|lệnh)"
    r"|ignore (all |previous |the above |all previous )?(instructions|prompts?)"
    r"|system prompt|prompt hệ thống"
    r"|(chấm|cho|đánh giá) (tôi |em |mình |anh |chị )?(điểm )?(tôi |em |mình )?(cao|tốt|tối đa|10|100)\b"
    r"|rate me|give (me )?(a )?(high|perfect|full|10|100) (score|rating)"
    r"|bạn là (một )?(ai|trợ lý)\b|you are (an? )?(ai|assistant|language model))",
    re.IGNORECASE)

SNIPPET_MAX = 60


def scan_texts(texts: Iterable[str | None], pattern: re.Pattern[str] = REVIEW_MANIPULATION) -> tuple[int, str | None]:
    """Đếm số tin khớp mẫu + đoạn khớp ĐẦU TIÊN (cắt ≤ 60 ký tự). Không bao giờ trả cả tin nhắn."""
    hits, first = 0, None
    for t in texts:
        if not t:
            continue
        m = pattern.search(t)
        if m is None:
            continue
        hits += 1
        if first is None:
            first = " ".join(m.group(0).split())[:SNIPPET_MAX]
    return hits, first
