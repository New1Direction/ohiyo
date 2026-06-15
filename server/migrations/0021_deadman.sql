-- Account-level dead-man's switch (inactivity wipe). If a user goes silent for longer
-- than `deadman_seconds`, a sweeper wipes their data: their authored messages, and (for
-- scope = 'keys') their server-side Signal directory too. Opt-in, off by default.
ALTER TABLE users ADD COLUMN last_active_at INTEGER;
ALTER TABLE users ADD COLUMN deadman_seconds INTEGER;   -- NULL/0 = disabled
ALTER TABLE users ADD COLUMN deadman_scope TEXT;        -- 'history' | 'keys'
CREATE INDEX IF NOT EXISTS idx_users_deadman ON users(deadman_seconds) WHERE deadman_seconds IS NOT NULL;
