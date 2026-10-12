-- Notification settings, per account, for a space or a channel (space channels, DMs and
-- group chats). A row exists only while something differs from the defaults: every message
-- notifies, nothing is muted.
CREATE TABLE notification_settings (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('server', 'channel')),
    target_id   TEXT NOT NULL,
    -- A space's level: 'all', 'mentions' or 'nothing'. NULL is the default (all).
    level       TEXT CHECK (level IS NULL OR level IN ('all', 'mentions', 'nothing')),
    muted       INTEGER NOT NULL DEFAULT 0,
    -- When a mute ends, in unix seconds. NULL while muted: until it's turned back on.
    muted_until INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, target_type, target_id)
);
