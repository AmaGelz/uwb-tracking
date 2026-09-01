#!/usr/bin/env python3
"""Copy SUPALAI application rows between PostgreSQL databases.

The source URL is read only from SOURCE_DATABASE_URL. The target URL follows
the backend and is read from DATABASE_URL / backend/.env. Run without --apply
for a read-only preflight; --apply performs one all-or-nothing transaction.
"""

from __future__ import annotations

import argparse
import os
import sys
from collections import OrderedDict
from pathlib import Path
from urllib.parse import urlsplit

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv


REPO_ROOT = Path(__file__).resolve().parent.parent

# Ordered parents-before-children. Sessions and hardware receipts are
# deliberately excluded; existing web sessions do not survive the cutover and
# hardware receipts are short-lived idempotency records.
TABLE_COLUMNS: OrderedDict[str, tuple[str, ...]] = OrderedDict(
    [
        (
            "users",
            (
                "id", "employee_id", "email", "password_hash", "role",
                "position", "first_th", "last_th", "first_en", "last_en",
                "phone", "tag_id", "created_at",
            ),
        ),
        (
            "projects",
            ("id", "name", "province", "plan_id", "plan_name", "width_m", "height_m"),
        ),
        ("customers", ("id", "name")),
        (
            "plans",
            (
                "id", "project_id", "name", "width_m", "height_m",
                "is_active", "version", "created_at", "updated_at",
            ),
        ),
        (
            "plan_objects",
            (
                "id", "plan_id", "object_type", "label", "geometry",
                "properties", "created_at", "updated_at",
            ),
        ),
        (
            "plan_dimensions",
            (
                "id", "plan_id", "x1", "y1", "x2", "y2", "length_m",
                "angle_deg", "label", "created_at", "updated_at",
            ),
        ),
        (
            "zones",
            (
                "id", "project_id", "name", "x_min", "x_max", "y_min",
                "y_max", "plan_id", "geometry",
            ),
        ),
        (
            "anchors",
            (
                "id", "project_id", "anchor_id", "x", "y", "battery",
                "last_ts", "plan_id", "z", "mount_height_m",
            ),
        ),
        (
            "tags",
            (
                "id", "tag_id", "employee_id", "project_id", "x", "y",
                "battery", "last_ts", "plan_id", "z", "source", "device_id",
            ),
        ),
        (
            "visits",
            (
                "id", "visit_key", "tag_id", "employee_id", "project_id",
                "plan_id", "customer_id", "started_at", "ended_at",
                "duration_sec", "zone", "deal_status",
            ),
        ),
        (
            "notes",
            ("id", "visit_key", "user_id", "body", "created_at", "seed_key"),
        ),
        (
            "positions",
            (
                "id", "tag_id", "x", "y", "zone", "ts", "project_id",
                "plan_id", "z", "source", "residual_m", "anchors_used",
                "device_id", "message_id",
            ),
        ),
    ]
)

REQUIRED_SOURCE_TABLES = {
    "users", "projects", "customers", "zones", "anchors", "tags",
    "visits", "notes", "positions",
}


def load_urls() -> tuple[str, str]:
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(REPO_ROOT / "backend" / ".env")
    source = os.getenv("SOURCE_DATABASE_URL", "").strip()
    target = os.getenv("DATABASE_URL", "").strip()
    if not source:
        raise SystemExit("SOURCE_DATABASE_URL is not set")
    if not target:
        raise SystemExit("DATABASE_URL is not set")
    if source == target:
        raise SystemExit("Source and target URLs must be different")
    return source, target


def safe_endpoint(url: str) -> str:
    parsed = urlsplit(url)
    database = parsed.path.lstrip("/") or "postgres"
    return f"{parsed.hostname}:{parsed.port or 5432}/{database}"


def table_metadata(conn) -> dict[str, dict[str, object]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT c.relname,
                   pg_get_userbyid(c.relowner),
                   c.relrowsecurity,
                   has_table_privilege(current_user, c.oid, 'SELECT'),
                   has_table_privilege(current_user, c.oid, 'INSERT')
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            """
        )
        rows = cur.fetchall()

        cur.execute(
            """
            SELECT table_name, column_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
            ORDER BY ordinal_position
            """
        )
        columns: dict[str, set[str]] = {}
        for table, column in cur.fetchall():
            columns.setdefault(table, set()).add(column)

    return {
        table: {
            "owner": owner,
            "rls": rls,
            "select": can_select,
            "insert": can_insert,
            "columns": columns.get(table, set()),
        }
        for table, owner, rls, can_select, can_insert in rows
    }


def identity(conn) -> tuple[str, str, bool]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT current_database(), current_user, rolbypassrls
            FROM pg_roles
            WHERE rolname = current_user
            """
        )
        return cur.fetchone()


