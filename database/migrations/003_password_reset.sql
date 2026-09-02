-- One-time, expiring password-reset links. Safe to re-run.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token_hash  text PRIMARY KEY,
    user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    used_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_reset_user_created
    ON password_reset_tokens(user_id, created_at DESC);

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
