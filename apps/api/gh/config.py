"""Cấu hình đọc từ biến môi trường (tiền tố GH_)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GH_", env_file=".env", extra="ignore")

    env: str = "development"
    public_url: str = "https://localhost:8443"
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/gen_harness"
    # URL kết nối superuser — dùng cho migrate, backup (pg_dump/pg_restore), bảo trì/tạo phân vùng theo tháng
    # (partman.run_maintenance) và mọi DDL lúc chạy. Rỗng ⇒ dùng database_url (môi trường dev/test mặc định
    # database_url đã là superuser). Ở triển khai thật, database_url trỏ role gh_app (không superuser, không
    # BYPASSRLS — migration 0014); admin_database_url trỏ role superuser tạo ở trình cài (GH_ADMIN_DATABASE_URL).
    admin_database_url: str = ""
    redis_url: str = "redis://localhost:6379/0"
    # 32 byte base64. Trống ở môi trường dev/test → sinh tạm (không dùng cho production).
    master_key: str = ""
    master_key_file: str = ""       # Docker secret (vd. /run/secrets/gh_master_key) — ưu tiên hơn biến môi trường
    setup_token: str = ""
    # Khoá bridge (32 byte base64): ký permit gửi tin và mã hoá phiên kênh khi truyền (docs/api/bridge-protocol.md)
    bridge_key: str = ""
    bridge_key_file: str = ""
    # Khoá RIÊNG cho backup CSDL (32 byte, dạng HEX 64 ký tự — khác `master_key` vốn là base64, xem hợp đồng
    # với genh ở docs/reports/HANDOFF-v0.1.2.md): backup MỚI mã hoá bằng khoá này khi có cấu hình, tách biệt
    # với bí mật ứng dụng (`master_key`) — mất một khoá không kéo theo mất khoá kia. Trống ⇒ giữ hành vi cũ
    # (mã hoá backup bằng `master_key`, xem `gh/backup.py::_backup_encryption_key`).
    backup_key: str = ""
    # Thư mục cấu hình của Antigravity CLI (tệp OAuth token); worker ghi hồ sơ đang hoạt động vào đây
    cli_home: str = "~/.gemini/antigravity-cli"
    # Hộp thư với genh trên máy chủ (bind mount <gốc cài đặt>/run, xem apps/genh/internal/hostlink): phiên bản đang
    # chạy, yêu cầu "Cập nhật ngay" từ Console, trạng thái cập nhật. Không có thư mục (dev/test) ⇒ nút cập nhật ẩn.
    host_link_dir: str = "/var/lib/gh/host"
    # Kho phát hành để hỏi bản mới nhất (GitHub Releases); rỗng ⇒ không kiểm bản mới.
    release_repo: str = "Genesis-ryan-84-0567536339/Gen-Harness"
    cli_binary: str = "agy"

    # Phiên đăng nhập 7 ngày, trượt (gia hạn khi còn dưới nửa — gh/auth/service.py::load_session): app tự host,
    # một Owner, không nên bắt đăng nhập lại mỗi ngày.
    session_ttl_hours: int = 168
    pin_session_minutes: int = 30
    pin_max_attempts: int = 5
    pin_lock_minutes: int = 15
    cookie_secure: bool = True
    # Dọn core.sessions (PLAN §5.6 lỗi 🟡): xoá vĩnh viễn phiên đã HẾT HẠN hoặc BỊ THU HỒI quá N ngày (job
    # hằng giờ — gh/worker.py::expire_sessions). Phiên còn hiệu lực không bao giờ bị đụng tới dù N nhỏ.
    session_purge_after_days: int = 30

    stream_maxlen: int = Field(default=100_000, description="Độ dài tối đa mỗi Redis Stream (xấp xỉ)")
    # Khoá công khai ed25519 (base64, 32 byte) tin cậy để kiểm chữ ký plugin nạp từ tệp (ARCHITECTURE §6.4),
    # phân tách bởi dấu phẩy. Trống ở dev/test — plugin nào cũng bị đánh signature_ok=false (không tự ý coi là hợp lệ).
    plugin_trusted_signing_keys: str = ""
    # Kho tệp cho Tài liệu (biz.documents): chưa có client MinIO nối dây ở giai đoạn 1/2 (xem gh/chassis/objects.py
    # — quyết định tự đưa ra ở cụm relations). Mặc định đĩa cục bộ ngoài thư mục repo (thư mục tạm hệ thống).
    objects_dir: str = Field(default="")

    @property
    def is_production(self) -> bool:
        return self.env == "production"

    @property
    def effective_admin_database_url(self) -> str:
        """URL superuser dùng cho migrate/backup/bảo trì phân vùng — `admin_database_url` nếu có, không thì
        dùng lại `database_url` (dev/test: một vai trò duy nhất đã là superuser)."""
        return self.admin_database_url or self.database_url


@lru_cache
def get_settings() -> Settings:
    return Settings()
