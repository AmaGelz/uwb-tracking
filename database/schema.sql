-- =========================================================
-- SUPALAI-UWB — PostgreSQL / Supabase schema
-- =========================================================
-- Run once against your Supabase project (SQL editor, or via
-- migration/migration.py). Safe to re-run: everything uses
-- IF NOT EXISTS / OR REPLACE.
--
-- Design notes
-- - "id" columns on users/projects/customers are short human
--   readable codes (ADMIN001, P001, C001, ...), not UUIDs, to
--   match the employee_id / project_id / customer_id vocabulary
--   already used across the frontend and API contract.
-- - Timestamps are TIMESTAMPTZ (UTC). The API converts to/from
--   epoch seconds at the edge because the frontend works in
--   epoch seconds (new Date(ts * 1000)).
-- - zones/anchors/positions are project-scoped so more than one
--   project can be tracked independently.
-- =========================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------

create table if not exists users (
    id              text primary key,
    employee_id     text unique not null,
    email           text unique not null,
    password_hash   text not null,
    role            text not null default 'sale'
                        check (role in ('admin', 'sale_lead', 'sale')),
    position        text not null default '',
    first_th        text not null default '',
    last_th         text not null default '',
    first_en        text not null default '',
    last_en         text not null default '',
    phone           text not null default '',
    tag_id          text,
    created_at      timestamptz not null default now()
);

create table if not exists sessions (
    token       text primary key,
    user_id     text not null references users(id) on delete cascade,
    expires_at  timestamptz not null
);
create index if not exists idx_sessions_user on sessions(user_id);

-- ---------------------------------------------------------
-- Projects, floor plans, zones, hardware
-- ---------------------------------------------------------

create table if not exists projects (
    id              text primary key,
    name            text not null,
    province        text not null default '',
    plan_id         text not null default '',
    plan_name       text not null default '',
    width_m         double precision not null default 20,
    height_m        double precision not null default 20,
    tracking_mode   text not null default 'simulation'
                        check (tracking_mode in ('hardware', 'simulation', 'disabled')),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ALTER statements keep this canonical schema usable against databases that
-- were created before hybrid hardware/simulation tracking was introduced.
alter table projects
    add column if not exists tracking_mode text not null default 'simulation',
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists updated_at timestamptz not null default now();

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'projects'::regclass
          and conname = 'projects_tracking_mode_check'
    ) then
        alter table projects
            add constraint projects_tracking_mode_check
            check (tracking_mode in ('hardware', 'simulation', 'disabled'));
    end if;
end
$$;

create table if not exists zones (
    id          serial primary key,
    project_id  text not null references projects(id) on delete cascade,
    name        text not null,
    x_min       double precision not null,
    x_max       double precision not null,
    y_min       double precision not null,
    y_max       double precision not null,
    unique (project_id, name)
);
create index if not exists idx_zones_project on zones(project_id);

create table if not exists anchors (
    id          serial primary key,
    project_id  text not null references projects(id) on delete cascade,
    anchor_id   text not null,
    x           double precision not null,
    y           double precision not null,
    battery     double precision,
    last_ts     timestamptz,
    unique (project_id, anchor_id)
);
create index if not exists idx_anchors_project on anchors(project_id);

create table if not exists tags (
    id              serial primary key,
    tag_id          text unique not null,
    hardware_uid    text,
    label           text not null default '',
    tag_type        text not null default 'mock'
                        check (tag_type in ('physical', 'mock')),
    status          text not null default 'active'
                        check (status in ('active', 'disabled')),
    employee_id     text references users(employee_id),
    project_id      text references projects(id),
    x               double precision,
    y               double precision,
    battery         double precision,
    last_ts         timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

alter table tags
    add column if not exists hardware_uid text,
    add column if not exists label text not null default '',
    add column if not exists tag_type text not null default 'mock',
    add column if not exists status text not null default 'active',
    add column if not exists created_at timestamptz not null default now(),
    add column if not exists updated_at timestamptz not null default now();

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'tags'::regclass
          and conname = 'tags_tag_type_check'
    ) then
        alter table tags
            add constraint tags_tag_type_check
            check (tag_type in ('physical', 'mock'));
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid = 'tags'::regclass
          and conname = 'tags_status_check'
    ) then
        alter table tags
            add constraint tags_status_check
            check (status in ('active', 'disabled'));
    end if;
end
$$;

create unique index if not exists idx_tags_hardware_uid
    on tags(hardware_uid)
    where hardware_uid is not null;
create index if not exists idx_tags_project_status on tags(project_id, status);
create index if not exists idx_tags_type_status on tags(tag_type, status);

