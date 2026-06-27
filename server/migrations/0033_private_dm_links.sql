-- One-time private DM links.
-- The bearer token is shown to the creator once; the server stores only a scoped
-- SHA-256 digest so a DB read cannot recover live links.
CREATE TABLE private_dm_links (
    token_hash TEXT PRIMARY KEY,
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    revoked_at INTEGER,
    CHECK (expires_at > created_at)
);

CREATE INDEX idx_private_dm_links_creator ON private_dm_links(created_by, created_at DESC);
CREATE INDEX idx_private_dm_links_expiry ON private_dm_links(expires_at);
CREATE INDEX idx_private_dm_links_used_by ON private_dm_links(used_by, used_at DESC);
