-- Manual, data-only migration from a Supabase export staged in this database.
--
-- Prerequisites:
--   1. The application schema/migrations already exist in schema public.
--   2. In DBeaver, copy the Supabase public tables into schema
--      supabase_import on the TARGET database (data + staging table structure).
--   3. Run this file as the owner of the public application tables.
--
-- This script intentionally does not copy Supabase Auth, sessions, storage,
-- realtime, or hardware-ingest receipts. It never truncates target tables and
-- is safe to retry: conflicting rows are left unchanged.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '0';

DO $$
DECLARE
    required_table text;
BEGIN
    IF to_regnamespace('supabase_import') IS NULL THEN
        RAISE EXCEPTION
            'Missing schema supabase_import. Import Supabase tables into that staging schema first.';
    END IF;

    FOREACH required_table IN ARRAY ARRAY[
        'users', 'projects', 'zones', 'anchors', 'tags', 'positions',
        'customers', 'visits', 'notes'
    ]
    LOOP
        IF to_regclass(format('supabase_import.%I', required_table)) IS NULL THEN
            RAISE EXCEPTION 'Missing staging table supabase_import.%', required_table;
        END IF;
    END LOOP;
END
$$;

-- Parent records first so foreign keys remain valid throughout the import.
INSERT INTO public.users (
    id, employee_id, email, password_hash, role, position,
    first_th, last_th, first_en, last_en, phone, tag_id, created_at
)
SELECT
    id, employee_id, email, password_hash, role, position,
    first_th, last_th, first_en, last_en, phone, tag_id, created_at
FROM supabase_import.users
ON CONFLICT DO NOTHING;

INSERT INTO public.projects (
    id, name, province, plan_id, plan_name, width_m, height_m
)
SELECT id, name, province, plan_id, plan_name, width_m, height_m
FROM supabase_import.projects
ON CONFLICT DO NOTHING;

INSERT INTO public.customers (id, name)
SELECT id, name
FROM supabase_import.customers
ON CONFLICT DO NOTHING;

-- Plan-editor tables are optional for older Supabase snapshots.
DO $$
BEGIN
    IF to_regclass('supabase_import.plans') IS NOT NULL THEN
        INSERT INTO public.plans (
            id, project_id, name, width_m, height_m, is_active,
            version, created_at, updated_at
        )
        SELECT
            id, project_id, name, width_m, height_m, is_active,
            version, created_at, updated_at
        FROM supabase_import.plans
        ON CONFLICT DO NOTHING;
    END IF;
END
$$;

DO $$
BEGIN
    IF to_regclass('supabase_import.plan_objects') IS NOT NULL THEN
        INSERT INTO public.plan_objects (
            id, plan_id, object_type, label, geometry, properties,
            created_at, updated_at
        )
        SELECT
            id, plan_id, object_type, label, geometry, properties,
            created_at, updated_at
        FROM supabase_import.plan_objects
        ON CONFLICT DO NOTHING;
    END IF;
END
$$;

DO $$
BEGIN
    IF to_regclass('supabase_import.plan_dimensions') IS NOT NULL THEN
        INSERT INTO public.plan_dimensions (
            id, plan_id, x1, y1, x2, y2, length_m, angle_deg,
            label, created_at, updated_at
        )
        SELECT
            id, plan_id, x1, y1, x2, y2, length_m, angle_deg,
            label, created_at, updated_at
        FROM supabase_import.plan_dimensions
        ON CONFLICT DO NOTHING;
    END IF;
END
$$;

INSERT INTO public.zones (
    id, project_id, name, x_min, x_max, y_min, y_max, plan_id, geometry
)
SELECT id, project_id, name, x_min, x_max, y_min, y_max, plan_id, geometry
FROM supabase_import.zones
ON CONFLICT DO NOTHING;

INSERT INTO public.anchors (
    id, project_id, anchor_id, x, y, battery, last_ts,
    plan_id, z, mount_height_m
)
SELECT
    id, project_id, anchor_id, x, y, battery, last_ts,
    plan_id, z, mount_height_m
FROM supabase_import.anchors
ON CONFLICT DO NOTHING;

-- Hardware-only columns added after the Supabase version are left NULL and
-- populated later by device registration / hardware ingestion.
INSERT INTO public.tags (
    id, tag_id, employee_id, project_id, x, y, battery, last_ts
)
SELECT id, tag_id, employee_id, project_id, x, y, battery, last_ts
FROM supabase_import.tags
ON CONFLICT DO NOTHING;

