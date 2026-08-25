BEGIN;

-- Phase 1: plan editor storage.
-- This migration is safe to re-run and deliberately keeps every legacy column
-- and row. Legacy rectangle zones are copied into geometry, not replaced.

-- ---------------------------------------------------------------------------
-- Plans
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plans (
    id          text PRIMARY KEY,
    project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        text NOT NULL,
    width_m     double precision NOT NULL DEFAULT 20 CHECK (width_m > 0),
    height_m    double precision NOT NULL DEFAULT 20 CHECK (height_m > 0),
    is_active   boolean NOT NULL DEFAULT false,
    version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

CREATE INDEX IF NOT EXISTS idx_plans_project_id
    ON plans(project_id);

CREATE INDEX IF NOT EXISTS idx_plans_project_active
    ON plans(project_id, is_active);

-- Create one plan for every legacy project. Keep a non-empty legacy plan ID so
-- existing API payloads and visit history continue to refer to the same value.
INSERT INTO plans (id, project_id, name, width_m, height_m, is_active)
SELECT
    COALESCE(NULLIF(BTRIM(p.plan_id), ''), p.id || '-A'),
    p.id,
    COALESCE(NULLIF(BTRIM(p.plan_name), ''), 'Plan A'),
    COALESCE(p.width_m, 20),
    COALESCE(p.height_m, 20),
    true
FROM projects AS p
ON CONFLICT (id) DO NOTHING;

-- Repair only blank legacy metadata. Non-blank legacy values are preserved.
UPDATE projects
SET
    plan_id = COALESCE(NULLIF(BTRIM(plan_id), ''), id || '-A'),
    plan_name = COALESCE(NULLIF(BTRIM(plan_name), ''), 'Plan A')
WHERE
    NULLIF(BTRIM(plan_id), '') IS NULL
    OR NULLIF(BTRIM(plan_name), '') IS NULL;

-- ---------------------------------------------------------------------------
-- Editable objects and dimensions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS plan_objects (
    id           bigserial PRIMARY KEY,
    plan_id      text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    object_type  text NOT NULL,
    label        text,
    geometry     jsonb NOT NULL,
    properties   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (jsonb_typeof(geometry) = 'object'),
    CHECK (jsonb_typeof(properties) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_plan_objects_plan_id
    ON plan_objects(plan_id);

CREATE INDEX IF NOT EXISTS idx_plan_objects_plan_type
    ON plan_objects(plan_id, object_type);

CREATE TABLE IF NOT EXISTS plan_dimensions (
    id          bigserial PRIMARY KEY,
    plan_id     text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    x1          double precision NOT NULL,
    y1          double precision NOT NULL,
    x2          double precision NOT NULL,
    y2          double precision NOT NULL,
    length_m    double precision NOT NULL CHECK (length_m >= 0),
    angle_deg   double precision NOT NULL DEFAULT 0,
    label       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plan_dimensions_plan_id
    ON plan_dimensions(plan_id);

-- ---------------------------------------------------------------------------
-- Extend legacy zones and anchors without removing or renaming old columns.
-- ---------------------------------------------------------------------------

ALTER TABLE zones
    ADD COLUMN IF NOT EXISTS plan_id text,
    ADD COLUMN IF NOT EXISTS geometry jsonb;

ALTER TABLE anchors
    ADD COLUMN IF NOT EXISTS plan_id text,
    ADD COLUMN IF NOT EXISTS z double precision,
    ADD COLUMN IF NOT EXISTS mount_height_m double precision;

-- Backfill only NULLs. Joining through plans prevents a plan belonging to a
-- different project from being assigned accidentally.
UPDATE zones AS z
SET plan_id = p.plan_id
FROM projects AS p
JOIN plans AS pl
    ON pl.id = p.plan_id
   AND pl.project_id = p.id
WHERE z.project_id = p.id
  AND z.plan_id IS NULL;

UPDATE zones
SET geometry = jsonb_build_object(
    'type', 'polygon',
    'points', jsonb_build_array(
        jsonb_build_array(x_min, y_min),
        jsonb_build_array(x_max, y_min),
        jsonb_build_array(x_max, y_max),
        jsonb_build_array(x_min, y_max)
    )
)
WHERE geometry IS NULL;

UPDATE anchors AS a
SET plan_id = p.plan_id
FROM projects AS p
JOIN plans AS pl
    ON pl.id = p.plan_id
   AND pl.project_id = p.id
WHERE a.project_id = p.id
  AND a.plan_id IS NULL;

-- Add each FK only when it is absent on the intended table. SET NULL keeps
-- zone/anchor history if a plan is removed; project_id remains the owner.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'zones'::regclass
          AND conname = 'zones_plan_id_fkey'
          AND contype = 'f'
    ) THEN
        ALTER TABLE zones
            ADD CONSTRAINT zones_plan_id_fkey
            FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
    END IF;
END
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'anchors'::regclass
          AND conname = 'anchors_plan_id_fkey'
          AND contype = 'f'
    ) THEN
        ALTER TABLE anchors
            ADD CONSTRAINT anchors_plan_id_fkey
            FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_zones_plan_id
    ON zones(plan_id);

CREATE INDEX IF NOT EXISTS idx_anchors_plan_id
    ON anchors(plan_id);

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_dimensions ENABLE ROW LEVEL SECURITY;

COMMIT;
