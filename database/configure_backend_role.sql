-- Run this once as the owner of the application tables (or as a PostgreSQL
-- administrator), not as the restricted FastAPI login.
--
-- Change only this value when the DATABASE_URL username is different.
-- The current UAT backend login is DMI_CusTrack_UAT.

DO $configure_backend_role$
DECLARE
    backend_role name := 'DMI_CusTrack_UAT';
    app_table record;
    app_function record;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = backend_role) THEN
        RAISE EXCEPTION 'PostgreSQL role % does not exist', backend_role;
    END IF;

    -- PostgreSQL commonly grants public-schema USAGE through PUBLIC already.
    -- Avoid a noisy "no privileges were granted" warning when the migration
    -- owner does not own the schema and the backend role can already use it.
    IF NOT has_schema_privilege(backend_role, 'public', 'USAGE') THEN
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', backend_role);
    END IF;
    EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
        backend_role
    );
    EXECUTE format(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',
        backend_role
    );
    -- Grant only functions owned by the account running this script. Using
    -- ALL FUNCTIONS also targets pgcrypto extension functions (digest,
    -- crypt, gen_random_uuid, ...), which produces harmless warnings because
    -- the application table owner does not own those extension functions.
    FOR app_function IN
        SELECT p.oid::regprocedure::text AS function_signature
        FROM pg_proc AS p
        JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    LOOP
        EXECUTE format(
            'GRANT EXECUTE ON FUNCTION %s TO %I',
            app_function.function_signature,
            backend_role
        );
    END LOOP;

    -- Keep Row Level Security enabled for other database users.  FastAPI is
    -- the trusted data boundary and performs its own session and role checks,
    -- so its dedicated role needs a full-access policy on each RLS table.
    FOR app_table IN
        SELECT n.nspname AS schema_name, c.relname AS table_name, c.oid
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind IN ('r', 'p')
          AND c.relrowsecurity
    LOOP
        IF EXISTS (
            SELECT 1
            FROM pg_policy
            WHERE polrelid = app_table.oid
              AND polname = 'uwb_backend_full_access'
        ) THEN
            EXECUTE format(
                'ALTER POLICY uwb_backend_full_access ON %I.%I TO %I '
                'USING (true) WITH CHECK (true)',
                app_table.schema_name,
                app_table.table_name,
                backend_role
            );
        ELSE
            EXECUTE format(
                'CREATE POLICY uwb_backend_full_access ON %I.%I '
                'FOR ALL TO %I USING (true) WITH CHECK (true)',
                app_table.schema_name,
                app_table.table_name,
                backend_role
            );
        END IF;
    END LOOP;

    -- Preserve access for tables and sequences created by later migrations
    -- executed by this same owner role.
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        backend_role
    );
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'GRANT USAGE, SELECT ON SEQUENCES TO %I',
        backend_role
    );
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
        'GRANT EXECUTE ON FUNCTIONS TO %I',
        backend_role
    );
END
$configure_backend_role$;

-- Quick verification. Every boolean should be true.
SELECT
    has_schema_privilege('DMI_CusTrack_UAT', 'public', 'USAGE') AS schema_usage,
    has_table_privilege('DMI_CusTrack_UAT', 'public.users', 'SELECT') AS users_select,
    has_table_privilege('DMI_CusTrack_UAT', 'public.sessions', 'INSERT') AS sessions_insert,
    COALESCE(
        (
            SELECT bool_and(
                has_sequence_privilege('DMI_CusTrack_UAT', c.oid, 'USAGE')
            )
            FROM pg_class AS c
            JOIN pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind = 'S'
        ),
        true
    ) AS sequences_usage;
