"""Facebook cá nhân — CHỈ ĐỌC: nhận biết trạng thái trang, đọc thông báo và danh sách hội thoại (xem trước tin mới
nhất). Trích VĂN BẢN CÓ CẤU TRÚC bằng quy tắc cố định (không đưa HTML thô ra ngoài, model không bao giờ chọn selector).

THÀNH THẬT: bộ chọn dưới đây dựa trên dấu hiệu tương đối bền của facebook.com (cookie `c_user` khi đã đăng nhập, đường
dẫn `/checkpoint/`, link thông báo có `notif_id=`/`notif_t=`, link hội thoại `/messages/t/<id>`, vai trò ARIA) và được
kiểm trên TRANG MẪU lưu sẵn (tests/fixtures) — CHƯA kiểm trên Facebook thật. Giao diện đổi → việc báo lỗi `SELECTOR`
rõ ràng thay vì đoán; Owner nghiệm thu bằng một lần đăng nhập + đọc thật.

KHÔNG có: đăng, trả lời, nhắn, thích, kết bạn (v0.1.30 — qua đề xuất + permit); không lách chống bot; gặp checkpoint /
CAPTCHA thì trả trạng thái để worker DỪNG, không vượt.
"""

import re
from typing import Any

from ghb.adapters.base import Adapter, PageState

HOME = "https://www.facebook.com/"
NOTIFICATIONS = "https://www.facebook.com/notifications"
INBOX = "https://www.facebook.com/messages/t/"

TIME_RE = re.compile(r"^(vừa xong|just now|\d+\s*(giây|phút|giờ|ngày|tuần|năm|s|m|h|d|w|y|min|mins|hr|hrs)\b.*|"
                     r"hôm qua|yesterday|thứ .+|(mon|tue|wed|thu|fri|sat|sun)\w*)$", re.IGNORECASE)

# Trích trong trang — chỉ đọc DOM, không bấm, không gõ gì.
NOTIF_JS = """(max) => {
  const root = document.querySelector('[role="main"]') || document.body;
  const links = Array.from(root.querySelectorAll('a[href*="notif_id="], a[href*="notif_t="]'));
  const seen = new Set(); const out = [];
  for (const a of links) {
    const row = a.closest('[role="row"], [role="listitem"], [role="article"]') || a;
    const text = (row.innerText || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const label = (row.getAttribute('aria-label') || '') + ' ' +
      Array.from(row.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')).join(' ');
    out.push({ text, href: a.href, unread: /unread|chưa đọc/i.test(label) });
    if (out.length >= max) break;
  }
  return out;
}"""

INBOX_JS = """(max) => {
  const lists = Array.from(document.querySelectorAll(
    '[role="navigation"] [role="grid"], [aria-label="Chats"], [aria-label="Đoạn chat"], [role="navigation"]'));
  const root = lists[0] || document.body;
  const links = Array.from(root.querySelectorAll('a[href*="/messages/t/"]'));
  const seen = new Set(); const out = [];
  for (const a of links) {
    const href = a.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const row = a.closest('[role="row"], [role="listitem"], [role="gridcell"]') || a;
    const text = (row.innerText || '').trim();
    if (!text) continue;
    const label = (row.getAttribute('aria-label') || '') + ' ' +
      Array.from(row.querySelectorAll('[aria-label]')).map((e) => e.getAttribute('aria-label')).join(' ');
    out.push({ text, href, unread: /unread|chưa đọc/i.test(label) });
    if (out.length >= max) break;
  }
  return out;
}"""

CAPTCHA_SELECTORS = ('iframe[src*="recaptcha"]', 'iframe[src*="captcha"]', 'iframe[title*="captcha" i]',
                     '#captcha', '[id*="captcha" i]')


def _lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip() and ln.strip() not in ("·", "•")]


def split_time(lines: list[str]) -> tuple[list[str], str | None]:
    if lines and TIME_RE.match(lines[-1]):
        return lines[:-1], lines[-1]
    return lines, None


def parse_notification(raw: dict[str, Any]) -> dict[str, Any] | None:
    lines, when = split_time(_lines(str(raw.get("text") or "")))
    lines = [ln for ln in lines if not re.fullmatch(r"(unread|chưa đọc|đánh dấu là đã đọc|mark as read)", ln, re.I)]
    if not lines:
        return None
    return {"kind": "notification", "who": None, "text": " ".join(lines), "time": when,
            "unread": bool(raw.get("unread")), "link": raw.get("href")}


def parse_conversation(raw: dict[str, Any]) -> dict[str, Any] | None:
    lines, when = split_time(_lines(str(raw.get("text") or "")))
    lines = [ln for ln in lines if not re.fullmatch(r"(unread|chưa đọc|đang hoạt động|active now)", ln, re.I)]
    if not lines:
        return None
    who, rest = lines[0], lines[1:]
    # Dòng xem trước dạng "Bạn: …" / "You: …" = tin mình gửi cuối cùng.
    return {"kind": "inbox", "who": who, "text": " ".join(rest) or "(chưa có tin)", "time": when,
            "unread": bool(raw.get("unread")), "link": raw.get("href")}


class FacebookAdapter(Adapter):
    key = "facebook_personal"
    home = HOME

    async def page_state(self, page: Any, context: Any) -> PageState:
        url = (page.url or "").lower()
        if "/checkpoint" in url or "two_step_verification" in url:
            return "checkpoint"
        if await page.query_selector('form[action*="/checkpoint"]'):
            return "checkpoint"
        if "captcha" in url:
            return "captcha"
        for sel in CAPTCHA_SELECTORS:
            if await page.query_selector(sel):
                return "captcha"
        cookies = await context.cookies("https://www.facebook.com")
        if not any(c.get("name") == "c_user" and c.get("value") for c in cookies):
            return "need_login"
        if "/login" in url:
            return "need_login"
        return "ok"

    async def handle(self, page: Any, context: Any) -> str | None:
        return None      # tên hiển thị: không đoán từ DOM (dễ sai) — Owner đặt nhãn tài khoản

    async def read(self, page: Any, what: str, max_items: int) -> list[dict[str, Any]]:
        if what == "notifications":
            await page.goto(NOTIFICATIONS, wait_until="domcontentloaded")
            await page.wait_for_selector('a[href*="notif_id="], a[href*="notif_t="], [role="main"]', timeout=15_000)
            raws = await page.evaluate(NOTIF_JS, max_items)
            parse = parse_notification
        elif what == "inbox":
            await page.goto(INBOX, wait_until="domcontentloaded")
            await page.wait_for_selector('a[href*="/messages/t/"], [role="navigation"]', timeout=15_000)
            raws = await page.evaluate(INBOX_JS, max_items)
            parse = parse_conversation
        else:
            raise ValueError(f"không đọc được mục {what}")
        return [x for x in (parse(r) for r in raws if isinstance(r, dict)) if x is not None]
