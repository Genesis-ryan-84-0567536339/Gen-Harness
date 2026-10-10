#!/usr/bin/env python3
"""Kiểm tĩnh v0.1.56: mã GIAO cho Owner khác không được mang địa chỉ Gen-hub / tên riêng của chủ Gen-hub.

Repo công khai và mọi bản phát hành (web bundle, ảnh API, genh, install, compose, db) đi tới Owner khác. Địa chỉ
Gen-hub của Sếp và các tên riêng dưới đây không được xuất hiện trong những thứ đó (chỉ dùng chỗ giữ chỗ chung, vd
`https://<địa-chỉ-gen-hub-của-bạn>/mcp`, và tên Kho chung "Kho dữ liệu").

Phạm vi quét (tệp văn bản đã theo dõi bởi git; không có git thì duyệt thư mục): `apps/web/src`, `apps/api/gh`,
`packages/contracts/src`, `apps/genh` (trừ `*_test.go`), `install.sh`, `install.ps1`, `deploy`, `db/sql`.
KHÔNG quét test / mock / e2e / docs (đó là việc của người viết, không giao cho Owner).

Mẫu cấm (không phân biệt hoa thường): `genos.top`, `Kho Ryan`, `cola.mkt`, `Cơ La`, `ryan.genesis` (dấu . _ tuỳ chọn),
`boss.ryan`. Cho phép: chuỗi tổ chức GitHub phát hành `Genesis-ryan-84-0567536339` (cần để tải bản phát hành) và dòng có
chú thích `allow-personal-info` (chỉ dùng khi thật sự cần, vd câu SQL khớp ghi chú cũ đã lưu trong DB).

Cách chạy: `python3 .github/scripts/check_no_personal_info.py [root]` — in `tệp:dòng` + dòng `::error file=…,line=…::`
cho GitHub Actions, exit 1 nếu có vi phạm, 0 nếu sạch, 2 nếu không thấy thư mục gốc.
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
#: Thư mục (tiền tố) và tệp đơn nằm trong phạm vi quét, tính từ gốc repo.
SCOPE_DIRS = ("apps/web/src/", "apps/api/gh/", "packages/contracts/src/", "apps/genh/", "deploy/", "db/sql/")
SCOPE_FILES = ("install.sh", "install.ps1")
SKIP_PARTS = frozenset({"node_modules", ".git", "__pycache__", "dist"})
MAX_BYTES = 2_000_000

# Mẫu cấm (không phân biệt hoa thường).
FORBIDDEN = (
    re.compile(r"genos\.top", re.IGNORECASE),
    re.compile(r"Kho Ryan", re.IGNORECASE),
    re.compile(r"cola\.mkt", re.IGNORECASE),
    re.compile(r"Cơ La", re.IGNORECASE),
    re.compile(r"ryan[._]?genesis", re.IGNORECASE),
    re.compile(r"boss\.ryan", re.IGNORECASE),
)
ALLOW_MARK = "allow-personal-info"
#: Chuỗi cho phép duy nhất: tổ chức GitHub chứa bản phát hành (install / genh / config tải bản về).
ALLOWED_STRINGS = ("Genesis-ryan-84-0567536339",)


def in_scope(rel: str) -> bool:
    if rel.endswith("_test.go"):
        return False
    if any(part in SKIP_PARTS for part in rel.split("/")):
        return False
    return rel in SCOPE_FILES or rel.startswith(SCOPE_DIRS)


def _git_files(root: Path) -> list[str] | None:
    """Danh sách tệp git theo dõi dưới `root`; None nếu `root` không phải kho git (ví dụ thư mục tạm của test)."""
    if not (root / ".git").exists():
        return None
    try:
        out = subprocess.run(["git", "ls-files", "-z"], cwd=root, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return None
    return sorted(p for p in out.decode("utf-8", errors="replace").split("\0") if p)


def candidate_files(root: Path) -> list[str]:
    files = _git_files(root)
    if files is None:
        files = sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file())
    return [f for f in files if in_scope(f)]


def scrub(line: str) -> str:
    for allowed in ALLOWED_STRINGS:
        line = line.replace(allowed, "")
    return line


def violations(root: Path) -> Iterator[tuple[str, int, str, str]]:
    """(đường dẫn tương đối, số dòng, nội dung dòng, mẫu khớp) cho từng dòng vi phạm."""
    for rel in candidate_files(root):
        path = root / rel
        try:
            if not path.is_file() or path.stat().st_size > MAX_BYTES:
                continue
            text = path.read_bytes().decode("utf-8")      # tệp nhị phân / không phải UTF-8 thì bỏ qua
        except (OSError, UnicodeDecodeError):
            continue
        for n, line in enumerate(text.splitlines(), start=1):
            if ALLOW_MARK in line:
                continue
            shown = scrub(line)
            for pat in FORBIDDEN:
                if pat.search(shown):
                    yield rel, n, line.strip(), pat.pattern
                    break


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else REPO
    if not root.is_dir():
        print(f"::error::Không thấy thư mục {root}")
        return 2
    found = list(violations(root))
    for rel, n, line, pattern in found:
        print(f"{rel}:{n}: {line[:160]}")
        print(f"::error file={rel},line={n}::Thông tin riêng của Sếp (khớp mẫu {pattern}) trong mã giao cho Owner khác — "
              "dùng chỗ giữ chỗ chung (https://<địa-chỉ-gen-hub-của-bạn>/mcp) và tên Kho chung \"Kho dữ liệu\"")
    if found:
        print(f"Có {len(found)} chỗ lộ thông tin riêng.")
        return 1
    print(f"Sạch: không lộ thông tin riêng trong mã giao cho Owner khác ({root}).")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
