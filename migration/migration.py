#!/usr/bin/env python3
"""Set up (or migrate into) the SUPALAI-UWB PostgreSQL database.

Usage:
    python migration/migration.py                               # create schema only
    python migration/migration.py --seed                        # + demo seed data
    python migration/migration.py --from-sqlite path/to/old.db   # + copy rows from a
                                                                    previous SQLite
                                                                    deployment

Reads the target PostgreSQL connection string from DATABASE_URL and checks
backend/.env and the repo-root .env, same as the
running API (see backend/backend/config.py) — or from --database-url.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

REPO_ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS_DIR = REPO_ROOT / "database" / "migrations"
SCHEMA_SQL = REPO_ROOT / "database" / "schema.sql"
SEED_SQL = REPO_ROOT / "database" / "seed.sql"


def _load_dotenv_files() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        print(
            "note: python-dotenv not installed, so .env files won't be read "
            "automatically — pass --database-url explicitly, or `pip install python-dotenv`.",
            file=sys.stderr,
        )
        return
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(REPO_ROOT / "backend" / ".env")


def resolve_database_url(explicit: str | None) -> str:
    if explicit:
        return explicit
    _load_dotenv_files()
    url = os.getenv("DATABASE_URL")
    if not url:
        sys.exit(
            "No DATABASE_URL set. Put a PostgreSQL connection string in "
            "backend/.env, or pass --database-url."
        )
    return url


def apply_schema(conn) -> None:
    print(f"Applying {SCHEMA_SQL.relative_to(REPO_ROOT)} ...")
    with conn.cursor() as cur:
        cur.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
    conn.commit()
    print("  schema OK")


def apply_migrations(conn) -> None:
    if not MIGRATIONS_DIR.exists():
        print("No migrations directory found, skipping.")
        return

    files = sorted(MIGRATIONS_DIR.glob("*.sql"))

    if not files:
        print("No migrations found.")
        return

    for migration_file in files:
        print(f"Applying {migration_file.relative_to(REPO_ROOT)} ...")

        try:
            with conn.cursor() as cur:
                cur.execute(migration_file.read_text(encoding="utf-8"))
            conn.commit()
        except Exception:
            conn.rollback()
            raise

        print(f"  {migration_file.name} OK")


def apply_seed(conn) -> None:
    text = SEED_SQL.read_text(encoding="utf-8").strip()
    if not text:
        print("  (seed.sql is empty, skipping)")
        return
    print(f"Applying {SEED_SQL.relative_to(REPO_ROOT)} ...")
    with conn.cursor() as cur:
        cur.execute(text)
    conn.commit()
    print("  seed OK")


# Tables in dependency order (parents before children) so foreign keys resolve,
# matching the columns the *old SQLite starter backend* used (see the project's
# git history / backend/backend/database.py before this migration).
SQLITE_TABLES = [
    ("users", ["id", "employee_id", "email", "password_hash", "role", "position",
               "first_th", "last_th", "first_en", "last_en", "tag_id"]),
    ("projects", ["id", "name", "province", "plan_id", "plan_name", "width_m", "height_m"]),
    ("anchors", ["project_id", "anchor_id", "x", "y", "battery", "last_ts"]),
    ("tags", ["tag_id", "employee_id", "x", "y", "battery", "last_ts"]),
    ("customers", ["id", "name"]),
    ("visits", ["visit_key", "tag_id", "employee_id", "project_id", "plan_id", "customer_id",
                "started_at", "ended_at", "duration_sec", "zone", "deal_status"]),
    ("notes", ["visit_key", "user_id", "body", "created_at"]),
    ("positions", ["tag_id", "x", "y", "zone", "ts"]),
]


def migrate_from_sqlite(pg_conn, sqlite_path: Path) -> None:
    if not sqlite_path.exists():
        sys.exit(f"SQLite file not found: {sqlite_path}")

    print(f"Migrating rows from {sqlite_path} ...")
    sconn = sqlite3.connect(str(sqlite_path))
    sconn.row_factory = sqlite3.Row

    with pg_conn.cursor() as cur:
        for table, columns in SQLITE_TABLES:
            try:
                rows = sconn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
            except sqlite3.OperationalError as exc:
                print(f"  {table}: skipped ({exc})")
                continue

            if not rows:
                print(f"  {table}: 0 rows")
                continue

            col_list = ", ".join(columns)
            placeholders = ", ".join(["%s"] * len(columns))
            sql = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
            values = [tuple(row) for row in rows]
            psycopg2.extras.execute_batch(cur, sql, values)
            print(f"  {table}: {len(rows)} rows")

    pg_conn.commit()
    sconn.close()
    print("  migration from SQLite complete")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-url", help="Postgres connection string (overrides DATABASE_URL env var)")
    parser.add_argument("--seed", action="store_true", help="Also load database/seed.sql demo data")
    parser.add_argument("--from-sqlite", metavar="PATH", help="Copy rows from a previous SQLite deployment (e.g. backend/backend/supalai.db)")
    args = parser.parse_args()

    database_url = resolve_database_url(args.database_url)
    safe = database_url.rsplit("@", 1)[-1] if "@" in database_url else database_url
    print(f"Connecting to postgres ({safe}) ...")
    conn = psycopg2.connect(database_url)

    try:
        apply_schema(conn)

        if args.seed:
            apply_seed(conn)

        if args.from_sqlite:
            migrate_from_sqlite(conn, Path(args.from_sqlite))

        # Run migrations after optional legacy imports so their backfills also
        # cover rows imported by this invocation.
        apply_migrations(conn)
    finally:
        conn.close()

    print("Done.")


if __name__ == "__main__":
    main()
