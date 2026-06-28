-- Discord template migration preservation tables.
-- Ohiyo does not yet enforce Discord-style per-channel overwrites, but migration must not
-- silently drop the matrix. Store the exact imported allow/deny rows so owners/auditors can
-- inspect or replay them when channel-scoped permissions land.
CREATE TABLE discord_import_permission_overwrites (
    import_id          TEXT NOT NULL REFERENCES discord_imports(id) ON DELETE CASCADE,
    channel_discord_id TEXT NOT NULL,
    channel_name       TEXT NOT NULL,
    target_discord_id  TEXT NOT NULL,
    target_type        TEXT NOT NULL CHECK(target_type IN ('role','member','unknown')),
    target_name        TEXT,
    allow              TEXT NOT NULL,
    deny               TEXT NOT NULL,
    created_at         INTEGER NOT NULL,
    PRIMARY KEY (import_id, channel_discord_id, target_discord_id, target_type)
);

CREATE INDEX idx_discord_import_overwrites_import
    ON discord_import_permission_overwrites(import_id);

-- Asset/identifier provenance for one-command migrations. This lets the result answer
-- "which Discord role/emoji/icon became which Ohiyo row/file?" without exposing content.
CREATE TABLE discord_import_asset_map (
    import_id   TEXT NOT NULL REFERENCES discord_imports(id) ON DELETE CASCADE,
    asset_type  TEXT NOT NULL,
    discord_id  TEXT NOT NULL,
    name        TEXT,
    ohiyo_id    TEXT,
    source_url  TEXT,
    status      TEXT NOT NULL,
    note        TEXT,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (import_id, asset_type, discord_id)
);

CREATE INDEX idx_discord_import_assets_import
    ON discord_import_asset_map(import_id);
