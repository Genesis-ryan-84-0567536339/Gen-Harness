"""Vá rẻ chống đọc bí mật qua /proc (gói G, review 16/10/2026).

Antigravity CLI (`agy`) chạy cùng uid `gh` với api/worker (xem `gh.providers.clients.AgyClient`) nên một agy bị prompt
độc điều khiển đọc được `/proc/1/environ` (biến môi trường của tiến trình api/worker, vd GH_ADMIN_DATABASE_URL) và
`/proc/<pid>/mem`. `prctl(PR_SET_DUMPABLE, 0)` đặt tiến trình "không dump được": nhân Linux đổi chủ các tệp
`/proc/<pid>/*` của nó thành root và từ chối ptrace/đọc `environ`, `mem`, `maps` với tiến trình cùng uid không có
CAP_SYS_PTRACE. Cờ được con cháu `fork` thừa hưởng nhưng `execve` (vd chạy `agy`) đặt lại — agy vẫn chạy bình
thường, chỉ tiến trình api/worker là không bị đọc.

KHÔNG thay cho việc tách agy ra container riêng (bước kế tiếp), chỉ thu hẹp mặt phơi bày: tệp bí mật /run/secrets/gh_*
vẫn do quyền tệp bảo vệ. Chỉ có hiệu lực trên Linux; nền khác hoặc lỗi gọi ⇒ trả False, không ném lỗi.
"""

import ctypes
import logging
import sys

log = logging.getLogger("gh.hardening")

PR_SET_DUMPABLE = 4
PR_GET_DUMPABLE = 3


def set_not_dumpable() -> bool:
    """`prctl(PR_SET_DUMPABLE, 0)`. True khi đã đặt được (Linux); False ở nền khác / khi lệnh gọi lỗi."""
    if not sys.platform.startswith("linux"):
        return False
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        return bool(libc.prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) == 0)
    except (OSError, AttributeError):   # không có libc/prctl (musl lạ, bản dựng tĩnh…) — vá phụ, không chặn khởi động
        log.warning("Không đặt được PR_SET_DUMPABLE=0 (bỏ qua)")
        return False


def is_dumpable() -> bool | None:
    """Trạng thái hiện tại (cho test / chẩn đoán); None khi không đọc được (nền không phải Linux)."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        v = ctypes.CDLL(None, use_errno=True).prctl(PR_GET_DUMPABLE, 0, 0, 0, 0)
    except (OSError, AttributeError):
        return None
    return None if v < 0 else v == 1
