BEGIN;

-- Hybrid hardware/simulation tracking.
--
-- database/schema.sql is the canonical schema for a fresh local Postgres.
-- This migration applies the same changes to the linked Supabase project,
-- where tables already hold production rows, so every statement is written to
-- be idempotent and non-destructive: no row is deleted, and legacy
-- projects/tags keep working while they are being classified.

-- ---------------------------------------------------------
-- Projects gain an explicit tracking mode
-- ---------------------------------------------------------

ALTER TABLE public.projects
    ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'simulation',
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.projects'::regclass
          AND conname = 'projects_tracking_mode_check'
    ) THEN
        ALTER TABLE public.projects
            ADD CONSTRAINT projects_tracking_mode_check
            CHECK (tracking_mode IN ('hardware', 'simulation', 'disabled'));
    END IF;
END
$$;

-- ---------------------------------------------------------
-- Tag registry: physical hardware vs. simulated demo tags
-- ---------------------------------------------------------

ALTER TABLE public.tags
    ADD COLUMN IF NOT EXISTS hardware_uid text,
    ADD COLUMN IF NOT EXISTS label text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS tag_type text NOT NULL DEFAULT 'mock',
    ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass
          AND conname = 'tags_tag_type_check'
    ) THEN
        ALTER TABLE public.tags
            ADD CONSTRAINT tags_tag_type_check
            CHECK (tag_type IN ('physical', 'mock'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.tags'::regclass
          AND conname = 'tags_status_check'
    ) THEN
        ALTER TABLE public.tags
            ADD CONSTRAINT tags_status_check
            CHECK (status IN ('active', 'disabled'));
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_hardware_uid
    ON public.tags(hardware_uid)
    WHERE hardware_uid IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tags_project_status ON public.tags(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tags_type_status ON public.tags(tag_type, status);

-- ---------------------------------------------------------
-- Assignment history (which tag was at which project, for whom)
-- ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.tag_assignments (
    id              bigserial PRIMARY KEY,
    tag_id          text NOT NULL REFERENCES public.tags(tag_id) ON DELETE CASCADE,
    project_id      text NOT NULL REFERENCES public.projects(id),
    employee_id     text REFERENCES public.users(employee_id) ON DELETE SET NULL,
    assigned_at     timestamptz NOT NULL DEFAULT now(),
    ended_at        timestamptz,
    assigned_by     text REFERENCES public.users(id) ON DELETE SET NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_assignments_one_active_tag
    ON public.tag_assignments(tag_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tag_assignments_project_active
    ON public.tag_assignments(project_id, tag_id)
    WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tag_assignments_employee_active
    ON public.tag_assignments(employee_id, tag_id)
    WHERE ended_at IS NULL;

-- Backfill legacy tags exactly once. Checking for any history (rather than
-- merely an active row) prevents a rerun from resurrecting an assignment that
-- an administrator intentionally ended.
INSERT INTO public.tag_assignments (tag_id, project_id, employee_id, assigned_at)
SELECT tag.tag_id, tag.project_id, tag.employee_id, coalesce(tag.created_at, tag.last_ts, now())
FROM public.tags tag
WHERE tag.project_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.tag_assignments assignment
      WHERE assignment.tag_id = tag.tag_id
  );

-- ---------------------------------------------------------
-- Gateway credentials (hardware ingest authentication)
-- ---------------------------------------------------------
-- Gateway secrets are never stored directly. key_hash is the hexadecimal
-- SHA-256 digest used to authenticate a gateway scoped to one project.

CREATE TABLE IF NOT EXISTS public.gateway_credentials (
    gateway_id     text PRIMARY KEY,
    project_id     text NOT NULL REFERENCES public.projects(id),
    key_hash       text NOT NULL,
    status         text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked')),
    last_seen_at   timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CHECK (key_hash ~ '^[0-9A-Fa-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_gateway_credentials_project_status
    ON public.gateway_credentials(project_id, status);

-- ---------------------------------------------------------
-- Positions carry their origin, gateway and idempotency key
-- ---------------------------------------------------------

ALTER TABLE public.positions
    ADD COLUMN IF NOT EXISTS gateway_id text,
    ADD COLUMN IF NOT EXISTS message_id text,
    ADD COLUMN IF NOT EXISTS project_id text,
    ADD COLUMN IF NOT EXISTS plan_id text,
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS device_ts timestamptz,
    ADD COLUMN IF NOT EXISTS residual_m double precision,
    ADD COLUMN IF NOT EXISTS anchors_used integer;

-- Recover project/plan/source metadata for rows written by the legacy API.
--
-- Done in a single pass on purpose. `positions` is REPLICA IDENTITY FULL and a
-- member of the supabase_realtime publication (see …000300), so every UPDATE
-- writes both the old and the new tuple to WAL for Realtime to decode. Four
-- sequential passes over a large table would rewrite every row four times,
-- bloating the table and flooding the replication slot inside a single
-- transaction. Plan comes from the tag's project rather than from the row's
-- freshly written project_id so the whole thing stays one statement.
UPDATE public.positions pos
SET project_id = COALESCE(pos.project_id, tag.project_id),
    plan_id    = COALESCE(pos.plan_id, project.plan_id),
    source     = COALESCE(pos.source, CASE
                     WHEN tag.tag_type = 'physical' THEN 'hardware'
                     ELSE 'simulator'
                 END),
    device_ts  = COALESCE(pos.device_ts, pos.ts)
FROM public.tags tag
LEFT JOIN public.projects project ON project.id = tag.project_id
WHERE pos.tag_id = tag.tag_id
  AND (pos.project_id IS NULL OR pos.plan_id IS NULL
       OR pos.source IS NULL OR pos.device_ts IS NULL);

-- Rows whose tag has since been deleted keep no project, and predate hardware
-- support entirely, so they are simulator history.
UPDATE public.positions
SET source    = COALESCE(source, 'simulator'),
    device_ts = COALESCE(device_ts, ts)
WHERE source IS NULL OR device_ts IS NULL;

-- Default 'simulator', not 'hardware': every writer that knows about hardware
-- sets source explicitly (the RPC writes 'hardware', the mock path and the
-- FastAPI ingest write theirs). The only writers that fall back to the default
-- are the previously deployed API, FastAPI and its simulator — which is
-- exactly the traffic arriving between this migration and the function deploy.
ALTER TABLE public.positions
    ALTER COLUMN source SET DEFAULT 'simulator',
    ALTER COLUMN source SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.positions'::regclass
          AND conname = 'positions_source_check'
    ) THEN
        ALTER TABLE public.positions
            ADD CONSTRAINT positions_source_check
            CHECK (source IN ('hardware', 'simulator'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.positions'::regclass
          AND conname = 'positions_residual_m_check'
    ) THEN
        ALTER TABLE public.positions
            ADD CONSTRAINT positions_residual_m_check
            CHECK (residual_m IS NULL OR residual_m >= 0);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.positions'::regclass
          AND conname = 'positions_anchors_used_check'
    ) THEN
        ALTER TABLE public.positions
            ADD CONSTRAINT positions_anchors_used_check
            CHECK (anchors_used IS NULL OR anchors_used >= 0);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_positions_project_ts ON public.positions(project_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_gateway_message
    ON public.positions(gateway_id, message_id)
    WHERE message_id IS NOT NULL;

-- ---------------------------------------------------------
-- Visits record whether they came from hardware or the simulator
-- ---------------------------------------------------------

ALTER TABLE public.visits
    ADD COLUMN IF NOT EXISTS source text;

-- Historical rows came from the original simulator unless their registered
-- tag has explicitly been classified as physical.
UPDATE public.visits visit
SET source = CASE
    WHEN tag.tag_type = 'physical' THEN 'hardware'
    ELSE 'simulator'
END
FROM public.tags tag
WHERE visit.source IS NULL
  AND visit.tag_id = tag.tag_id;

-- Same as positions: a visit whose tag is gone predates hardware support.
UPDATE public.visits SET source = 'simulator' WHERE source IS NULL;

ALTER TABLE public.visits
    ALTER COLUMN source SET DEFAULT 'simulator',
    ALTER COLUMN source SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.visits'::regclass
          AND conname = 'visits_source_check'
    ) THEN
        ALTER TABLE public.visits
            ADD CONSTRAINT visits_source_check
            CHECK (source IN ('hardware', 'simulator'));
    END IF;
END
$$;

-- Only add the one-open-visit guarantee when the existing data already
-- satisfies it. Duplicates are kept and reported instead of being merged.
DO $$
BEGIN
    IF to_regclass('public.idx_visits_one_open_per_tag') IS NULL THEN
        IF NOT EXISTS (
            SELECT 1
            FROM public.visits
            WHERE ended_at IS NULL
            GROUP BY tag_id
            HAVING count(*) > 1
        ) THEN
            CREATE UNIQUE INDEX idx_visits_one_open_per_tag
                ON public.visits(tag_id)
                WHERE ended_at IS NULL;
        ELSE
            RAISE WARNING 'Not creating idx_visits_one_open_per_tag: duplicate open visits exist';
        END IF;
    END IF;
END
$$;

-- ---------------------------------------------------------
-- Audit timestamps and atomic hardware ingestion
-- ---------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    new.updated_at := now();
    return new;
end;
$$;

drop trigger if exists projects_set_updated_at on projects;
create trigger projects_set_updated_at
before update on projects
for each row execute function public.set_updated_at();

drop trigger if exists tags_set_updated_at on tags;
create trigger tags_set_updated_at
before update on tags
for each row execute function public.set_updated_at();

drop trigger if exists gateway_credentials_set_updated_at on gateway_credentials;
create trigger gateway_credentials_set_updated_at
before update on gateway_credentials
for each row execute function public.set_updated_at();

-- This RPC is called only after the Edge ingest endpoint verifies the signed
-- gateway request. It repeats the authoritative database checks and writes a
-- position, tag snapshot and visit atomically. A repeated gateway/message pair
-- returns the existing position without changing snapshot or visit state.
create or replace function public.ingest_uwb_fix(
    p_gateway_id     text,
    p_message_id     text,
    p_tag_id         text,
    p_project_id     text,
    p_plan_id        text,
    p_device_ts      timestamptz,
    p_x              double precision,
    p_y              double precision,
    p_zone           text,
    p_battery        double precision,
    p_residual_m     double precision,
    p_anchors_used   integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_tag_type       text;
    v_tag_status     text;
    v_tracking_mode  text;
    v_employee_id    text;
    v_position_id    bigint;
    v_visit_key      text;
begin
    if nullif(btrim(p_gateway_id), '') is null then
        raise exception 'gateway_id is required';
    end if;
    if nullif(btrim(p_message_id), '') is null then
        raise exception 'message_id is required';
    end if;
    if nullif(btrim(p_tag_id), '') is null then
        raise exception 'tag_id is required';
    end if;
    if nullif(btrim(p_project_id), '') is null then
        raise exception 'project_id is required';
    end if;
    if p_device_ts is null then
        raise exception 'device_ts is required';
    end if;
    if p_x is null or p_y is null then
        raise exception 'x and y are required';
    end if;

    if not exists (
        select 1
        from gateway_credentials gateway
        where gateway.gateway_id = p_gateway_id
          and gateway.project_id = p_project_id
          and gateway.status = 'active'
    ) then
        raise exception 'gateway % is not active for project %', p_gateway_id, p_project_id;
    end if;

    select tag.tag_type, tag.status
    into v_tag_type, v_tag_status
    from tags tag
    where tag.tag_id = p_tag_id
    for update;

    if not found then
        raise exception 'tag % is not registered', p_tag_id;
    end if;
    if v_tag_status <> 'active' then
        raise exception 'tag % is disabled', p_tag_id;
    end if;
    if v_tag_type <> 'physical' then
        raise exception 'tag % is not a physical tag', p_tag_id;
    end if;

    select project.tracking_mode
    into v_tracking_mode
    from projects project
    where project.id = p_project_id;

    if not found then
        raise exception 'project % does not exist', p_project_id;
    end if;
    if v_tracking_mode <> 'hardware' then
        raise exception 'project % is not in hardware mode', p_project_id;
    end if;

    select assignment.employee_id
    into v_employee_id
    from tag_assignments assignment
    where assignment.tag_id = p_tag_id
      and assignment.project_id = p_project_id
      and assignment.ended_at is null
    order by assignment.assigned_at desc
    limit 1;

    if not found then
        raise exception 'tag % has no active assignment for project %', p_tag_id, p_project_id;
    end if;

    insert into positions (
        gateway_id, message_id, tag_id, project_id, plan_id, source,
        device_ts, x, y, zone, residual_m, anchors_used, ts
    ) values (
        p_gateway_id, p_message_id, p_tag_id, p_project_id, p_plan_id, 'hardware',
        p_device_ts, p_x, p_y, p_zone, p_residual_m, p_anchors_used, p_device_ts
    )
    on conflict do nothing
    returning id into v_position_id;

    if v_position_id is null then
        select position.id
        into v_position_id
        from positions position
        where position.gateway_id = p_gateway_id
          and position.message_id = p_message_id
        limit 1;

        return jsonb_build_object(
            'inserted', false,
            'duplicate', true,
            'position_id', v_position_id,
            'visit_key', null
        );
    end if;

    update tags tag
    set x = p_x,
        y = p_y,
        battery = coalesce(p_battery, tag.battery),
        last_ts = p_device_ts,
        updated_at = now()
    where tag.tag_id = p_tag_id
      and (tag.last_ts is null or tag.last_ts <= p_device_ts);

    update gateway_credentials gateway
    set last_seen_at = case
            when gateway.last_seen_at is null then p_device_ts
            else greatest(gateway.last_seen_at, p_device_ts)
        end,
        updated_at = now()
    where gateway.gateway_id = p_gateway_id;

    select visit.visit_key
    into v_visit_key
    from visits visit
    where visit.tag_id = p_tag_id
      and visit.ended_at is null
    order by visit.started_at desc
    limit 1;

    if not found then
        v_visit_key := 'V-' || floor(extract(epoch from clock_timestamp()))::bigint::text
            || '-' || p_tag_id || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);

        begin
            insert into visits (
                visit_key, tag_id, employee_id, project_id, plan_id,
                started_at, zone, deal_status, source
            ) values (
                v_visit_key, p_tag_id, v_employee_id, p_project_id, p_plan_id,
                p_device_ts, p_zone, '', 'hardware'
            );
        exception when unique_violation then
            select visit.visit_key
            into v_visit_key
            from visits visit
            where visit.tag_id = p_tag_id
              and visit.ended_at is null
            order by visit.started_at desc
            limit 1;

            if not found then
                raise;
            end if;
        end;
    end if;

    return jsonb_build_object(
        'inserted', true,
        'duplicate', false,
        'position_id', v_position_id,
        'visit_key', v_visit_key
    );
end;
$$;

revoke all on function public.ingest_uwb_fix(
    text, text, text, text, text, timestamptz,
    double precision, double precision, text, double precision,
    double precision, integer
) from public;

do $$
begin
    if exists (select 1 from pg_roles where rolname = 'service_role') then
        execute 'grant execute on function public.ingest_uwb_fix(text, text, text, text, text, timestamptz, double precision, double precision, text, double precision, double precision, integer) to service_role';
    end if;
end
$$;


-- ---------------------------------------------------------
-- Row Level Security for the new tables
-- ---------------------------------------------------------
-- Consistent with the existing tables: RLS is on, and only the tables the
-- dashboard reads through supabase-js get a policy. tag_assignments is
-- readable by any signed-in user (the dashboard resolves who holds a tag);
-- gateway_credentials gets no policy at all, so its key hashes are reachable
-- only through the service-role credential held by the Edge Functions.

ALTER TABLE public.tag_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gateway_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tag_assignments_read_authenticated ON public.tag_assignments;
CREATE POLICY tag_assignments_read_authenticated ON public.tag_assignments
FOR SELECT TO authenticated USING (auth.uid() IS NOT NULL);

-- A policy alone is not enough: …000300 grants table privileges one table at a
-- time ("Explicit grants are required by current Supabase projects before RLS
-- can be evaluated through the Data API"), and its ALL SEQUENCES grant ran
-- before this table existed. Without the grant below the policy above is dead
-- code. gateway_credentials is deliberately left ungranted to authenticated —
-- no policy, no privilege, so key hashes stay service-role-only.
GRANT SELECT ON public.tag_assignments TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.tag_assignments_id_seq TO authenticated;

-- service_role reaches migration-created tables through this project's default
-- privileges (the deployed api function already relies on that for the tables
-- from …000100). Granting explicitly is redundant there but costs nothing, and
-- it keeps a project whose defaults do not auto-expose new tables from failing
-- every gateway route with "permission denied".
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.tag_assignments, public.gateway_credentials TO service_role';
        EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE public.tag_assignments_id_seq TO service_role';
    END IF;
END
$$;

COMMIT;
