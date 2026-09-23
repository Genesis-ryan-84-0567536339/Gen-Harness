"""Cấu hình đọc từ biến môi trường (tiền tố GH_)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="GH_", env_file=".env", extra="ignore")

    env: str = "development"
    public_url: str = "https://localhost:8443"
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/gen_harness"
    redis_url: str = "redis://localhost:6379/0"
    # 32 byte base64. Trống ở môi trường dev/test → sinh tạm (không dùng cho production).
    master_key: str = ""
    master_key_file: str = ""       # Docker secret (vd. /run/secrets/gh_master_key) — ưu tiên hơn biến môi trường
    setup_token: str = ""
    # Khoá bridge (32 byte base64): ký permit gửi tin và mã hoá phiên kênh khi truyền (docs/api/bridge-protocol.md)
    bridge_key: str = ""
    bridge_key_file: str = ""
    # Thư mục cấu hình của Antigravity CLI (tệp OAuth token); worker ghi hồ sơ đang hoạt động vào đây
    cli_home: str = "~/.gemini/antigravity-cli"
    cli_binary: str = "agy"

    session_ttl_hours: int = 12
    pin_session_minutes: int = 30
    pin_max_attempts: int = 5
    pin_lock_minutes: int = 15
    cookie_secure: bool = True

    stream_maxlen: int = Field(default=100_000, description="Độ dài tối đa mỗi Redis Stream (xấp xỉ)")

    @property
    def is_production(self) -> bool:
        return self.env == "production"


@lru_cache
def get_settings() -> Settings:
    return Settings()
