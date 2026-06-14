CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    username    TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar_url  TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE servers (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    owner_id    TEXT NOT NULL REFERENCES users(id),
    icon_url    TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE server_members (
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at   INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);

CREATE TABLE channels (
    id          TEXT PRIMARY KEY,
    server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,  -- NULL for DMs
    name        TEXT NOT NULL,
    channel_type TEXT NOT NULL CHECK(channel_type IN ('text','voice','dm','group_dm')),
    position    INTEGER NOT NULL DEFAULT 0,
    topic       TEXT,
    created_at  INTEGER NOT NULL
);

CREATE TABLE dm_participants (
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id   TEXT NOT NULL REFERENCES users(id),
    content     TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    edited_at   INTEGER
);

CREATE INDEX idx_messages_channel ON messages(channel_id, created_at DESC);
CREATE INDEX idx_server_members_user ON server_members(user_id);
CREATE INDEX idx_channels_server ON channels(server_id, position);
