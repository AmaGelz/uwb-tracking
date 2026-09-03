BEGIN;

-- Freeform plan boundaries remain additive: width_m/height_m and legacy zone
-- bounds stay available to older dashboard and migration consumers.
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS boundary jsonb,
    ADD COLUMN IF NOT EXISTS ceiling_height_m double precision NOT NULL DEFAULT 3.0;

UPDATE plans
SET boundary = jsonb_build_object(
    'type', 'polygon',
    'points', jsonb_build_array(
        jsonb_build_array(0, 0),
        jsonb_build_array(width_m, 0),
        jsonb_build_array(width_m, height_m),
        jsonb_build_array(0, height_m)
    )
)
WHERE boundary IS NULL;

ALTER TABLE plans ALTER COLUMN boundary SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'plans'::regclass
          AND conname = 'plans_boundary_object_check'
    ) THEN
        ALTER TABLE plans ADD CONSTRAINT plans_boundary_object_check
            CHECK (
                jsonb_typeof(boundary) = 'object'
                AND jsonb_typeof(boundary -> 'points') = 'array'
                AND jsonb_array_length(boundary -> 'points') >= 3
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'plans'::regclass
          AND conname = 'plans_ceiling_height_check'
    ) THEN
        ALTER TABLE plans ADD CONSTRAINT plans_ceiling_height_check
            CHECK (ceiling_height_m > 0);
    END IF;
END
$$;

ALTER TABLE zones
    ADD COLUMN IF NOT EXISTS zone_type text NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#4F9DDE',
    ADD COLUMN IF NOT EXISTS opacity double precision NOT NULL DEFAULT 0.30,
    ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS stack_order integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'zones'::regclass AND conname = 'zones_opacity_check'
    ) THEN
        ALTER TABLE zones ADD CONSTRAINT zones_opacity_check
            CHECK (opacity >= 0 AND opacity <= 1);
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_zones_plan_stack
    ON zones(plan_id, stack_order, id);

ALTER TABLE anchors
    ADD COLUMN IF NOT EXISTS mount_type text NOT NULL DEFAULT 'free',
    ADD COLUMN IF NOT EXISTS orientation_deg double precision NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS wall_ref jsonb,
    ADD COLUMN IF NOT EXISTS gateway_device_id text,
    ADD COLUMN IF NOT EXISTS bound_tag_id text;

UPDATE anchors
SET z = COALESCE(z, mount_height_m, 0),
    mount_height_m = COALESCE(mount_height_m, z, 0),
    mount_type = COALESCE(NULLIF(mount_type, ''), 'free'),
    orientation_deg = COALESCE(orientation_deg, 0);

ALTER TABLE anchors ALTER COLUMN z SET DEFAULT 0;
ALTER TABLE anchors ALTER COLUMN z SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'anchors'::regclass AND conname = 'anchors_mount_type_check'
    ) THEN
        ALTER TABLE anchors ADD CONSTRAINT anchors_mount_type_check
            CHECK (mount_type IN ('wall', 'ceiling', 'column', 'free'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'anchors'::regclass AND conname = 'anchors_wall_ref_object_check'
    ) THEN
        ALTER TABLE anchors ADD CONSTRAINT anchors_wall_ref_object_check
            CHECK (wall_ref IS NULL OR jsonb_typeof(wall_ref) = 'object');
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'anchors'::regclass AND conname = 'anchors_gateway_device_id_fkey'
    ) THEN
        ALTER TABLE anchors ADD CONSTRAINT anchors_gateway_device_id_fkey
            FOREIGN KEY (gateway_device_id) REFERENCES hardware_gateways(device_id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'anchors'::regclass AND conname = 'anchors_bound_tag_id_fkey'
    ) THEN
        ALTER TABLE anchors ADD CONSTRAINT anchors_bound_tag_id_fkey
            FOREIGN KEY (bound_tag_id) REFERENCES tags(tag_id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_anchors_plan_mount_type
    ON anchors(plan_id, mount_type);

COMMIT;
