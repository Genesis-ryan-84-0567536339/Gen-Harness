"""CLI giả mô phỏng Antigravity CLI 1.2.9 đo thật trên pty (test_cli_login.py):
hỏi terminal (DA) và CHỜ trả lời trước khi vẽ; link dài bị ngắt dòng, bản đầy đủ nằm trong hyperlink OSC 8;
đọc mã xác thực rồi ghi tệp phiên."""

import base64
import json
import os
import select
import sys
import termios
import tty
from pathlib import Path

URL = "https://accounts.google.com/o/oauth2/auth?" + "&".join(f"p{i}=" + "x" * 40 for i in range(15)) + "&state=END"


def out(s: str) -> None:
    os.write(1, s.encode())


def read_until(pred, timeout: float) -> bytes:
    data = b""
    while not pred(data):
        r, _, _ = select.select([0], [], [], timeout)
        if not r:
            sys.exit(3)  # không ai trả lời: CLI thật treo; ở đây thoát để test thấy lỗi nhanh
        data += os.read(0, 1024)
    return data


tty.setraw(0)
out("\x1b[>c\x1b_Ga=q,f=32,s=1,v=1,i=31;AAAAAA==\x1b\\\x1b[c")
read_until(lambda d: b"c" in d and b"\x1b[?" in d, 5)
out(
    "Welcome to the Antigravity CLI. You are currently not signed in.\r\nSelect login method:\r\n"
    " > 1. Google OAuth\r\n2. Use a Google Cloud project\r\n"
)
read_until(lambda d: b"\r" in d, 10)
wrapped = "\r\n".join(URL[i : i + 200] for i in range(0, len(URL), 200))
out(
    f"Open the URL below in your browser:\r\n{wrapped}\r\n"
    f"\x1b]8;;{URL}\x1b\\Click here to authenticate\x1b]8;;\x1b\\\r\n"
    "After authenticating, copy the code displayed in the browser and paste it below:\r\n"
)
code = read_until(lambda d: b"\r" in d, 30).split(b"\r")[0].decode().strip()
claims = base64.urlsafe_b64encode(json.dumps({"email": "boss@example.vn"}).encode()).decode().rstrip("=")
home = Path(os.environ["HOME"]) / ".gemini" / "antigravity-cli"
home.mkdir(parents=True, exist_ok=True)
(home / "antigravity-oauth-token").write_text(
    json.dumps({"access_token": f"tok-{code}", "id_token": f"h.{claims}.s", "expiry": 4102444800})
)
out("Signed in.\r\n")
termios.tcflush(0, termios.TCIFLUSH)
select.select([0], [], [], 30)
