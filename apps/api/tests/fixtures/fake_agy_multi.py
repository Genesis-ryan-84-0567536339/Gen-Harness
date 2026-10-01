"""CLI giả nhiều tài khoản Google (đổi tài khoản — v0.1.30), cùng hành vi terminal với fake_agy.py.

- `agy` (tương tác): nếu tệp phiên đã có (ĐÃ đăng nhập) thì vào thẳng màn hình chat như CLI thật — KHÔNG hiện menu
  đăng nhập, KHÔNG in link — và ghi lại tệp phiên (CLI làm mới token). Chưa có tệp phiên: menu → link → đọc mã
  `4/<tên>` → ghi tệp phiên của `<tên>@example.vn`.
- `agy -p …` (headless, như AgyClient gọi): trả JSON `{"response": "whoami:<email>"}` theo tệp phiên hiện tại.
- `agy whoami`: in email đang đăng nhập (chỉ để test đọc nhanh).
- `agy models` (v0.1.31): chưa đăng nhập → đúng câu lỗi của agy 1.2.9 thật, thoát 1; đã đăng nhập → danh sách.
- v0.1.32: `-p --model <gốc> --effort <mức>` như agy 1.2.9 thật (xem VARIANTS); ghi mỗi lượt vào $HOME/agy-calls.log.
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
# v0.1.32 — mô phỏng agy 1.2.9 THẬT (đo 2026-10-01): `--model` nhận model GỐC, `--effort low|medium|high` chọn biến thể
# (changelog: "Added an `--effort` flag to select a model's reasoning-effort variant"); tên biến thể làm `--model` bị từ
# chối với đúng mẫu lỗi trong tệp chạy ("invalid model selection (--model %q --effort %q): …", "Invalid model %q
# (available: %s)", "invalid --effort %q (valid: %s)"). Định dạng `agy models` khi đã đăng nhập CHƯA đo được → giả định
# một biến thể mỗi dòng (theo hướng dẫn công khai) + tên hiển thị.
VARIANTS = {"gemini-3.8-flash": ["low", "medium", "high"], "gemini-3.1-pro": ["low", "high"],
            "claude-sonnet-4-6-thinking": []}
LEGACY_OK = {"gemini-2.5-pro"}   # test cũ (đổi tài khoản) gọi model này
CALLS = Path(os.environ["HOME"]) / "agy-calls.log"
FLAGS = {"--model", "--effort", "--output-format", "-p", "--print", "--prompt", "--print-timeout"}
if sys.argv[1:2] == ["--version"]:
    print("1.2.9")
    sys.exit(0)
if sys.argv[1:2] == ["models"]:
    print("Fetching available models...")
    if email_of() is None:
        print("Error: Please sign in to view available models. Launch the CLI without arguments to sign in.")
        sys.exit(1)
    print("Available models:")
    for base, effs in VARIANTS.items():
        for e in effs or [""]:
            slug = f"{base}-{e}" if e else base
            mark = " (current)" if slug == "gemini-3.8-flash-high" else ""
            print(f"  {slug}{mark}")
    sys.exit(0)
if sys.argv[1:2] == ["-p"]:
    who = email_of()
    if who is None:
        print(json.dumps({"error": "Not authenticated: please login"}))
        sys.exit(1)
    for a in sys.argv[3:]:
        if a.startswith("-") and a not in FLAGS:
            print(f"Error: flags provided but not defined: {a.lstrip('-')}", file=sys.stderr)
            sys.exit(2)
    model = sys.argv[sys.argv.index("--model") + 1] if "--model" in sys.argv else ""
    effort = sys.argv[sys.argv.index("--effort") + 1] if "--effort" in sys.argv else ""
    # agy 1.2.9 (changelog 1.1.11): `-p "/model"`, `-p "/effort"` in một bản ghi tab-separated mỗi dòng, không tốn lượt.
    # Định dạng cột chưa đo được khi đã đăng nhập → giả định.
    if sys.argv[2] == "/model":
        for base, effs in VARIANTS.items():
            print("\t".join([base, ",".join(effs), "current" if base == "gemini-3.8-flash" else ""]))
        sys.exit(0)
    if sys.argv[2] == "/effort":
        effs = VARIANTS.get(model or "gemini-3.8-flash", [])
        for e in effs:
            print("\t".join([e, "current" if e == "high" else ""]))
        sys.exit(0)
    with CALLS.open("a") as fh:
        fh.write(json.dumps({"model": model, "effort": effort}) + "\n")
    err = None
    if effort and effort not in ("low", "medium", "high"):
        err = f'invalid --effort "{effort}" (valid: low, medium, high)'
    elif model and model not in VARIANTS and model not in LEGACY_OK:
        err = (f'invalid model selection (--model "{model}" --effort "{effort}"): Invalid model "{model}" '
               f'(available: {", ".join(VARIANTS)})')
    elif model in VARIANTS and effort and effort not in VARIANTS[model]:
        err = (f'invalid model selection (--model "{model}" --effort "{effort}"): invalid --effort "{effort}" '
               f'(valid: {", ".join(VARIANTS[model])})')
    if err:
        print(json.dumps({"conversation_id": "", "status": "ERROR", "response": "", "error": err}))
        print("AGY_ERROR: " + json.dumps({"status": "INVALID_ARGUMENT", "message": err}), file=sys.stderr)
        sys.exit(3)
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
