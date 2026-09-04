from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any

import psycopg2
import psycopg2.extras
import psycopg2.pool

from config import settings

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


def apply_migrations() -> None:
    """Apply every versioned SQL migration in filename order.

    The migration files are written to be idempotent, so startup can safely
    ensure plan-editor and legacy-import structures exist without maintaining
    a second schema-version mechanism.
    """
    if not MIGRATIONS_DIR.exists():
        return
    for migration_file in sorted(MIGRATIONS_DIR.glob("*.sql")):
        db.script(migration_file.read_text(encoding="utf-8"))
