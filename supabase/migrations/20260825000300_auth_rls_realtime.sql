BEGIN;

-- Link the existing application profile to Supabase Auth without replacing the
-- legacy text primary key used by visits, notes, tags, and historical exports.
ALTER TABLE public.users
    ADD COLUMN IF NOT EXISTS auth_user_id uuid;

ALTER TABLE public.users
    ALTER COLUMN password_hash SET DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_user_id
    ON public.users(auth_user_id)
    WHERE auth_user_id IS NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND conname = 'users_auth_user_id_fkey'
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_auth_user_id_fkey
            FOREIGN KEY (auth_user_id)
            REFERENCES auth.users(id)
            ON DELETE SET NULL;
    END IF;
END
$$;

-- Existing profiles are linked by normalized email. No profile row or legacy
-- password hash is deleted during the migration.
UPDATE public.users AS profile
SET auth_user_id = account.id
FROM auth.users AS account
WHERE profile.auth_user_id IS NULL
  AND account.email IS NOT NULL
  AND lower(profile.email) = lower(account.email);

CREATE OR REPLACE FUNCTION public.handle_auth_user_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
    generated_id text;
    requested_role text;
BEGIN
    IF NEW.email IS NULL THEN
        RETURN NEW;
    END IF;

    UPDATE public.users
    SET auth_user_id = NEW.id,
        email = lower(NEW.email)
    WHERE lower(email) = lower(NEW.email);

    IF FOUND THEN
        RETURN NEW;
    END IF;

    generated_id := COALESCE(
        NULLIF(BTRIM(NEW.raw_user_meta_data ->> 'employee_id'), ''),
        'AUTH-' || upper(substr(NEW.id::text, 1, 8))
    );
    requested_role := CASE
        WHEN NEW.raw_user_meta_data ->> 'role' IN ('admin', 'sale_lead', 'sale')
            THEN NEW.raw_user_meta_data ->> 'role'
        ELSE 'sale'
    END;

    INSERT INTO public.users (
        id,
        employee_id,
        email,
        password_hash,
        role,
        position,
        first_th,
        last_th,
        first_en,
        last_en,
        phone,
        auth_user_id
    ) VALUES (
        generated_id,
        generated_id,
        lower(NEW.email),
        '',
        requested_role,
        COALESCE(NEW.raw_user_meta_data ->> 'position', ''),
        COALESCE(NEW.raw_user_meta_data ->> 'first_th', ''),
        COALESCE(NEW.raw_user_meta_data ->> 'last_th', ''),
        COALESCE(NEW.raw_user_meta_data ->> 'first_en', ''),
        COALESCE(NEW.raw_user_meta_data ->> 'last_en', ''),
        COALESCE(NEW.phone, ''),
        NEW.id
    )
    ON CONFLICT (email) DO UPDATE
    SET auth_user_id = EXCLUDED.auth_user_id;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_profile ON auth.users;
CREATE TRIGGER on_auth_user_profile
AFTER INSERT OR UPDATE OF email ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_auth_user_profile();

-- SECURITY DEFINER helpers keep RLS policies non-recursive while returning
-- only the authorization attributes needed by policies and Edge Functions.
CREATE OR REPLACE FUNCTION public.current_app_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
    SELECT role
    FROM public.users
    WHERE auth_user_id = auth.uid()
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_employee_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
    SELECT employee_id
    FROM public.users
    WHERE auth_user_id = auth.uid()
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_app_user_id()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
    SELECT id
    FROM public.users
    WHERE auth_user_id = auth.uid()
    LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.handle_auth_user_profile() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_app_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_employee_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.current_app_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_app_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_employee_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_app_user_id() TO authenticated;

-- Recreate only policies owned by this migration so it remains safe to rerun.
DROP POLICY IF EXISTS users_read_scoped ON public.users;
CREATE POLICY users_read_scoped ON public.users
FOR SELECT TO authenticated
USING (
    auth_user_id = auth.uid()
    OR public.current_app_role() IN ('admin', 'sale_lead')
);

DROP POLICY IF EXISTS projects_read_authenticated ON public.projects;
CREATE POLICY projects_read_authenticated ON public.projects
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS projects_write_admin ON public.projects;
CREATE POLICY projects_write_admin ON public.projects
FOR ALL TO authenticated
USING (public.current_app_role() = 'admin')
WITH CHECK (public.current_app_role() = 'admin');

DROP POLICY IF EXISTS plans_read_authenticated ON public.plans;
CREATE POLICY plans_read_authenticated ON public.plans
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS plans_write_admin ON public.plans;
CREATE POLICY plans_write_admin ON public.plans
FOR ALL TO authenticated
USING (public.current_app_role() = 'admin')
WITH CHECK (public.current_app_role() = 'admin');

