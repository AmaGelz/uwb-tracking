ALTER TABLE tags ADD COLUMN IF NOT EXISTS tag_type text NOT NULL DEFAULT 'physical'
    CHECK (tag_type IN ('mock','physical'));
-- No status column exists on tags anywhere in feature/Login; the
-- InactiveTagError check in tracking.validate_tracking_policy needs one to
-- disable a tag without deleting it.
ALTER TABLE tags ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','disabled'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tracking_mode text NOT NULL DEFAULT 'hardware'
    CHECK (tracking_mode IN ('simulation','hardware'));
