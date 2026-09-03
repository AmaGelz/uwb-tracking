-- Roll back migration 005 after the application has been rolled back.
-- Take a database snapshot first. The backup tables below deliberately make a
-- second execution fail instead of silently replacing the first rollback copy.
BEGIN;

CREATE TABLE rollback_005_plans AS
SELECT id, project_id, width_m, height_m, boundary, ceiling_height_m
FROM plans;

CREATE TABLE rollback_005_zones AS
SELECT id, project_id, plan_id, zone_type, color, opacity, is_visible, stack_order, updated_at
FROM zones;

CREATE TABLE rollback_005_anchors AS
SELECT id, project_id, plan_id, anchor_id, z, mount_height_m,
       mount_type, orientation_deg, wall_ref,
       gateway_device_id, bound_tag_id
FROM anchors;

ALTER TABLE anchors
    DROP CONSTRAINT IF EXISTS anchors_bound_tag_id_fkey,
    DROP CONSTRAINT IF EXISTS anchors_gateway_device_id_fkey,
    DROP CONSTRAINT IF EXISTS anchors_wall_ref_object_check,
    DROP CONSTRAINT IF EXISTS anchors_mount_type_check;

DROP INDEX IF EXISTS idx_anchors_plan_mount_type;

ALTER TABLE anchors
    DROP COLUMN IF EXISTS bound_tag_id,
    DROP COLUMN IF EXISTS gateway_device_id,
    DROP COLUMN IF EXISTS wall_ref,
    DROP COLUMN IF EXISTS orientation_deg,
    DROP COLUMN IF EXISTS mount_type;

-- Migration 005 made the pre-existing z column mandatory. Restore its 001
-- nullability/default contract after the new editor application is removed.
ALTER TABLE anchors
    ALTER COLUMN z DROP NOT NULL,
    ALTER COLUMN z DROP DEFAULT;

ALTER TABLE zones
    DROP CONSTRAINT IF EXISTS zones_opacity_check;

DROP INDEX IF EXISTS idx_zones_plan_stack;

ALTER TABLE zones
    DROP COLUMN IF EXISTS updated_at,
    DROP COLUMN IF EXISTS stack_order,
    DROP COLUMN IF EXISTS is_visible,
    DROP COLUMN IF EXISTS opacity,
    DROP COLUMN IF EXISTS color,
    DROP COLUMN IF EXISTS zone_type;

ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_ceiling_height_check,
    DROP CONSTRAINT IF EXISTS plans_boundary_object_check;

ALTER TABLE plans
    DROP COLUMN IF EXISTS ceiling_height_m,
    DROP COLUMN IF EXISTS boundary;

COMMIT;
