"""CHỖ CẮM v0.1.30 — thao tác GHI trên mạng xã hội (đăng bài, trả lời bình luận, nhắn tin). CHƯA BẬT ở v0.1.29.

Thiết kế (docs/design/gen-browser-agent.md §3.5), làm ở v0.1.30:
1. Gen trả `{"kind":"propose","proposal":{"type":"social_post|social_reply|social_dm", …}}` →
   `gh/gen/proposals.py` thêm các loại này; mục tiêu `social.accounts` đánh dấu nhạy cảm → luôn cần PIN.
2. Owner Xác nhận/Sửa/Huỷ trên thẻ đề xuất (nội dung nguyên văn, tài khoản nào, gửi cho ai/bài nào).
3. Xác nhận → `issue()` ký permit bằng khoá browser: `{nonce, account_id, action, target_url_hash, body_sha256, exp}`;
   worker chỉ ghi khi chữ ký đúng, chưa hết hạn, nội dung khớp hash, nonce dùng một lần. Không permit = không ghi,
   kể cả khi model bị lừa.
4. Action Log `social.write` (kết quả + ảnh chụp sau khi gửi).

Hiện tại mọi lời gọi đều bị từ chối — không có đường nào để Gen hay worker ghi lên mạng xã hội ở bản này.
"""

from typing import Any

WRITE_ACTIONS = ("post", "reply", "dm")          # v0.1.30
PROPOSAL_TYPES = ("social_post", "social_reply", "social_dm")


class WriteNotEnabled(RuntimeError):
    """Ghi lên mạng xã hội chưa có ở v0.1.29."""


def issue(**_claims: Any) -> str:
    raise WriteNotEnabled("Ghi lên mạng xã hội (đăng/trả lời/nhắn) chưa có ở bản này — dự kiến v0.1.30 qua đề xuất + "
                          "Xác nhận + PIN")
