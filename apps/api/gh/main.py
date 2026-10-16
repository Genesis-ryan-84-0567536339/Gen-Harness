"""Điểm vào: `gh-api` (uvicorn)."""

import uvicorn

from gh.hardening import set_not_dumpable

set_not_dumpable()   # gói G: sớm nhất có thể — agy cùng uid không đọc được /proc/1/environ của tiến trình api

from gh.app import configure_logging, create_app  # noqa: E402

configure_logging()
app = create_app()


def run() -> None:
    uvicorn.run("gh.main:app", host="0.0.0.0", port=8000, proxy_headers=True, forwarded_allow_ips="*",  # noqa: S104
                log_config=None)