INSERT INTO public.visits (
    id, visit_key, tag_id, employee_id, project_id, plan_id,
    customer_id, started_at, ended_at, duration_sec, zone, deal_status
)
SELECT
    id, visit_key, tag_id, employee_id, project_id, plan_id,
    customer_id, started_at, ended_at, duration_sec, zone, deal_status
FROM supabase_import.visits
ON CONFLICT DO NOTHING;

INSERT INTO public.notes (
    id, visit_key, user_id, body, created_at, seed_key
)
SELECT id, visit_key, user_id, body, created_at, seed_key
FROM supabase_import.notes
ON CONFLICT DO NOTHING;

INSERT INTO public.positions (id, tag_id, x, y, zone, ts)
SELECT id, tag_id, x, y, zone, ts
FROM supabase_import.positions
ON CONFLICT DO NOTHING;

-- Preserve imported serial/bigserial IDs without causing the next insert to
-- reuse an existing ID.
SELECT setval(
    pg_get_serial_sequence('public.zones', 'id'),
    COALESCE(MAX(id), 1), COUNT(*) > 0
) FROM public.zones;

SELECT setval(
    pg_get_serial_sequence('public.anchors', 'id'),
    COALESCE(MAX(id), 1), COUNT(*) > 0
) FROM public.anchors;

SELECT setval(
    pg_get_serial_sequence('public.tags', 'id'),
    COALESCE(MAX(id), 1), COUNT(*) > 0
) FROM public.tags;

SELECT setval(
    pg_get_serial_sequence('public.visits', 'id'),
    COALESCE(MAX(id), 1), COUNT(*) > 0
) FROM public.visits;

SELECT setval(
    pg_get_serial_sequence('public.notes', 'id'),
    COALESCE(MAX(id), 1), COUNT(*) > 0
) FROM public.notes;

SELECT setval(
    pg_get_serial_sequence('public.positions', 'id'),
    COALESCE(MAX(id), 1), COUNT(*) > 0
) FROM public.positions;

DO $$
BEGIN
    IF to_regclass('supabase_import.plan_objects') IS NOT NULL THEN
        PERFORM setval(
            pg_get_serial_sequence('public.plan_objects', 'id'),
            COALESCE((SELECT MAX(id) FROM public.plan_objects), 1),
            EXISTS (SELECT 1 FROM public.plan_objects)
        );
    END IF;

    IF to_regclass('supabase_import.plan_dimensions') IS NOT NULL THEN
        PERFORM setval(
            pg_get_serial_sequence('public.plan_dimensions', 'id'),
            COALESCE((SELECT MAX(id) FROM public.plan_dimensions), 1),
            EXISTS (SELECT 1 FROM public.plan_dimensions)
        );
    END IF;
END
$$;

-- Row-count summary appears in DBeaver before the transaction commits.
SELECT 'users' AS table_name,
       (SELECT COUNT(*) FROM supabase_import.users) AS source_rows,
       (SELECT COUNT(*) FROM public.users) AS target_rows
UNION ALL
SELECT 'projects',
       (SELECT COUNT(*) FROM supabase_import.projects),
       (SELECT COUNT(*) FROM public.projects)
UNION ALL
SELECT 'zones',
       (SELECT COUNT(*) FROM supabase_import.zones),
       (SELECT COUNT(*) FROM public.zones)
UNION ALL
SELECT 'anchors',
       (SELECT COUNT(*) FROM supabase_import.anchors),
       (SELECT COUNT(*) FROM public.anchors)
UNION ALL
SELECT 'tags',
       (SELECT COUNT(*) FROM supabase_import.tags),
       (SELECT COUNT(*) FROM public.tags)
UNION ALL
SELECT 'positions',
       (SELECT COUNT(*) FROM supabase_import.positions),
       (SELECT COUNT(*) FROM public.positions)
UNION ALL
SELECT 'customers',
       (SELECT COUNT(*) FROM supabase_import.customers),
       (SELECT COUNT(*) FROM public.customers)
UNION ALL
SELECT 'visits',
       (SELECT COUNT(*) FROM supabase_import.visits),
       (SELECT COUNT(*) FROM public.visits)
UNION ALL
SELECT 'notes',
       (SELECT COUNT(*) FROM supabase_import.notes),
       (SELECT COUNT(*) FROM public.notes)
ORDER BY table_name;

COMMIT;

-- After verifying the application, the staging schema may be removed manually:
-- DROP SCHEMA supabase_import CASCADE;
