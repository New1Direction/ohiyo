-- Moderation a space can do without bots.

-- Time outs live apart from membership, so leaving and rejoining doesn't shake one off.
-- A row whose `until` has passed is simply no longer a time out.
CREATE TABLE member_timeouts (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    until      INTEGER NOT NULL,
    reason     TEXT,
    actor_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);

-- Slowmode: seconds between one person's messages in a channel (0 = off), and when each
-- person last posted under it.
ALTER TABLE channels ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0;
CREATE TABLE slowmode_marks (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sent_at    INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
);

-- A space can pause its invites: every link then turns newcomers away.
ALTER TABLE servers ADD COLUMN invites_paused INTEGER NOT NULL DEFAULT 0;

-- Why someone was banned.
ALTER TABLE server_bans ADD COLUMN reason TEXT;

-- The new "Create invites" permission (1 << 10). Every member could make invites before it
-- existed, so @everyone roles keep that (spaces without one default to it in the code).
UPDATE roles SET permissions = permissions | 1024 WHERE is_everyone = 1;
