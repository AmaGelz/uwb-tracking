from __future__ import annotations

import hashlib
import logging
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
import psycopg2.pool

from config import settings

logger = logging.getLogger("supalai.db")

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SCHEMA_SQL = REPO_ROOT / "database" / "schema.sql"
SEED_SQL = REPO_ROOT / "database" / "seed.sql"
MIGRATIONS_DIR = REPO_ROOT / "database" / "migrations"
APP_SCHEMA = "supalai_dashboard"


class Database:
    """Thin Postgres access layer.

    Talks directly to PostgreSQL over psycopg2. Several endpoints
    (analytics, dwell-time and visit funnels) use joins/aggregations, and a
    small connection pool avoids opening a new TCP connection per request.
    """

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        # The connected database already contains the legacy UWB application's
        # public tables.  Keep this dashboard isolated while still allowing
        # explicitly-qualified reads from ``public`` for the compatibility
        # bridge.
        self._pool = psycopg2.pool.ThreadedConnectionPool(
            1,
            10,
            dsn=dsn,
            options=f"-c search_path={APP_SCHEMA},public",
        )

    @contextmanager
    def _conn(self):
        conn = self._pool.getconn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            self._pool.putconn(conn)

    def execute(self, sql: str, params: tuple = ()) -> None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)

    def execute_returning(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        with self._conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                return dict(row) if row else None

    def fetchone(self, sql: str, params: tuple = ()) -> dict[str, Any] | None:
        with self._conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                row = cur.fetchone()
                return dict(row) if row else None

    def fetchall(self, sql: str, params: tuple = ()) -> list[dict[str, Any]]:
        with self._conn() as conn:
            with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
                return [dict(r) for r in rows]

    def executemany(self, sql: str, seq_of_params: list[tuple]) -> None:
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.executemany(sql, seq_of_params)

    def script(self, sql_text: str) -> None:
        """Run a multi-statement .sql file's contents in one go."""
        with self._conn() as conn:
            with conn.cursor() as cur:
                cur.execute(sql_text)


db = Database(settings.database_url)


def init_db() -> None:
    """Apply database/schema.sql. Idempotent (CREATE TABLE IF NOT EXISTS)."""
    db.script(SCHEMA_SQL.read_text(encoding="utf-8"))


def seed_demo_data() -> None:
    """Apply database/seed.sql. Idempotent (ON CONFLICT DO NOTHING)."""
    text = SEED_SQL.read_text(encoding="utf-8").strip()
    if not text:
        return
    db.script(text)


def _remember_applied_migration(filename: str, digest: str) -> None:
    db.execute(
        """
        INSERT INTO applied_migrations (filename, content_sha256, applied_at)
        VALUES (%s, %s, now())
        ON CONFLICT (filename)
        DO UPDATE SET content_sha256 = EXCLUDED.content_sha256,
                      applied_at = EXCLUDED.applied_at
        """,
        (filename, digest),
    )


def _applied_migrations() -> dict[str, str] | None:
    """Filename -> content hash already applied, or None if unavailable.

    Returning None makes the caller fall back to replaying everything, which
    is how this worked before and is always safe.
    """
    try:
        db.script(
            """
            CREATE TABLE IF NOT EXISTS applied_migrations (
                filename       text PRIMARY KEY,
                content_sha256 text NOT NULL,
                applied_at     timestamptz NOT NULL DEFAULT now()
            )
            """
        )
        rows = db.fetchall("SELECT filename, content_sha256 FROM applied_migrations")
    except psycopg2.Error:
        logger.warning("cannot track applied migrations; replaying all of them", exc_info=True)
        return None
    return {row["filename"]: row["content_sha256"] for row in rows}


def apply_migrations() -> None:
    """Apply every versioned SQL migration in filename order.

    The migration files are written to be idempotent, so startup can ensure
    plan-editor and legacy-import structures exist without anyone maintaining
    schema versions by hand. Replaying them unconditionally is what that
    costs, though, and it grows: the legacy import re-scans the whole of
    public.positions_log on every boot, inside the startup handler.

    So the content of each file is hashed and recorded. A file whose hash is
    unchanged is skipped; edit a migration and it applies again on the next
    start, exactly as before. The first run against an existing database still
    replays everything once, harmlessly, and records it.
    """
    if not MIGRATIONS_DIR.exists():
        return

    applied = _applied_migrations()
    for migration_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
        text = migration_file.read_text(encoding="utf-8")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        if applied is not None and applied.get(migration_file.name) == digest:
            continue
        db.script(text)
        if applied is not None:
            _remember_applied_migration(migration_file.name, digest)
