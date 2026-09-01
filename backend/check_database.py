#!/usr/bin/env python3
"""Read-only PostgreSQL connectivity check using backend/.env."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg2
from psycopg2 import errors
from dotenv import load_dotenv


REPO_ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    load_dotenv(REPO_ROOT / ".env")
    load_dotenv(REPO_ROOT / "backend" / ".env")

    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise SystemExit("DATABASE_URL is missing from backend/.env")

    connection = psycopg2.connect(
        database_url,
        connect_timeout=8,
        application_name="uwb_connection_test",
    )

    try:
        connection.set_session(readonly=True, autocommit=True)
        with connection.cursor() as cursor:
            cursor.execute(
                """
                select current_database(),
                       current_user,
                       version(),
                       inet_server_addr()::text,
                       inet_server_port()
                """
            )
            database, user, version, host, port = cursor.fetchone()

            cursor.execute(
                """
                select current_schema(),
                       current_setting('search_path'),
                       has_database_privilege(
                           current_user, current_database(), 'CREATE'
                       ),
                       has_schema_privilege(current_user, 'public', 'USAGE'),
                       has_schema_privilege(current_user, 'public', 'CREATE')
                """
            )
            (
                current_schema,
                search_path,
                can_create_database_objects,
                can_use_public,
                can_create_public,
            ) = cursor.fetchone()

            cursor.execute(
                """
                select c.relname,
                       pg_get_userbyid(c.relowner),
                       has_table_privilege(current_user, c.oid, 'SELECT'),
                       has_table_privilege(current_user, c.oid, 'INSERT'),
                       has_table_privilege(current_user, c.oid, 'UPDATE'),
                       has_table_privilege(current_user, c.oid, 'DELETE'),
                       c.relrowsecurity
                from pg_catalog.pg_class as c
                join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
                where n.nspname = 'public'
                  and c.relkind in ('r', 'p')
                order by c.relname
                """
            )
            table_access = cursor.fetchall()

        print("connection=ok")
        print(f"database={database}")
        print(f"user={user}")
        print(f"server={version.split(',')[0]}")
        print(f"endpoint={host}:{port}")
        print(f"current_schema={current_schema}")
        print(f"search_path={search_path}")
        print(
            "database_create="
            f"{str(can_create_database_objects).lower()}"
        )
        print(f"public_usage={str(can_use_public).lower()}")
        print(f"public_create={str(can_create_public).lower()}")
        print(f"public_table_count={len(table_access)}")
        print(
            "table_access="
            + ",".join(
                f"{table}(owner={owner};select={str(can_select).lower()};"
                f"insert={str(can_insert).lower()};update={str(can_update).lower()};"
                f"delete={str(can_delete).lower()};rls={str(rls).lower()})"
                for (
                    table, owner, can_select, can_insert, can_update,
                    can_delete, rls,
                ) in table_access
            )
        )

        try:
            with connection.cursor() as cursor:
                cursor.execute("select 1 from users limit 1")
            print("app_schema_access=ok")
        except errors.InsufficientPrivilege as exc:
            print("app_schema_access=denied")
            raise SystemExit(
                "The PostgreSQL login works, but this role cannot read the "
                "application tables. Ask the table owner/DBA to run "
                "database/configure_backend_role.sql."
            ) from exc
    finally:
        connection.close()


if __name__ == "__main__":
    main()
