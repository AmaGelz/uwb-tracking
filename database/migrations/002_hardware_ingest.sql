BEGIN;

CREATE TABLE IF NOT EXISTS hardware_gateways (
    device_id       text PRIMARY KEY,
    project_id      text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    plan_id         text NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    description     text NOT NULL DEFAULT '',
    enabled         boolean NOT NULL DEFAULT true,
    last_seen       timestamptz,
    last_message_id text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (char_length(device_id) BETWEEN 1 AND 100)
);

CREATE TABLE IF NOT EXISTS hardware_ingest_receipts (
    device_id   text NOT NULL REFERENCES hardware_gateways(device_id) ON DELETE CASCADE,
    message_id  text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    response    jsonb NOT NULL,
    PRIMARY KEY (device_id, message_id),
    CHECK (char_length(message_id) BETWEEN 1 AND 160)
);

ALTER TABLE tags
    ADD COLUMN IF NOT EXISTS plan_id text,
    ADD COLUMN IF NOT EXISTS z double precision,
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS device_id text;

ALTER TABLE anchors
    ADD COLUMN IF NOT EXISTS hardware_address text;

ALTER TABLE positions
    ADD COLUMN IF NOT EXISTS project_id text,
    ADD COLUMN IF NOT EXISTS plan_id text,
    ADD COLUMN IF NOT EXISTS z double precision,
    ADD COLUMN IF NOT EXISTS source text,
    ADD COLUMN IF NOT EXISTS residual_m double precision,
    ADD COLUMN IF NOT EXISTS anchors_used integer,
    ADD COLUMN IF NOT EXISTS device_id text,
    ADD COLUMN IF NOT EXISTS message_id text;

UPDATE tags AS tag
SET plan_id = project.plan_id
FROM projects AS project
JOIN plans AS plan ON plan.id = project.plan_id AND plan.project_id = project.id
WHERE tag.project_id = project.id AND tag.plan_id IS NULL;

UPDATE positions AS position
SET project_id = tag.project_id, plan_id = tag.plan_id
FROM tags AS tag
WHERE position.tag_id = tag.tag_id
  AND (position.project_id IS NULL OR position.plan_id IS NULL);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tags'::regclass AND conname = 'tags_plan_id_fkey') THEN
        ALTER TABLE tags ADD CONSTRAINT tags_plan_id_fkey
            FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tags'::regclass AND conname = 'tags_device_id_fkey') THEN
        ALTER TABLE tags ADD CONSTRAINT tags_device_id_fkey
            FOREIGN KEY (device_id) REFERENCES hardware_gateways(device_id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'positions'::regclass AND conname = 'positions_project_id_fkey') THEN
        ALTER TABLE positions ADD CONSTRAINT positions_project_id_fkey
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'positions'::regclass AND conname = 'positions_plan_id_fkey') THEN
        ALTER TABLE positions ADD CONSTRAINT positions_plan_id_fkey
            FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'positions'::regclass AND conname = 'positions_device_id_fkey') THEN
        ALTER TABLE positions ADD CONSTRAINT positions_device_id_fkey
            FOREIGN KEY (device_id) REFERENCES hardware_gateways(device_id) ON DELETE SET NULL;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_hardware_gateways_project_plan ON hardware_gateways(project_id, plan_id);
