-- Server invites: shareable codes that let other people join a server.
CREATE TABLE invites (
    code        TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    channel_id  TEXT REFERENCES channels(id) ON DELETE SET NULL, -- preferred landing channel
    created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,           -- NULL = never expires
    max_uses    INTEGER,           -- NULL = unlimited
    uses        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_invites_server ON invites(server_id);
