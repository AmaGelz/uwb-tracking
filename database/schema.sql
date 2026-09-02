-- =========================================================
-- SUPALAI-UWB — PostgreSQL schema
-- =========================================================
-- Apply with migration/migration.py. Safe to re-run: everything uses
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

-- PostgreSQL 13+ provides gen_random_uuid() in core. Avoid requiring the
-- pgcrypto extension because managed Azure servers may not allow-list it.

-- ---------------------------------------------------------
-- Identity & access
-- ---------------------------------------------------------

create table if not exists users (
    id              text primary key,
    employee_id     text unique not null,
    email           text unique not null,
    password_hash   text,
    google_sub      text,
    account_status  text not null default 'active'
                        check (account_status in ('pending', 'active', 'disabled')),
    activated_at    timestamptz,
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
-- The google_sub index is created by migration 004. Keeping it there is
-- important for existing databases: CREATE TABLE IF NOT EXISTS above does not
-- add google_sub to an already-existing users table, so indexing it here would
-- fail before the migration gets a chance to add the column.

create table if not exists sessions (
    token       text primary key,
    user_id     text not null references users(id) on delete cascade,
    expires_at  timestamptz not null
);
create index if not exists idx_sessions_user on sessions(user_id);

create table if not exists password_reset_tokens (
    token_hash  text primary key,
    user_id     text not null references users(id) on delete cascade,
    expires_at  timestamptz not null,
    used_at     timestamptz,
    created_at  timestamptz not null default now(),
    purpose     text not null default 'reset'
                    check (purpose in ('reset', 'activation'))
);
create index if not exists idx_password_reset_user_created
    on password_reset_tokens(user_id, created_at desc);

-- ---------------------------------------------------------
-- Projects, floor plans, zones, hardware
-- ---------------------------------------------------------

create table if not exists projects (
    id          text primary key,
    name        text not null,
    province    text not null default '',
    plan_id     text not null default '',
    plan_name   text not null default '',
    width_m     double precision not null default 20,
    height_m    double precision not null default 20
);

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
    id          serial primary key,
    tag_id      text unique not null,
    employee_id text references users(employee_id),
    project_id  text references projects(id),
    x           double precision,
    y           double precision,
    battery     double precision,
    last_ts     timestamptz
);

-- ---------------------------------------------------------
-- Live/raw positioning
-- ---------------------------------------------------------

create table if not exists positions (
    id      bigserial primary key,
    tag_id  text not null,
    x       double precision not null,
    y       double precision not null,
    zone    text,
    ts      timestamptz not null default now()
);
create index if not exists idx_positions_tag_ts on positions(tag_id, ts desc);

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
    deal_status     text default ''
);
create index if not exists idx_visits_started on visits(started_at desc);
create index if not exists idx_visits_employee on visits(employee_id);
create index if not exists idx_visits_project on visits(project_id);
create index if not exists idx_visits_open on visits(tag_id) where ended_at is null;

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
-- Row Level Security
-- ---------------------------------------------------------
-- The API talks to Postgres with a direct, dedicated role. Application
-- access control (who can see whose visits, who can edit) is enforced in
-- backend/backend/main.py. Table owners bypass RLS automatically; a separate
-- runtime role must be granted privileges and its explicit RLS policies with
-- database/configure_backend_role.sql.
-- ---------------------------------------------------------

alter table users     enable row level security;
alter table sessions  enable row level security;
alter table password_reset_tokens enable row level security;
alter table projects  enable row level security;
alter table zones     enable row level security;
alter table anchors   enable row level security;
alter table tags      enable row level security;
alter table positions enable row level security;
alter table customers enable row level security;
alter table visits    enable row level security;
alter table notes     enable row level security;
