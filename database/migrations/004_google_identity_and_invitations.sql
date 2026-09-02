-- Google account linking and admin-created user invitations. Safe to re-run.
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_status text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS activated_at timestamptz;

UPDATE users SET account_status = 'active' WHERE account_status IS NULL;
UPDATE users SET activated_at = COALESCE(activated_at, created_at)
WHERE account_status = 'active';

ALTER TABLE users ALTER COLUMN account_status SET DEFAULT 'active';
ALTER TABLE users ALTER COLUMN account_status SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_status_check;
ALTER TABLE users ADD CONSTRAINT users_account_status_check
    CHECK (account_status IN ('pending', 'active', 'disabled'));
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_sub
    ON users(google_sub) WHERE google_sub IS NOT NULL;

ALTER TABLE password_reset_tokens ADD COLUMN IF NOT EXISTS purpose text;
UPDATE password_reset_tokens SET purpose = 'reset' WHERE purpose IS NULL;
ALTER TABLE password_reset_tokens ALTER COLUMN purpose SET DEFAULT 'reset';
ALTER TABLE password_reset_tokens ALTER COLUMN purpose SET NOT NULL;
ALTER TABLE password_reset_tokens DROP CONSTRAINT IF EXISTS password_reset_tokens_purpose_check;
ALTER TABLE password_reset_tokens ADD CONSTRAINT password_reset_tokens_purpose_check
    CHECK (purpose IN ('reset', 'activation'));
