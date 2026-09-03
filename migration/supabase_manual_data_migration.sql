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
            version, created_at, updated_at, boundary, ceiling_height_m
        )
        SELECT
            p.id, p.project_id, p.name, p.width_m, p.height_m, p.is_active,
            p.version, p.created_at, p.updated_at,
            COALESCE(
                NULLIF(to_jsonb(p) -> 'boundary', 'null'::jsonb),
                jsonb_build_object(
                    'type', 'polygon',
                    'points', jsonb_build_array(
                        jsonb_build_array(0, 0), jsonb_build_array(p.width_m, 0),
                        jsonb_build_array(p.width_m, p.height_m), jsonb_build_array(0, p.height_m)
                    )
                )
            ),
            COALESCE(NULLIF(to_jsonb(p) ->> 'ceiling_height_m', '')::double precision, 3.0)
        FROM supabase_import.plans AS p
        ON CONFLICT DO NOTHING;
    END IF;
END
$$;

-- Hardware gateways are optional in older exports, but must be restored
-- before tags/anchors so their binding foreign keys remain valid.
DO $$
BEGIN
    IF to_regclass('supabase_import.hardware_gateways') IS NOT NULL THEN
        INSERT INTO public.hardware_gateways (
            device_id, project_id, plan_id, description, enabled,
            last_seen, last_message_id, created_at, updated_at
        )
        SELECT
            device_id, project_id, plan_id, description, enabled,
            last_seen, last_message_id, created_at, updated_at
        FROM supabase_import.hardware_gateways
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
    id, project_id, name, x_min, x_max, y_min, y_max, plan_id, geometry,
    zone_type, color, opacity, is_visible, stack_order, updated_at
)
SELECT
    z.id, z.project_id, z.name, z.x_min, z.x_max, z.y_min, z.y_max, z.plan_id, z.geometry,
    COALESCE(NULLIF(to_jsonb(z) ->> 'zone_type', ''), 'general'),
    COALESCE(NULLIF(to_jsonb(z) ->> 'color', ''), '#4F9DDE'),
    COALESCE(NULLIF(to_jsonb(z) ->> 'opacity', '')::double precision, 0.30),
    COALESCE(NULLIF(to_jsonb(z) ->> 'is_visible', '')::boolean, true),
    COALESCE(NULLIF(to_jsonb(z) ->> 'stack_order', '')::integer, 0),
    COALESCE(NULLIF(to_jsonb(z) ->> 'updated_at', '')::timestamptz, now())
FROM supabase_import.zones AS z
ON CONFLICT DO NOTHING;

INSERT INTO public.tags (
    id, tag_id, employee_id, project_id, x, y, battery, last_ts,
    plan_id, z, source, device_id
)
SELECT
    t.id, t.tag_id, t.employee_id, t.project_id, t.x, t.y, t.battery, t.last_ts,
    NULLIF(to_jsonb(t) ->> 'plan_id', ''),
    NULLIF(to_jsonb(t) ->> 'z', '')::double precision,
    NULLIF(to_jsonb(t) ->> 'source', ''),
    NULLIF(to_jsonb(t) ->> 'device_id', '')
FROM supabase_import.tags AS t
ON CONFLICT DO NOTHING;

INSERT INTO public.anchors (
    id, project_id, anchor_id, x, y, battery, last_ts,
    plan_id, z, mount_height_m, hardware_address, mount_type,
    orientation_deg, wall_ref, gateway_device_id, bound_tag_id
)
SELECT
    a.id, a.project_id, a.anchor_id, a.x, a.y, a.battery, a.last_ts, a.plan_id,
    COALESCE(
        NULLIF(to_jsonb(a) ->> 'z', '')::double precision,
        NULLIF(to_jsonb(a) ->> 'mount_height_m', '')::double precision,
        0
    ),
    COALESCE(
        NULLIF(to_jsonb(a) ->> 'mount_height_m', '')::double precision,
        NULLIF(to_jsonb(a) ->> 'z', '')::double precision,
        0
    ),
    NULLIF(to_jsonb(a) ->> 'hardware_address', ''),
    COALESCE(NULLIF(to_jsonb(a) ->> 'mount_type', ''), 'free'),
    COALESCE(NULLIF(to_jsonb(a) ->> 'orientation_deg', '')::double precision, 0),
    NULLIF(to_jsonb(a) -> 'wall_ref', 'null'::jsonb),
    NULLIF(to_jsonb(a) ->> 'gateway_device_id', ''),
    NULLIF(to_jsonb(a) ->> 'bound_tag_id', '')
FROM supabase_import.anchors AS a
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

INSERT INTO public.positions (
    id, tag_id, x, y, zone, ts, project_id, plan_id, z, source,
    residual_m, anchors_used, device_id, message_id
)
SELECT
    p.id, p.tag_id, p.x, p.y, p.zone, p.ts,
    NULLIF(to_jsonb(p) ->> 'project_id', ''),
    NULLIF(to_jsonb(p) ->> 'plan_id', ''),
    NULLIF(to_jsonb(p) ->> 'z', '')::double precision,
    NULLIF(to_jsonb(p) ->> 'source', ''),
    NULLIF(to_jsonb(p) ->> 'residual_m', '')::double precision,
    NULLIF(to_jsonb(p) ->> 'anchors_used', '')::integer,
    NULLIF(to_jsonb(p) ->> 'device_id', ''),
    NULLIF(to_jsonb(p) ->> 'message_id', '')
FROM supabase_import.positions AS p
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