DROP POLICY IF EXISTS plan_objects_read_authenticated ON public.plan_objects;
CREATE POLICY plan_objects_read_authenticated ON public.plan_objects
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS plan_objects_write_admin ON public.plan_objects;
CREATE POLICY plan_objects_write_admin ON public.plan_objects
FOR ALL TO authenticated
USING (public.current_app_role() = 'admin')
WITH CHECK (public.current_app_role() = 'admin');

DROP POLICY IF EXISTS plan_dimensions_read_authenticated ON public.plan_dimensions;
CREATE POLICY plan_dimensions_read_authenticated ON public.plan_dimensions
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS plan_dimensions_write_admin ON public.plan_dimensions;
CREATE POLICY plan_dimensions_write_admin ON public.plan_dimensions
FOR ALL TO authenticated
USING (public.current_app_role() = 'admin')
WITH CHECK (public.current_app_role() = 'admin');

DROP POLICY IF EXISTS zones_read_authenticated ON public.zones;
CREATE POLICY zones_read_authenticated ON public.zones
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS zones_write_admin ON public.zones;
CREATE POLICY zones_write_admin ON public.zones
FOR ALL TO authenticated
USING (public.current_app_role() = 'admin')
WITH CHECK (public.current_app_role() = 'admin');

DROP POLICY IF EXISTS anchors_read_authenticated ON public.anchors;
CREATE POLICY anchors_read_authenticated ON public.anchors
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS anchors_write_admin ON public.anchors;
CREATE POLICY anchors_write_admin ON public.anchors
FOR ALL TO authenticated
USING (public.current_app_role() = 'admin')
WITH CHECK (public.current_app_role() = 'admin');

DROP POLICY IF EXISTS tags_read_authenticated ON public.tags;
CREATE POLICY tags_read_authenticated ON public.tags
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS positions_read_authenticated ON public.positions;
CREATE POLICY positions_read_authenticated ON public.positions
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS customers_read_authenticated ON public.customers;
CREATE POLICY customers_read_authenticated ON public.customers
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

DROP POLICY IF EXISTS visits_read_scoped ON public.visits;
CREATE POLICY visits_read_scoped ON public.visits
FOR SELECT TO authenticated
USING (
    public.current_app_role() IN ('admin', 'sale_lead')
    OR employee_id = public.current_employee_id()
);

DROP POLICY IF EXISTS visits_update_lead ON public.visits;
CREATE POLICY visits_update_lead ON public.visits
FOR UPDATE TO authenticated
USING (public.current_app_role() IN ('admin', 'sale_lead'))
WITH CHECK (public.current_app_role() IN ('admin', 'sale_lead'));

DROP POLICY IF EXISTS notes_read_scoped ON public.notes;
CREATE POLICY notes_read_scoped ON public.notes
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.visits
        WHERE visits.visit_key = notes.visit_key
    )
);

DROP POLICY IF EXISTS notes_insert_scoped ON public.notes;
CREATE POLICY notes_insert_scoped ON public.notes
FOR INSERT TO authenticated
WITH CHECK (
    user_id = public.current_app_user_id()
    AND EXISTS (
        SELECT 1
        FROM public.visits
        WHERE visits.visit_key = notes.visit_key
    )
);

-- Explicit grants are required by current Supabase projects before RLS can be
-- evaluated through the Data API.
GRANT USAGE ON SCHEMA public TO authenticated;
REVOKE ALL ON public.users FROM anon, authenticated;
GRANT SELECT (
    id, employee_id, email, role, position, first_th, last_th,
    first_en, last_en, phone, tag_id, created_at, auth_user_id
) ON public.users TO authenticated;

GRANT SELECT ON
    public.projects,
    public.plans,
    public.plan_objects,
    public.plan_dimensions,
    public.zones,
    public.anchors,
    public.tags,
    public.positions,
    public.customers,
    public.visits,
    public.notes
TO authenticated;

GRANT INSERT, UPDATE, DELETE ON
    public.projects,
    public.plans,
    public.plan_objects,
    public.plan_dimensions,
    public.zones,
    public.anchors
TO authenticated;
GRANT UPDATE ON public.visits TO authenticated;
GRANT INSERT ON public.notes TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

-- Realtime replaces the custom /ws/live fan-out in production. Both inserts
-- into positions and updates to the current tag snapshot are published.
ALTER TABLE public.positions REPLICA IDENTITY FULL;
ALTER TABLE public.tags REPLICA IDENTITY FULL;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'positions'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.positions;
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'tags'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.tags;
        END IF;
    END IF;
END
$$;

COMMIT;
