from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent.parent / ".env")  # shared deployment settings
load_dotenv(BASE_DIR.parent / ".env")         # backend/.env (app-level settings)
load_dotenv(BASE_DIR / ".env")


def _bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _origins() -> list[str]:
    raw = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:8000,http://127.0.0.1:8000,"
        "http://localhost:5500,http://127.0.0.1:5500",
    )
    return [x.strip() for x in raw.split(",") if x.strip()]


def _database_url() -> str:
    """Resolve the Postgres connection string.

    DATABASE_URL takes priority. Individual PGHOST/PGPORT/PGUSER/
    PGPASSWORD/PGDATABASE values are also supported for PostgreSQL
    environments that provide connection settings separately.
    """
    url = os.getenv("DATABASE_URL")
    if url:
        return url

    host = os.getenv("PGHOST")
    if host:
        user = os.getenv("PGUSER", "postgres")
        password = os.getenv("PGPASSWORD", "")
        port = os.getenv("PGPORT", "5432")
        dbname = os.getenv("PGDATABASE", "postgres")
        auth = f"{user}:{password}@" if password else f"{user}@"
        return f"postgresql://{auth}{host}:{port}/{dbname}"

    # Local development fallback so `python main.py` works out of the box
    # against the local PostgreSQL instance used for this repository.
    return "postgresql://postgres:postgres@127.0.0.1:5432/supalai_test"


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "SUPALAI Tracking API")
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))
    debug: bool = _bool("DEBUG", True)

    database_url: str = field(default_factory=_database_url)

    session_hours: int = int(os.getenv("SESSION_HOURS", "12"))
    hardware_ingest_secret: str = os.getenv("HARDWARE_INGEST_SECRET", "")
    auto_migrate: bool = _bool("AUTO_MIGRATE", True)
    seed_demo_data: bool = _bool("SEED_DEMO_DATA", True)

    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")
    google_workspace_domain: str = os.getenv("GOOGLE_WORKSPACE_DOMAIN", "").lower().strip()

    # Account email. Without a configured provider in debug mode, one-time
    # links are written to the backend log so local development remains usable.
    frontend_base_url: str = os.getenv("FRONTEND_BASE_URL", "http://127.0.0.1:8000")
    password_reset_minutes: int = int(os.getenv("PASSWORD_RESET_MINUTES", "30"))
    password_reset_cooldown_seconds: int = int(os.getenv("PASSWORD_RESET_COOLDOWN_SECONDS", "60"))
    activation_hours: int = int(os.getenv("ACTIVATION_HOURS", "24"))
    mail_provider: str = os.getenv("MAIL_PROVIDER", "auto").lower().strip()
    gmail_sender_email: str = os.getenv("GMAIL_SENDER_EMAIL", "")
    google_service_account_file: str = os.getenv("GOOGLE_SERVICE_ACCOUNT_FILE", "")
    google_service_account_json: str = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON", "")
    gmail_oauth_client_id: str = os.getenv("GMAIL_OAUTH_CLIENT_ID", "")
    gmail_oauth_client_secret: str = os.getenv("GMAIL_OAUTH_CLIENT_SECRET", "")
    gmail_oauth_refresh_token: str = os.getenv("GMAIL_OAUTH_REFRESH_TOKEN", "")
    smtp_host: str = os.getenv("SMTP_HOST", "")
    smtp_port: int = int(os.getenv("SMTP_PORT", "587"))
    smtp_username: str = os.getenv("SMTP_USERNAME", "")
    smtp_password: str = os.getenv("SMTP_PASSWORD", "")
    smtp_from_email: str = os.getenv("SMTP_FROM_EMAIL", "")
    smtp_starttls: bool = _bool("SMTP_STARTTLS", True)
    smtp_use_ssl: bool = _bool("SMTP_USE_SSL", False)

    # Live position simulator (no real UWB hardware connected yet).
    # Turn off with SIMULATOR_ENABLED=false once real anchors/tags are wired in.
    simulator_enabled: bool = _bool("SIMULATOR_ENABLED", True)
    simulator_tick_seconds: float = float(os.getenv("SIMULATOR_TICK_SECONDS", "1.0"))

    cors_origins: list[str] = field(default_factory=_origins)


settings = Settings()
