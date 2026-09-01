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


class Database:
    """Thin Postgres access layer.

    Talks to PostgreSQL directly over the wire via psycopg2. Several
    endpoints here (analytics, dwell-time,
    visit funnels) need real joins/aggregations that are awkward to
    express through a REST-table client. A small connection pool
    keeps this fast against a hosted database where every new TCP+TLS
    connection has real latency.
    """

    def __init__(self, dsn: str) -> None:
        self.dsn = dsn
        self._pool = psycopg2.pool.ThreadedConnectionPool(1, 10, dsn=dsn)

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

    def readiness(self) -> None:
        """Verify that the configured role can use the application schema."""
        with self._conn() as conn:
            with conn.cursor() as cur:
                # SELECT 1 alone only proves that PostgreSQL is reachable.  A
                # runtime role can connect successfully while having no table
                # privileges, so exercise a real application table as well.
                cur.execute("SELECT 1 FROM users LIMIT 1")


db = Database(settings.database_url)


def init_db() -> None:
    """Apply the base schema and ordered, idempotent PostgreSQL migrations."""
    db.script(SCHEMA_SQL.read_text(encoding="utf-8"))
    if MIGRATIONS_DIR.exists():
        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            db.script(migration.read_text(encoding="utf-8"))


def seed_demo_data() -> None:
    """Apply database/seed.sql. Idempotent (ON CONFLICT DO NOTHING)."""
    text = SEED_SQL.read_text(encoding="utf-8").strip()
    if not text:
        return
    db.script(text)
    # Re-run idempotent migrations so backfills also cover newly seeded rows.
    if MIGRATIONS_DIR.exists():
        for migration in sorted(MIGRATIONS_DIR.glob("*.sql")):
            db.script(migration.read_text(encoding="utf-8"))