CREATE INDEX IF NOT EXISTS idx_hardware_ingest_receipts_received ON hardware_ingest_receipts(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_tags_project_plan ON tags(project_id, plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_anchors_project_hardware_address
    ON anchors(project_id, hardware_address) WHERE hardware_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_positions_plan_ts ON positions(plan_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_project_ts ON positions(project_id, ts DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_hardware_message
    ON positions(device_id, message_id) WHERE device_id IS NOT NULL AND message_id IS NOT NULL;

CREATE OR REPLACE FUNCTION ingest_hardware_fix(
    p_device_id text,
    p_message_id text,
    p_tag_id text,
    p_measured_at timestamptz,
    p_x double precision,
    p_y double precision,
    p_z double precision,
    p_zone text,
    p_source text,
    p_residual_m double precision,
    p_anchors_used integer,
    p_tag_battery double precision,
    p_anchor_status jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    gateway hardware_gateways%ROWTYPE;
    tag tags%ROWTYPE;
    prior jsonb;
    result jsonb;
    visit_id text;
BEGIN
    SELECT * INTO gateway FROM hardware_gateways
    WHERE device_id = p_device_id FOR UPDATE;
    IF NOT FOUND OR NOT gateway.enabled THEN
        RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Gateway is not registered or is disabled';
    END IF;

    SELECT response INTO prior FROM hardware_ingest_receipts
    WHERE device_id = p_device_id AND message_id = p_message_id;
    IF FOUND THEN
        RETURN prior || jsonb_build_object('duplicate', true);
    END IF;

    SELECT * INTO tag FROM tags WHERE tag_id = p_tag_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'Tag is not registered';
    END IF;
    IF tag.project_id IS NOT NULL AND tag.project_id <> gateway.project_id THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Tag belongs to a different project';
    END IF;

    INSERT INTO positions (
        tag_id, project_id, plan_id, x, y, z, zone, ts, source,
        residual_m, anchors_used, device_id, message_id
    ) VALUES (
        p_tag_id, gateway.project_id, gateway.plan_id, p_x, p_y, p_z,
        p_zone, p_measured_at, p_source, p_residual_m, p_anchors_used,
        p_device_id, p_message_id
    );

    UPDATE tags SET
        project_id = gateway.project_id,
        plan_id = gateway.plan_id,
        x = p_x,
        y = p_y,
        z = p_z,
        battery = COALESCE(p_tag_battery, battery),
        last_ts = p_measured_at,
        source = p_source,
        device_id = p_device_id
    WHERE tag_id = p_tag_id;

    UPDATE anchors AS anchor SET
        battery = COALESCE(status.battery, anchor.battery),
        last_ts = p_measured_at
    FROM jsonb_to_recordset(COALESCE(p_anchor_status, '[]'::jsonb))
         AS status(anchor_id text, battery double precision)
    WHERE anchor.project_id = gateway.project_id
      AND anchor.plan_id = gateway.plan_id
      AND anchor.anchor_id = status.anchor_id;

    IF NOT EXISTS (SELECT 1 FROM visits WHERE tag_id = p_tag_id AND ended_at IS NULL) THEN
        visit_id := 'V-' || floor(extract(epoch FROM p_measured_at))::bigint::text
                    || '-' || p_tag_id || '-' || substr(gen_random_uuid()::text, 1, 6);
        INSERT INTO visits (
            visit_key, tag_id, employee_id, project_id, plan_id, started_at, deal_status
        ) VALUES (
            visit_id, p_tag_id, tag.employee_id, gateway.project_id,
            gateway.plan_id, p_measured_at, ''
        );
    END IF;

    UPDATE hardware_gateways SET
        last_seen = now(), last_message_id = p_message_id, updated_at = now()
    WHERE device_id = p_device_id;

    result := jsonb_build_object(
        'ok', true, 'duplicate', false, 'device_id', p_device_id,
        'project_id', gateway.project_id, 'plan_id', gateway.plan_id,
        'tag_id', p_tag_id, 'x', round(p_x::numeric, 3),
        'y', round(p_y::numeric, 3), 'z', p_z, 'zone', p_zone,
        'residual_m', p_residual_m, 'anchors_used', p_anchors_used,
        'ts', extract(epoch FROM p_measured_at)
    );

    INSERT INTO hardware_ingest_receipts(device_id, message_id, response)
    VALUES (p_device_id, p_message_id, result);
    DELETE FROM hardware_ingest_receipts
    WHERE device_id = p_device_id AND received_at < now() - interval '10 minutes';
    RETURN result;
END;
$$;

COMMIT;
