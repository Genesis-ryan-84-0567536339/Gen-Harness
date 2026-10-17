"""v0.1.71 — Nhật ký lắng nghe: raw.events.listen_mode (chế độ nghe lúc tin vào) + ops.listen_events (sự kiện kênh).
Chạy lại an toàn (IF NOT EXISTS). Chuỗi migration: `down_revision = "0039"` — bản 0040 (nhánh khác) do người xếp
thứ tự nối lại sau; chỉ cần đổi `down_revision` khi xếp.

Revision ID: 0041
Revises: 0039
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sqlfile import run_file  # noqa: E402

revision = "0041"
down_revision = "0039"
branch_labels = None
depends_on = None


def upgrade() -> None:
    run_file("0041_v0171_nhat_ky_lang_nghe.sql")


def downgrade() -> None:
    pass  # chỉ thêm cột NULL và bảng mới; hạ cấp = khôi phục bản sao lưu
