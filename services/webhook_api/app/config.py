from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: str = Field(default="development", alias="APP_ENV")
    database_url: str = Field(alias="DATABASE_URL")
    database_ssl: bool = Field(default=True, alias="DATABASE_SSL")
    jotform_webhook_secret: str = Field(alias="JOTFORM_WEBHOOK_SECRET")
    admin_api_key: str | None = Field(default=None, alias="ADMIN_API_KEY")
    google_sheet_id: str | None = Field(default=None, alias="GOOGLE_SHEET_ID")
    google_sheet_tab: str = Field(default="Loans", alias="GOOGLE_SHEET_TAB")
    google_service_account_json_b64: str | None = Field(
        default=None,
        alias="GOOGLE_SERVICE_ACCOUNT_JSON_B64",
    )

    @property
    def sqlalchemy_database_url(self) -> str:
        url = self.database_url.strip().rstrip("}")
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+psycopg://", 1)
        return url


@lru_cache
def get_settings() -> Settings:
    return Settings()