def preflight(source, target) -> tuple[dict[str, int], list[str]]:
    source_db, source_user, source_bypass = identity(source)
    target_db, target_user, target_bypass = identity(target)
    source_meta = table_metadata(source)
    target_meta = table_metadata(target)

    print(f"source={source_db} user={source_user} bypass_rls={source_bypass}")
    print(f"target={target_db} user={target_user} bypass_rls={target_bypass}")

    missing_source = sorted(REQUIRED_SOURCE_TABLES - source_meta.keys())
    if missing_source:
        raise RuntimeError(f"source is missing required tables: {', '.join(missing_source)}")

    selected_tables = [name for name in TABLE_COLUMNS if name in source_meta]
    missing_target = sorted(set(selected_tables) - target_meta.keys())
    if missing_target:
        raise RuntimeError(f"target is missing tables: {', '.join(missing_target)}")

    blocked: list[str] = []
    for table in selected_tables:
        meta = target_meta[table]
        owner_or_bypass = meta["owner"] == target_user or target_bypass
        if not meta["insert"]:
            blocked.append(f"{table}: INSERT privilege missing (owner={meta['owner']})")
        elif meta["rls"] and not owner_or_bypass:
            blocked.append(f"{table}: RLS enabled and target role is not owner/BYPASSRLS")

    counts: dict[str, int] = {}
    with source.cursor() as cur:
        for table in selected_tables:
            if not source_meta[table]["select"]:
                raise RuntimeError(f"source SELECT privilege missing: public.{table}")
            cur.execute(f'SELECT COUNT(*) FROM public."{table}"')
            counts[table] = cur.fetchone()[0]
            print(f"source_rows {table}={counts[table]}")

    if blocked:
        raise RuntimeError("target permission preflight failed:\n  " + "\n  ".join(blocked))

    return counts, selected_tables


def copy_table(source, target, table: str) -> int:
    source_meta = table_metadata(source)[table]
    target_meta = table_metadata(target)[table]
    columns = [
        col for col in TABLE_COLUMNS[table]
        if col in source_meta["columns"] and col in target_meta["columns"]
    ]
    if not columns:
        raise RuntimeError(f"no compatible columns for {table}")

    quoted_columns = ", ".join(f'"{column}"' for column in columns)
    select_sql = f'SELECT {quoted_columns} FROM public."{table}"'
    insert_sql = (
        f'INSERT INTO public."{table}" ({quoted_columns}) VALUES %s '
        "ON CONFLICT DO NOTHING"
    )

    inserted = 0
    cursor_name = f"copy_{table}"
    with source.cursor(name=cursor_name) as source_cur, target.cursor() as target_cur:
        source_cur.itersize = 1000
        source_cur.execute(select_sql)
        while True:
            rows = source_cur.fetchmany(1000)
            if not rows:
                break
            psycopg2.extras.execute_values(
                target_cur,
                insert_sql,
                rows,
                page_size=500,
            )
            inserted += max(target_cur.rowcount, 0)
    return inserted


def reset_sequence(conn, table: str) -> None:
    if "id" not in TABLE_COLUMNS[table]:
        return
    with conn.cursor() as cur:
        cur.execute(
            "SELECT pg_get_serial_sequence(%s, 'id')",
            (f"public.{table}",),
        )
        sequence = cur.fetchone()[0]
        if not sequence:
            return
        cur.execute(
            f'SELECT COALESCE(MAX(id), 1), COUNT(*) > 0 FROM public."{table}"'
        )
        maximum, has_rows = cur.fetchone()
        cur.execute("SELECT setval(%s, %s, %s)", (sequence, maximum, has_rows))


def apply_copy(source, target, selected_tables: list[str]) -> None:
    source.set_session(isolation_level="REPEATABLE READ", readonly=True)
    target.autocommit = False
    try:
        for table in selected_tables:
            inserted = copy_table(source, target, table)
            reset_sequence(target, table)
            print(f"inserted {table}={inserted}")
        target.commit()
    except Exception:
        target.rollback()
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Perform the copy. Without this flag, only run read-only checks.",
    )
    args = parser.parse_args()
    source_url, target_url = load_urls()
    print(f"source_endpoint={safe_endpoint(source_url)}")
    print(f"target_endpoint={safe_endpoint(target_url)}")

    source = psycopg2.connect(
        source_url,
        connect_timeout=12,
        application_name="uwb_migration_source",
    )
    target = psycopg2.connect(
        target_url,
        connect_timeout=12,
        application_name="uwb_migration_target",
    )
    try:
        _, selected_tables = preflight(source, target)
        if not args.apply:
            print("preflight=ok (read-only; run again with --apply to copy rows)")
            return
        apply_copy(source, target, selected_tables)
        print("migration=committed")
    finally:
        source.close()
        target.close()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"migration_failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
