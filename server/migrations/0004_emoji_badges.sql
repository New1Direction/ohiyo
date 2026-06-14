-- Custom server emoji (Discord Nitro parity)
CREATE TABLE server_emojis (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,          -- used as :name: in messages
    file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,          -- resolved /files/{file_id} URL
    created_by  TEXT NOT NULL REFERENCES users(id),
    created_at  INTEGER NOT NULL,
    UNIQUE (server_id, name)
);

CREATE INDEX idx_emojis_server ON server_emojis(server_id);

-- User badges (Early Adopter, Developer, etc.)
ALTER TABLE users ADD COLUMN badges TEXT DEFAULT '[]'; -- JSON array of badge strings