-- A project can have any number of active tags. The partial unique index only
-- limits each individual tag to one active project assignment at a time.
create table if not exists tag_assignments (
    id              bigserial primary key,
    tag_id          text not null references tags(tag_id) on delete cascade,
    project_id      text not null references projects(id),
    employee_id     text references users(employee_id) on delete set null,
    assigned_at     timestamptz not null default now(),
    ended_at        timestamptz,
    assigned_by     text references users(id) on delete set null,
    created_at      timestamptz not null default now(),
    check (ended_at is null or ended_at >= assigned_at)
);
create unique index if not exists idx_tag_assignments_one_active_tag
    on tag_assignments(tag_id)
    where ended_at is null;
create index if not exists idx_tag_assignments_project_active
    on tag_assignments(project_id, tag_id)
    where ended_at is null;
create index if not exists idx_tag_assignments_employee_active
    on tag_assignments(employee_id, tag_id)
    where ended_at is null;

-- Backfill legacy tags exactly once. Checking for any history (rather than
-- merely an active row) prevents a later schema re-run from resurrecting an
-- assignment that an administrator intentionally ended.
insert into tag_assignments (tag_id, project_id, employee_id, assigned_at)
select t.tag_id, t.project_id, t.employee_id, coalesce(t.created_at, t.last_ts, now())
from tags t
where t.project_id is not null
  and not exists (
      select 1 from tag_assignments assignment
      where assignment.tag_id = t.tag_id
  );

-- Gateway secrets are never stored directly. key_hash is the hexadecimal
-- SHA-256 digest used to authenticate a gateway scoped to one project.
create table if not exists gateway_credentials (
    gateway_id     text primary key,
    project_id     text not null references projects(id),
    key_hash       text not null,
    status         text not null default 'active'
                       check (status in ('active', 'revoked')),
    last_seen_at   timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    check (key_hash ~ '^[0-9A-Fa-f]{64}$')
);
create index if not exists idx_gateway_credentials_project_status
    on gateway_credentials(project_id, status);

-- ---------------------------------------------------------
-- Live/raw positioning
-- ---------------------------------------------------------

create table if not exists positions (
    id              bigserial primary key,
    gateway_id      text,
    message_id      text,
    tag_id          text not null,
    project_id      text,
    plan_id         text,
    source          text not null default 'simulator'
                        check (source in ('hardware', 'simulator')),
    device_ts       timestamptz,
    x               double precision not null,
    y               double precision not null,
    zone            text,
    residual_m      double precision check (residual_m is null or residual_m >= 0),
    anchors_used    integer check (anchors_used is null or anchors_used >= 0),
    ts              timestamptz not null default now()
);

alter table positions
    add column if not exists gateway_id text,
    add column if not exists message_id text,
    add column if not exists project_id text,
    add column if not exists plan_id text,
    add column if not exists source text,
    add column if not exists device_ts timestamptz,
    add column if not exists residual_m double precision,
    add column if not exists anchors_used integer;

-- Recover project/plan/source metadata for rows written by the legacy API.
-- One pass, not four: on Supabase this table is REPLICA IDENTITY FULL and
-- published to Realtime, so each UPDATE ships both tuples to WAL and repeated
-- passes rewrite every row again. Plan comes from the tag's project so the
-- whole recovery stays a single statement.
update positions pos
set project_id = coalesce(pos.project_id, tag.project_id),
    plan_id    = coalesce(pos.plan_id, project.plan_id),
    source     = coalesce(pos.source, case
                     when tag.tag_type = 'physical' then 'hardware'
                     else 'simulator'
                 end),
    device_ts  = coalesce(pos.device_ts, pos.ts)
from tags tag
left join projects project on project.id = tag.project_id
where pos.tag_id = tag.tag_id
  and (pos.project_id is null or pos.plan_id is null
       or pos.source is null or pos.device_ts is null);

-- Rows whose tag has since been deleted predate hardware support entirely,
-- so they are simulator history.
update positions
set source    = coalesce(source, 'simulator'),
    device_ts = coalesce(device_ts, ts)
where source is null or device_ts is null;

