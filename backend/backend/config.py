from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR.parent.parent / ".env")  # repo root .env (Supabase keys live here)
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

    Priority:
    1. DATABASE_URL / SUPABASE_DB_URL — a full postgres:// connection
       string. This is what you get from Supabase's dashboard under
       Project Settings -> Database -> Connection string (URI). Use
       the "connection pooling" URI (port 6543) for normal API
       traffic, or the direct one (port 5432) for migration.py.
    2. Individual PG* parts (PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE),
       for environments that already set those (e.g. local Postgres).

    Note: SUPABASE_URL/SUPABASE_KEY (the https://xxx.supabase.co REST
    endpoint + anon/service key) are NOT enough on their own to open a
    raw SQL connection — those are for the PostgREST/supabase-py
    client. This backend talks Postgres directly via psycopg2 for the
    join-heavy analytics queries, so it needs the *database*
    connection string specifically.
    """
    url = os.getenv("DATABASE_URL") or os.getenv("SUPABASE_DB_URL")
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
    # against the local Postgres started for this repo. Supabase deployments
    # must set DATABASE_URL in backend/.env — see backend/README.md.
    return "postgresql://postgres:postgres@127.0.0.1:5432/supalai_test"


@dataclass(frozen=True)
class Settings:
    app_name: str = os.getenv("APP_NAME", "SUPALAI Tracking API")
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8000"))
    debug: bool = _bool("DEBUG", True)

    database_url: str = field(default_factory=_database_url)

    supabase_url: str = os.getenv("SUPABASE_URL", "")
    supabase_key: str = os.getenv("SUPABASE_KEY", "")

    session_hours: int = int(os.getenv("SESSION_HOURS", "12"))

    google_client_id: str = os.getenv("GOOGLE_CLIENT_ID", "")

    # Live position simulator (no real UWB hardware connected yet).
    # Turn off with SIMULATOR_ENABLED=false once real anchors/tags are wired in.
    simulator_enabled: bool = _bool("SIMULATOR_ENABLED", True)
    simulator_tick_seconds: float = float(os.getenv("SIMULATOR_TICK_SECONDS", "1.0"))

    cors_origins: list[str] = field(default_factory=_origins)


settings = Settings()
