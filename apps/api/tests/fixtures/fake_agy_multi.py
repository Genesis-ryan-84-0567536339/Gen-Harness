"""CLI giả nhiều tài khoản Google (đổi tài khoản — v0.1.30), cùng hành vi terminal với fake_agy.py.

- `agy` (tương tác): nếu tệp phiên đã có (ĐÃ đăng nhập) thì vào thẳng màn hình chat như CLI thật — KHÔNG hiện menu
  đăng nhập, KHÔNG in link — và ghi lại tệp phiên (CLI làm mới token). Chưa có tệp phiên: menu → link → đọc mã
  `4/<tên>` → ghi tệp phiên của `<tên>@example.vn`.
- `agy -p …` (headless, như AgyClient gọi): trả JSON `{"response": "whoami:<email>"}` theo tệp phiên hiện tại.
- `agy whoami`: in email đang đăng nhập (chỉ để test đọc nhanh).
"""

import base64
import json
import os
import select
import sys
import termios
import tty
from pathlib import Path

URL = "https://accounts.google.com/o/oauth2/auth?client_id=agy&state=MULTI"
TOKEN = Path(os.environ["HOME"]) / ".gemini" / "antigravity-cli" / "antigravity-oauth-token"


def email_of() -> str | None:
    try:
        data = json.loads(TOKEN.read_text())
        part = data["id_token"].split(".")[1]
        return str(json.loads(base64.urlsafe_b64decode(part + "=" * (-len(part) % 4)))["email"])
    except (OSError, ValueError, KeyError, IndexError):
        return None


if sys.argv[1:2] == ["whoami"]:
    print(email_of() or "not signed in")
    sys.exit(0)
if sys.argv[1:2] == ["-p"]:
    who = email_of()
    if who is None:
        print(json.dumps({"error": "Not authenticated: please login"}))
        sys.exit(1)
    print(json.dumps({"response": f"whoami:{who}", "usage": {"input_tokens": 1, "output_tokens": 1}}))
    sys.exit(0)


def out(s: str) -> None:
    os.write(1, s.encode())


def read_until(pred, timeout: float) -> bytes:  # type: ignore[no-untyped-def]
    data = b""
    while not pred(data):
        r, _, _ = select.select([0], [], [], timeout)
        if not r:
            sys.exit(3)
        data += os.read(0, 1024)
    return data


tty.setraw(0)
out("\x1b[>c\x1b[c")
read_until(lambda d: b"c" in d and b"\x1b[?" in d, 5)
who = email_of()
if who is not None:
    # Đã đăng nhập: CLI thật vào thẳng chat, làm mới token (ghi lại tệp) và chờ người dùng gõ — không có link.
    TOKEN.write_text(TOKEN.read_text())
    out(f"Signed in as {who}\r\n> Type your message\r\n")
    select.select([0], [], [], 60)
    sys.exit(0)
out("Welcome to the Antigravity CLI. You are currently not signed in.\r\nSelect login method:\r\n"
    " > 1. Google OAuth\r\n2. Use a Google Cloud project\r\n")
read_until(lambda d: b"\r" in d, 10)
out(f"\x1b]8;;{URL}\x1b\\Click here to authenticate\x1b]8;;\x1b\\\r\nPaste the code below:\r\n")
code = read_until(lambda d: b"\r" in d, 30).split(b"\r")[0].decode().strip()
name = code.split("/", 1)[-1] or "boss"
claims = base64.urlsafe_b64encode(json.dumps({"email": f"{name}@example.vn"}).encode()).decode().rstrip("=")
TOKEN.parent.mkdir(parents=True, exist_ok=True)
TOKEN.write_text(json.dumps({"access_token": f"tok-{name}", "id_token": f"h.{claims}.s", "expiry": 4102444800}))
out("Signed in.\r\n")
termios.tcflush(0, termios.TCIFLUSH)
select.select([0], [], [], 30)