-- Default 'simulator', not 'hardware': every writer aware of hardware sets
-- source explicitly, so the default is only ever reached by older code paths,
-- all of which are simulated.
alter table positions
    alter column source set default 'simulator',
    alter column source set not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'positions'::regclass
          and conname = 'positions_source_check'
    ) then
        alter table positions
            add constraint positions_source_check
            check (source in ('hardware', 'simulator'));
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid = 'positions'::regclass
          and conname = 'positions_residual_m_check'
    ) then
        alter table positions
            add constraint positions_residual_m_check
            check (residual_m is null or residual_m >= 0);
    end if;

    if not exists (
        select 1 from pg_constraint
        where conrelid = 'positions'::regclass
          and conname = 'positions_anchors_used_check'
    ) then
        alter table positions
            add constraint positions_anchors_used_check
            check (anchors_used is null or anchors_used >= 0);
    end if;
end
$$;

create index if not exists idx_positions_tag_ts on positions(tag_id, ts desc);
create index if not exists idx_positions_project_ts on positions(project_id, ts desc);
create unique index if not exists idx_positions_gateway_message
    on positions(gateway_id, message_id)
    where message_id is not null;

-- ---------------------------------------------------------
-- CRM: customers, visits, notes
-- ---------------------------------------------------------

create table if not exists customers (
    id      text primary key,
    name    text not null
);

create table if not exists visits (
    id              serial primary key,
    visit_key       text unique not null,
    tag_id          text not null,
    employee_id     text,
    project_id      text,
    plan_id         text,
    customer_id     text,
    started_at      timestamptz not null,
    ended_at        timestamptz,
    duration_sec    integer default 0,
    zone            text,
    deal_status     text default '',
    source          text not null default 'simulator'
                        check (source in ('hardware', 'simulator'))
);

alter table visits
    add column if not exists source text;

-- Historical rows came from the original simulator unless their registered
-- tag has explicitly been classified as physical.
update visits visit
set source = case
    when tag.tag_type = 'physical' then 'hardware'
    else 'simulator'
end
from tags tag
where visit.source is null
  and visit.tag_id = tag.tag_id;

-- Same as positions: a visit whose tag is gone predates hardware support.
update visits set source = 'simulator' where source is null;

alter table visits
    alter column source set default 'simulator',
    alter column source set not null;

do $$
begin
    if not exists (
        select 1 from pg_constraint
        where conrelid = 'visits'::regclass
          and conname = 'visits_source_check'
    ) then
        alter table visits
            add constraint visits_source_check
            check (source in ('hardware', 'simulator'));
    end if;
end
$$;

create index if not exists idx_visits_started on visits(started_at desc);
create index if not exists idx_visits_employee on visits(employee_id);
create index if not exists idx_visits_project on visits(project_id);
create index if not exists idx_visits_open on visits(tag_id) where ended_at is null;

-- Fresh databases get a database-level guarantee against duplicate open
-- visits. For an upgraded database with pre-existing duplicates, retain all
-- rows and emit a warning so the duplicates can be reviewed before adding the
-- constraint manually.
do $$
begin
    if to_regclass('idx_visits_one_open_per_tag') is null then
        if not exists (
            select 1
            from visits
            where ended_at is null
            group by tag_id
            having count(*) > 1
        ) then
            create unique index idx_visits_one_open_per_tag
                on visits(tag_id)
                where ended_at is null;
        else
            raise warning 'Not creating idx_visits_one_open_per_tag: duplicate open visits exist';
        end if;
    end if;
end
$$;

create table if not exists notes (
    id          serial primary key,
    visit_key   text not null references visits(visit_key) on delete cascade,
    user_id     text not null,
    body        text not null,
    created_at  timestamptz not null default now(),
    -- Set only by database/seed.sql (as 'SEED-NOTE-<n>') so re-running the
    -- seed script is idempotent. Real notes created through POST /api/note
    -- leave this NULL, and Postgres treats NULLs as distinct for uniqueness
    -- purposes, so it never collides with user-authored notes.
    seed_key    text unique
);
create index if not exists idx_notes_visit on notes(visit_key);

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
-- Row Level Security
-- ---------------------------------------------------------
-- The API talks to Postgres with a direct connection (service-role
-- level access — see backend/.env), which bypasses RLS by design:
-- all access control (who can see whose visits, who can edit) is
-- enforced in backend/backend/main.py. RLS is enabled with no
-- policies attached, so if anyone ever points supabase-js's
-- anon/authenticated client at this project directly, every table
-- here returns zero rows instead of leaking data.
-- ---------------------------------------------------------

alter table users     enable row level security;
alter table sessions  enable row level security;
alter table projects  enable row level security;
alter table zones     enable row level security;
alter table anchors   enable row level security;
alter table tags      enable row level security;
alter table tag_assignments enable row level security;
alter table gateway_credentials enable row level security;
alter table positions enable row level security;
alter table customers enable row level security;
alter table visits    enable row level security;
alter table notes     enable row level security;
