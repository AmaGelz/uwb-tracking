BEGIN;

SET LOCAL search_path TO supalai_dashboard, public;

-- Import the pre-existing UWB application's public.* data into the isolated
-- dashboard schema.  The legacy tables are never altered.  Every imported ID
-- is deterministic and every insert is conflict-safe, so this migration may
-- be run repeatedly.
DO $legacy_import$
DECLARE
    v_missing text;
BEGIN
    SELECT string_agg(required.name, ', ' ORDER BY required.name)
    INTO v_missing
    FROM (
        VALUES
            ('users'),
            ('roles'),
            ('uwb_projects'),
            ('plans'),
            ('zones'),
            ('uwb_anchors'),
            ('uwb_tags'),
            ('tag_assignments'),
            ('positions_log'),
            ('visits')
    ) AS required(name)
    WHERE to_regclass('public.' || required.name) IS NULL;

    IF v_missing IS NOT NULL THEN
        RAISE NOTICE 'Legacy UWB import skipped; public schema is missing: %', v_missing;
        RETURN;
    END IF;

    -- ------------------------------------------------------------------ users
    INSERT INTO supalai_dashboard.users (
        id, employee_id, email, password_hash, role, position,
        first_th, last_th, first_en, last_en, phone
    )
    SELECT
        'legacy-user-' || legacy_user.user_id,
        COALESCE(
            NULLIF(BTRIM(legacy_user.employee_code), ''),
            'LEGACY-EMP-' || legacy_user.user_id
        ),
        LOWER(COALESCE(
            NULLIF(BTRIM(legacy_user.email), ''),
            'legacy-user-' || legacy_user.user_id || '@invalid.local'
        )),
        legacy_user.password_hash,
        CASE LOWER(COALESCE(legacy_role.role_name, ''))
            WHEN 'admin' THEN 'admin'
            WHEN 'sale_lead' THEN 'sale_lead'
            WHEN 'sales_lead' THEN 'sale_lead'
            WHEN 'sale' THEN 'sale'
            ELSE CASE legacy_user.role_id
                WHEN 1 THEN 'admin'
                WHEN 3 THEN 'sale_lead'
                ELSE 'sale'
            END
        END,
        COALESCE(legacy_role.description, legacy_role.role_name, ''),
        COALESCE(legacy_user.name, ''),
        COALESCE(legacy_user.surname, ''),
        '',
        '',
        ''
    FROM public.users AS legacy_user
    LEFT JOIN public.roles AS legacy_role
        ON legacy_role.role_id = legacy_user.role_id
    WHERE NULLIF(BTRIM(legacy_user.password_hash), '') IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- --------------------------------------------------------------- projects
    -- One legacy project becomes up to two dashboard projects. Physical tags
    -- stay in HW-<id>; simulator tags stay in SIM-<id>.
    WITH tag_projects AS (
        SELECT DISTINCT
            legacy_tag.project_id AS legacy_project_id,
            CASE
                WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                    THEN 'simulator'
                ELSE 'hardware'
            END AS source
        FROM public.uwb_tags AS legacy_tag
        WHERE legacy_tag.project_id IS NOT NULL
    ),
    extents AS (
        SELECT
            project.project_id AS legacy_project_id,
            GREATEST(
                COALESCE((
                    SELECT MAX(anchor.x_coord)
                    FROM public.uwb_anchors AS anchor
                    WHERE anchor.project_id = project.project_id
                ), 0),
                COALESCE((
                    SELECT MAX(zone.x_max)
                    FROM public.zones AS zone
                    JOIN public.plans AS plan ON plan.plan_id = zone.plan_id
                    WHERE plan.project_id = project.project_id
                ), 0)
            ) AS max_x,
            GREATEST(
                COALESCE((
                    SELECT MAX(anchor.y_coord)
                    FROM public.uwb_anchors AS anchor
                    WHERE anchor.project_id = project.project_id
                ), 0),
                COALESCE((
                    SELECT MAX(zone.y_max)
                    FROM public.zones AS zone
                    JOIN public.plans AS plan ON plan.plan_id = zone.plan_id
                    WHERE plan.project_id = project.project_id
                ), 0)
            ) AS max_y
        FROM public.uwb_projects AS project
    )
    INSERT INTO supalai_dashboard.projects (
        id, name, province, plan_id, plan_name,
        width_m, height_m, tracking_mode
    )
    SELECT
        CASE tag_project.source
            WHEN 'hardware' THEN 'HW-'
            ELSE 'SIM-'
        END || tag_project.legacy_project_id,
        COALESCE(NULLIF(BTRIM(project.project), ''), 'Legacy UWB Project ' || project.project_id)
            || CASE tag_project.source
                WHEN 'hardware' THEN ' [Hardware]'
                ELSE ' [Mock]'
            END,
        COALESCE(project.province, ''),
        CASE tag_project.source
            WHEN 'hardware' THEN 'HW-PLAN-'
            ELSE 'SIM-PLAN-'
        END || tag_project.legacy_project_id,
        COALESCE(NULLIF(BTRIM(active_plan.plan_name), ''), 'Imported UWB Plan'),
        GREATEST(2, CEIL(COALESCE(extent.max_x, 0) + 1))::double precision,
        GREATEST(2, CEIL(COALESCE(extent.max_y, 0) + 1))::double precision,
        CASE tag_project.source
            WHEN 'hardware' THEN 'hardware'
            ELSE 'simulation'
        END
    FROM tag_projects AS tag_project
    JOIN public.uwb_projects AS project
        ON project.project_id = tag_project.legacy_project_id
    LEFT JOIN extents AS extent
        ON extent.legacy_project_id = tag_project.legacy_project_id
    LEFT JOIN LATERAL (
        SELECT plan.plan_name
        FROM public.plans AS plan
        WHERE plan.project_id = tag_project.legacy_project_id
        ORDER BY plan.is_live DESC NULLS LAST, plan.plan_id DESC
        LIMIT 1
    ) AS active_plan ON true
    ON CONFLICT (id) DO NOTHING;

    -- ------------------------------------------------------------------ plans
    WITH tag_projects AS (
        SELECT DISTINCT
            legacy_tag.project_id AS legacy_project_id,
            CASE
                WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                    THEN 'simulator'
                ELSE 'hardware'
            END AS source
        FROM public.uwb_tags AS legacy_tag
        WHERE legacy_tag.project_id IS NOT NULL
    )
    INSERT INTO supalai_dashboard.plans (
        id, project_id, name, width_m, height_m, is_active
    )
    SELECT
        target_project.plan_id,
        target_project.id,
        target_project.plan_name,
        target_project.width_m,
        target_project.height_m,
        true
    FROM tag_projects AS tag_project
    JOIN supalai_dashboard.projects AS target_project
        ON target_project.id = CASE tag_project.source
            WHEN 'hardware' THEN 'HW-'
            ELSE 'SIM-'
        END || tag_project.legacy_project_id
    ON CONFLICT (id) DO NOTHING;

    -- ------------------------------------------------------------ zones/plan
    WITH selected_plan AS (
        SELECT DISTINCT ON (plan.project_id)
            plan.project_id,
            plan.plan_id
        FROM public.plans AS plan
        ORDER BY plan.project_id, plan.is_live DESC NULLS LAST, plan.plan_id DESC
    ),
    tag_projects AS (
        SELECT DISTINCT
            legacy_tag.project_id AS legacy_project_id,
            CASE
                WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                    THEN 'simulator'
                ELSE 'hardware'
            END AS source
        FROM public.uwb_tags AS legacy_tag
        WHERE legacy_tag.project_id IS NOT NULL
    )
    INSERT INTO supalai_dashboard.zones (
        project_id, plan_id, name, x_min, x_max, y_min, y_max, geometry
    )
    SELECT
        CASE tag_project.source WHEN 'hardware' THEN 'HW-' ELSE 'SIM-' END
            || tag_project.legacy_project_id,
        CASE tag_project.source WHEN 'hardware' THEN 'HW-PLAN-' ELSE 'SIM-PLAN-' END
            || tag_project.legacy_project_id,
        COALESCE(NULLIF(BTRIM(zone.zone_name), ''), 'Legacy zone ' || zone.zone_id),
        zone.x_min::double precision,
        zone.x_max::double precision,
        zone.y_min::double precision,
        zone.y_max::double precision,
        jsonb_build_object(
            'type', 'polygon',
            'points', jsonb_build_array(
                jsonb_build_array(zone.x_min, zone.y_min),
                jsonb_build_array(zone.x_max, zone.y_min),
                jsonb_build_array(zone.x_max, zone.y_max),
                jsonb_build_array(zone.x_min, zone.y_max)
            )
        )
    FROM tag_projects AS tag_project
    JOIN selected_plan AS selected
        ON selected.project_id = tag_project.legacy_project_id
    JOIN public.zones AS zone
        ON zone.plan_id = selected.plan_id
    WHERE zone.x_min IS NOT NULL
      AND zone.x_max IS NOT NULL
      AND zone.y_min IS NOT NULL
      AND zone.y_max IS NOT NULL
    ON CONFLICT (project_id, name) DO NOTHING;

    -- ---------------------------------------------------------------- anchors
    WITH tag_projects AS (
        SELECT DISTINCT
            legacy_tag.project_id AS legacy_project_id,
            CASE
                WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                    THEN 'simulator'
                ELSE 'hardware'
            END AS source
        FROM public.uwb_tags AS legacy_tag
        WHERE legacy_tag.project_id IS NOT NULL
    )
    INSERT INTO supalai_dashboard.anchors (
        project_id, plan_id, anchor_id, x, y, battery, last_ts
    )
    SELECT
        CASE tag_project.source WHEN 'hardware' THEN 'HW-' ELSE 'SIM-' END
            || tag_project.legacy_project_id,
        CASE tag_project.source WHEN 'hardware' THEN 'HW-PLAN-' ELSE 'SIM-PLAN-' END
            || tag_project.legacy_project_id,
        COALESCE(
            NULLIF(BTRIM(anchor.hw_anchor_id), ''),
            'legacy-anchor-' || anchor.anchor_id
        ),
        anchor.x_coord::double precision,
        anchor.y_coord::double precision,
        NULL,
        NULL
    FROM public.uwb_anchors AS anchor
    JOIN tag_projects AS tag_project
        ON tag_project.legacy_project_id = anchor.project_id
    WHERE anchor.x_coord IS NOT NULL
      AND anchor.y_coord IS NOT NULL
    ON CONFLICT (project_id, anchor_id) DO NOTHING;

    -- ------------------------------------------------------------------- tags
    WITH legacy_tags AS (
        SELECT
            legacy_tag.*,
            CASE
                WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                    THEN 'simulator'
                ELSE 'hardware'
            END AS source,
            COALESCE(
                NULLIF(BTRIM(legacy_tag.hw_tag_id), ''),
                CASE
                    WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                        THEN 'legacy-sim-'
                    ELSE 'legacy-tag-'
                END || legacy_tag.tag_id
            ) AS dashboard_tag_id
        FROM public.uwb_tags AS legacy_tag
        WHERE legacy_tag.project_id IS NOT NULL
    )
    INSERT INTO supalai_dashboard.tags (
        tag_id, hardware_uid, label, tag_type, status,
        employee_id, project_id, x, y, battery, last_ts
    )
    SELECT
        legacy_tag.dashboard_tag_id,
        NULLIF(BTRIM(legacy_tag.mac_address), ''),
        COALESCE(
            NULLIF(BTRIM(legacy_tag.hw_tag_id), ''),
            NULLIF(BTRIM(legacy_tag.mac_address), ''),
            'Legacy tag ' || legacy_tag.tag_id
        ),
        CASE legacy_tag.source WHEN 'hardware' THEN 'physical' ELSE 'mock' END,
        CASE
            WHEN LOWER(COALESCE(legacy_tag.status, 'active')) IN ('active', 'enabled', 'on')
                THEN 'active'
            ELSE 'disabled'
        END,
        dashboard_user.employee_id,
        CASE legacy_tag.source WHEN 'hardware' THEN 'HW-' ELSE 'SIM-' END
            || legacy_tag.project_id,
        latest_position.x_pos::double precision,
        latest_position.y_pos::double precision,
        NULL,
        latest_position.measured_at
    FROM legacy_tags AS legacy_tag
    LEFT JOIN LATERAL (
        SELECT assignment.user_id
        FROM public.tag_assignments AS assignment
        WHERE assignment.tag_id = legacy_tag.tag_id
          AND assignment.returned_at IS NULL
          AND LOWER(COALESCE(assignment.status, 'active'))
              NOT IN ('inactive', 'returned', 'cancelled', 'disabled')
        ORDER BY assignment.assigned_at DESC, assignment.assignment_id DESC
        LIMIT 1
    ) AS active_assignment ON true
    LEFT JOIN LATERAL (
        SELECT app_user.employee_id
        FROM public.users AS legacy_user
        JOIN supalai_dashboard.users AS app_user
          ON app_user.id = 'legacy-user-' || legacy_user.user_id
          OR app_user.employee_id = COALESCE(
                NULLIF(BTRIM(legacy_user.employee_code), ''),
                'LEGACY-EMP-' || legacy_user.user_id
             )
          OR LOWER(app_user.email) = LOWER(legacy_user.email)
        WHERE legacy_user.user_id = active_assignment.user_id
        ORDER BY (app_user.id = 'legacy-user-' || legacy_user.user_id) DESC
        LIMIT 1
    ) AS dashboard_user ON true
    LEFT JOIN LATERAL (
        SELECT
            position.x_pos,
            position.y_pos,
            COALESCE(position.log_ts, position.log_date + position.log_time)
                AT TIME ZONE 'Asia/Bangkok' AS measured_at
        FROM public.positions_log AS position
        WHERE position.tag_id = legacy_tag.tag_id
          AND position.x_pos IS NOT NULL
          AND position.y_pos IS NOT NULL
          AND COALESCE(position.log_ts, position.log_date + position.log_time) IS NOT NULL
        ORDER BY position.log_id DESC
        LIMIT 1
    ) AS latest_position ON true
    ON CONFLICT DO NOTHING;

    -- The explicit map is the bridge's authoritative routing table.
    WITH legacy_tags AS (
        SELECT
            legacy_tag.tag_id AS legacy_tag_id,
            legacy_tag.project_id AS legacy_project_id,
            CASE
                WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                    THEN 'simulator'
                ELSE 'hardware'
            END AS source,
            COALESCE(
                NULLIF(BTRIM(legacy_tag.hw_tag_id), ''),
                CASE
                    WHEN LOWER(COALESCE(NULLIF(BTRIM(legacy_tag.type), ''), 'tag')) = 'simulator'
                        THEN 'legacy-sim-'
                    ELSE 'legacy-tag-'
                END || legacy_tag.tag_id
            ) AS dashboard_tag_id
        FROM public.uwb_tags AS legacy_tag
        WHERE legacy_tag.project_id IS NOT NULL
    )
    INSERT INTO supalai_dashboard.legacy_tag_map (
        legacy_tag_id, dashboard_tag_id, dashboard_project_id, source
    )
    SELECT
        legacy_tag.legacy_tag_id,
        legacy_tag.dashboard_tag_id,
        CASE legacy_tag.source WHEN 'hardware' THEN 'HW-' ELSE 'SIM-' END
            || legacy_tag.legacy_project_id,
        legacy_tag.source
    FROM legacy_tags AS legacy_tag
    JOIN supalai_dashboard.tags AS dashboard_tag
        ON dashboard_tag.tag_id = legacy_tag.dashboard_tag_id
    ON CONFLICT (legacy_tag_id) DO UPDATE
    SET dashboard_tag_id = EXCLUDED.dashboard_tag_id,
        dashboard_project_id = EXCLUDED.dashboard_project_id,
        source = EXCLUDED.source,
        updated_at = now();

    -- Every imported tag gets a project assignment. employee_id remains NULL
    -- for an unissued physical tag, which still permits hardware ingestion.
    INSERT INTO supalai_dashboard.tag_assignments (
        tag_id, project_id, employee_id, assigned_at
    )
    SELECT
        tag_map.dashboard_tag_id,
        tag_map.dashboard_project_id,
        dashboard_user.employee_id,
        COALESCE(
            active_assignment.assigned_at AT TIME ZONE 'Asia/Bangkok',
            first_position.first_seen,
            now()
        )
    FROM supalai_dashboard.legacy_tag_map AS tag_map
    LEFT JOIN LATERAL (
        SELECT assignment.user_id, assignment.assigned_at
        FROM public.tag_assignments AS assignment
        WHERE assignment.tag_id = tag_map.legacy_tag_id
          AND assignment.returned_at IS NULL
          AND LOWER(COALESCE(assignment.status, 'active'))
              NOT IN ('inactive', 'returned', 'cancelled', 'disabled')
        ORDER BY assignment.assigned_at DESC, assignment.assignment_id DESC
        LIMIT 1
    ) AS active_assignment ON true
    LEFT JOIN LATERAL (
        SELECT app_user.employee_id
        FROM public.users AS legacy_user
        JOIN supalai_dashboard.users AS app_user
          ON app_user.id = 'legacy-user-' || legacy_user.user_id
          OR app_user.employee_id = COALESCE(
                NULLIF(BTRIM(legacy_user.employee_code), ''),
                'LEGACY-EMP-' || legacy_user.user_id
             )
          OR LOWER(app_user.email) = LOWER(legacy_user.email)
        WHERE legacy_user.user_id = active_assignment.user_id
        ORDER BY (app_user.id = 'legacy-user-' || legacy_user.user_id) DESC
        LIMIT 1
    ) AS dashboard_user ON true
    LEFT JOIN LATERAL (
        SELECT MIN(COALESCE(position.log_ts, position.log_date + position.log_time))
            AT TIME ZONE 'Asia/Bangkok' AS first_seen
        FROM public.positions_log AS position
        WHERE position.tag_id = tag_map.legacy_tag_id
    ) AS first_position ON true
    WHERE NOT EXISTS (
        SELECT 1
        FROM supalai_dashboard.tag_assignments AS existing_assignment
        WHERE existing_assignment.tag_id = tag_map.dashboard_tag_id
    );

    -- -------------------------------------------------------------- positions
    INSERT INTO supalai_dashboard.positions (
        gateway_id, message_id, tag_id, project_id, plan_id, source,
        device_ts, x, y, zone, residual_m, anchors_used, ts
    )
    SELECT
        -- These two must match legacy_bridge.GATEWAY_ID and the message_id it
        -- builds ("positions-log:<log_id>") exactly. The bridge forwards the
        -- same rows live, and the partial unique index on
        -- (gateway_id, message_id) is the only thing stopping this replayed
        -- import from inserting every forwarded fix a second time.
        'legacy-db',
        'positions-log:' || position.log_id,
        tag_map.dashboard_tag_id,
        tag_map.dashboard_project_id,
        CASE tag_map.source WHEN 'hardware' THEN 'HW-PLAN-' ELSE 'SIM-PLAN-' END
            || legacy_tag.project_id,
        tag_map.source,
        COALESCE(position.log_ts, position.log_date + position.log_time)
            AT TIME ZONE 'Asia/Bangkok',
        position.x_pos::double precision,
        position.y_pos::double precision,
        matching_zone.name,
        NULL,
        position.anchors_used::integer,
        COALESCE(position.log_ts, position.log_date + position.log_time)
            AT TIME ZONE 'Asia/Bangkok'
    FROM public.positions_log AS position
    JOIN supalai_dashboard.legacy_tag_map AS tag_map
        ON tag_map.legacy_tag_id = position.tag_id
    JOIN public.uwb_tags AS legacy_tag
        ON legacy_tag.tag_id = position.tag_id
    LEFT JOIN LATERAL (
        SELECT zone.name
        FROM supalai_dashboard.zones AS zone
        WHERE zone.project_id = tag_map.dashboard_project_id
          AND position.x_pos BETWEEN zone.x_min AND zone.x_max
          AND position.y_pos BETWEEN zone.y_min AND zone.y_max
        ORDER BY (zone.x_max - zone.x_min) * (zone.y_max - zone.y_min), zone.id
        LIMIT 1
    ) AS matching_zone ON true
    WHERE position.x_pos IS NOT NULL
      AND position.y_pos IS NOT NULL
      AND COALESCE(position.log_ts, position.log_date + position.log_time) IS NOT NULL
    ON CONFLICT DO NOTHING;

    -- Snapshot values follow the greatest legacy log_id, matching the legacy
    -- stream's cursor semantics rather than relying on wall-clock ordering.
    WITH latest AS (
        SELECT DISTINCT ON (position.tag_id)
            position.tag_id,
            position.x_pos,
            position.y_pos,
            COALESCE(position.log_ts, position.log_date + position.log_time)
                AT TIME ZONE 'Asia/Bangkok' AS measured_at
        FROM public.positions_log AS position
        WHERE position.x_pos IS NOT NULL
          AND position.y_pos IS NOT NULL
          AND COALESCE(position.log_ts, position.log_date + position.log_time) IS NOT NULL
        ORDER BY position.tag_id, position.log_id DESC
    )
    UPDATE supalai_dashboard.tags AS dashboard_tag
    SET x = latest.x_pos::double precision,
        y = latest.y_pos::double precision,
        last_ts = latest.measured_at,
        updated_at = now()
    FROM latest
    JOIN supalai_dashboard.legacy_tag_map AS tag_map
        ON tag_map.legacy_tag_id = latest.tag_id
    WHERE dashboard_tag.tag_id = tag_map.dashboard_tag_id
      AND (dashboard_tag.last_ts IS NULL OR dashboard_tag.last_ts <= latest.measured_at);

    -- ---------------------------------------------------------------- visits
    WITH ranked_visits AS (
        SELECT
            visit.*,
            ROW_NUMBER() OVER (
                PARTITION BY visit.tag_id, visit.closed
                ORDER BY visit.start_ts DESC, visit.visit_key DESC
            ) AS same_state_rank
        FROM public.visits AS visit
    )
    INSERT INTO supalai_dashboard.visits (
        visit_key, tag_id, employee_id, project_id, plan_id,
        customer_id, started_at, ended_at, duration_sec, zone,
        deal_status, source
    )
    SELECT
        'LEGACY-' || visit.visit_key,
        tag_map.dashboard_tag_id,
        COALESCE(NULLIF(BTRIM(visit.employee_code), ''), dashboard_user.employee_id),
        tag_map.dashboard_project_id,
        CASE tag_map.source WHEN 'hardware' THEN 'HW-PLAN-' ELSE 'SIM-PLAN-' END
            || legacy_tag.project_id,
        NULL,
        visit.start_ts,
        CASE
            WHEN NOT COALESCE(visit.closed, false) AND visit.same_state_rank = 1 THEN NULL
            ELSE COALESCE(
                visit.end_ts,
                visit.start_ts + make_interval(secs => GREATEST(COALESCE(visit.duration_s, 0), 0))
            )
        END,
        GREATEST(COALESCE(visit.duration_s, 0), 0),
        visit.top_zone,
        '',
        tag_map.source
    FROM ranked_visits AS visit
    JOIN supalai_dashboard.legacy_tag_map AS tag_map
        ON tag_map.legacy_tag_id = visit.tag_id
    JOIN public.uwb_tags AS legacy_tag
        ON legacy_tag.tag_id = visit.tag_id
    LEFT JOIN LATERAL (
        SELECT app_user.employee_id
        FROM public.users AS legacy_user
        JOIN supalai_dashboard.users AS app_user
          ON app_user.id = 'legacy-user-' || legacy_user.user_id
          OR app_user.employee_id = COALESCE(
                NULLIF(BTRIM(legacy_user.employee_code), ''),
                'LEGACY-EMP-' || legacy_user.user_id
             )
          OR LOWER(app_user.email) = LOWER(legacy_user.email)
        WHERE legacy_user.user_id = visit.user_id
        ORDER BY (app_user.id = 'legacy-user-' || legacy_user.user_id) DESC
        LIMIT 1
    ) AS dashboard_user ON true
    ON CONFLICT (visit_key) DO NOTHING;

    -- CRM metadata and notes are optional in older deployments.
    IF to_regclass('public.visit_meta') IS NOT NULL THEN
        INSERT INTO supalai_dashboard.customers (id, name)
        SELECT DISTINCT BTRIM(meta.customer_id), BTRIM(meta.customer_id)
        FROM public.visit_meta AS meta
        WHERE NULLIF(BTRIM(meta.customer_id), '') IS NOT NULL
        ON CONFLICT (id) DO NOTHING;

        UPDATE supalai_dashboard.visits AS dashboard_visit
        SET customer_id = NULLIF(BTRIM(meta.customer_id), ''),
            deal_status = COALESCE(meta.deal_status, '')
        FROM public.visit_meta AS meta
        WHERE dashboard_visit.visit_key = 'LEGACY-' || meta.visit_key;
    END IF;

    IF to_regclass('public.notes') IS NOT NULL THEN
        INSERT INTO supalai_dashboard.notes (
            visit_key, user_id, body, created_at, seed_key
        )
        SELECT
            'LEGACY-' || legacy_note.visit_key,
            COALESCE(dashboard_user.id, 'legacy-user-' || legacy_note.user_id),
            legacy_note.body,
            legacy_note.created_at,
            'LEGACY-NOTE-' || legacy_note.note_id
        FROM public.notes AS legacy_note
        JOIN supalai_dashboard.visits AS dashboard_visit
            ON dashboard_visit.visit_key = 'LEGACY-' || legacy_note.visit_key
        LEFT JOIN LATERAL (
            SELECT app_user.id
            FROM public.users AS legacy_user
            JOIN supalai_dashboard.users AS app_user
              ON app_user.id = 'legacy-user-' || legacy_user.user_id
              OR app_user.employee_id = COALESCE(
                    NULLIF(BTRIM(legacy_user.employee_code), ''),
                    'LEGACY-EMP-' || legacy_user.user_id
                 )
              OR LOWER(app_user.email) = LOWER(legacy_user.email)
            WHERE legacy_user.user_id = legacy_note.user_id
            ORDER BY (app_user.id = 'legacy-user-' || legacy_user.user_id) DESC
            LIMIT 1
        ) AS dashboard_user ON true
        ON CONFLICT (seed_key) DO NOTHING;
    END IF;

    -- Start a future bridge immediately after the history imported above.
    INSERT INTO supalai_dashboard.legacy_import_state (source, last_id)
    SELECT 'public.positions_log', COALESCE(MAX(position.log_id), 0)
    FROM public.positions_log AS position
    ON CONFLICT (source) DO UPDATE
    SET last_id = GREATEST(
            supalai_dashboard.legacy_import_state.last_id,
            EXCLUDED.last_id
        ),
        updated_at = now();
END
$legacy_import$;

COMMIT;
