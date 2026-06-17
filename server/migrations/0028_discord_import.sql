-- One-time Discord import jobs and their snowflake→Ohiyo provenance map.
-- The map is what makes every mapper idempotent and the whole job resumable.
CREATE TABLE discord_imports (
    id         TEXT PRIMARY KEY,
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    guild_id   TEXT NOT NULL,                 -- Discord guild snowflake
    owner_id   TEXT NOT NULL REFERENCES users(id),
    status     TEXT NOT NULL,                 -- 'running' | 'partial' | 'complete' | 'failed'
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE discord_import_map (
    import_id   TEXT NOT NULL REFERENCES discord_imports(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,                -- 'user'|'role'|'category'|'channel'|'message'|'attachment'
    discord_id  TEXT NOT NULL,                -- source snowflake
    ohiyo_id    TEXT NOT NULL,
    PRIMARY KEY (import_id, entity_type, discord_id)
);

-- Mark channels that originated from an import so the client can badge them
-- "Imported from Discord — not end-to-end encrypted".
ALTER TABLE channels ADD COLUMN imported INTEGER NOT NULL DEFAULT 0;
