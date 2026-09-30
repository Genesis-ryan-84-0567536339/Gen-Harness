"""Giao diện chung của một adapter nền tảng (chỉ đọc ở v0.1.29)."""

from typing import Any, Literal

PageState = Literal["ok", "need_login", "checkpoint", "captcha"]

# Trạng thái trang → mã lỗi báo api (api dừng tài khoản + chuông Owner với checkpoint/captcha).
STATE_ERROR = {"need_login": "LOGGED_OUT", "checkpoint": "CHECKPOINT", "captcha": "CAPTCHA"}


class Adapter:
    key: str = ""
    home: str = ""

    async def page_state(self, page: Any, context: Any) -> PageState:
        raise NotImplementedError

    async def handle(self, page: Any, context: Any) -> str | None:
        return None

    async def read(self, page: Any, what: str, max_items: int) -> list[dict[str, Any]]:
        raise NotImplementedError

    async def write(self, page: Any, action: str, **_: Any) -> None:
        """CHỖ CẮM v0.1.30 (đăng/trả lời/nhắn) — chỉ khi có permit ký bằng khoá browser, nội dung khớp hash, nonce
        dùng một lần. Bản này không có đường ghi nào."""
        raise NotImplementedError("Ghi lên mạng xã hội chưa có ở bản này (v0.1.30 qua đề xuất + permit)")
