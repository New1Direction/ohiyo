-- Server bans: a banned user cannot rejoin (via join or invite) until unbanned.
CREATE TABLE server_bans (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_at  INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);
