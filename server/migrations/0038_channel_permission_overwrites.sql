-- Runtime channel/category permission overwrites.
-- This turns the Discord overwrite matrix from "preserved for review" into an
-- enforceable Ohiyo permission layer for mapped role/@everyone/member targets.

ALTER TABLE roles ADD COLUMN is_everyone INTEGER NOT NULL DEFAULT 0;

-- Existing imported @everyone roles were created as normal roles. Mark them as the
-- server default role so every member receives its base permissions without manual
-- assignment.
UPDATE roles SET is_everyone = 1 WHERE lower(name) = '@everyone';

CREATE TABLE IF NOT EXISTS permission_overwrites (
    id                TEXT PRIMARY KEY,
    server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    scope_type        TEXT NOT NULL CHECK(scope_type IN ('channel','category')),
    scope_id          TEXT NOT NULL,
    target_type       TEXT NOT NULL CHECK(target_type IN ('everyone','role','member','unknown')),
    target_id         TEXT,
    allow_permissions INTEGER NOT NULL DEFAULT 0,
    deny_permissions  INTEGER NOT NULL DEFAULT 0,
    source            TEXT,
    source_discord_id TEXT,
    unsupported_reason TEXT,
    created_at        INTEGER NOT NULL,
    UNIQUE(scope_type, scope_id, target_type, target_id, source_discord_id)
);
CREATE INDEX IF NOT EXISTS idx_permission_overwrites_scope ON permission_overwrites(scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_permission_overwrites_server ON permission_overwrites(server_id);

-- Backfill enforceable rows from previously preserved Discord import overwrites.
-- Only mapped role/@everyone/member targets can be enforced. Unknown/unmapped rows stay
-- in discord_import_permission_overwrites and remain visible as unsupported in review UI.
INSERT OR IGNORE INTO permission_overwrites (
    id, server_id, scope_type, scope_id, target_type, target_id,
    allow_permissions, deny_permissions, source, source_discord_id, unsupported_reason, created_at
)
SELECT
    lower(hex(randomblob(16))) AS id,
    di.server_id,
    'channel' AS scope_type,
    channel_map.ohiyo_id AS scope_id,
    CASE
        WHEN ow.target_type = 'role' AND ow.target_discord_id = di.guild_id THEN 'everyone'
        ELSE ow.target_type
    END AS target_type,
    CASE
        WHEN ow.target_type = 'role' AND ow.target_discord_id = di.guild_id THEN NULL
        ELSE target_map.ohiyo_id
    END AS target_id,
    CASE WHEN (CAST(ow.allow AS INTEGER) & 8) != 0 THEN 511 ELSE
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 16) != 0 THEN 1 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 8192) != 0 THEN 2 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 2) != 0 THEN 4 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 4) != 0 THEN 8 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 268435456) != 0 THEN 16 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 32) != 0 THEN 32 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 1024) != 0 THEN 64 ELSE 0 END) |
        (CASE WHEN (CAST(ow.allow AS INTEGER) & 2048) != 0 THEN 128 ELSE 0 END)
    END AS allow_permissions,
    CASE WHEN (CAST(ow.deny AS INTEGER) & 8) != 0 THEN 511 ELSE
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 16) != 0 THEN 1 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 8192) != 0 THEN 2 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 2) != 0 THEN 4 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 4) != 0 THEN 8 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 268435456) != 0 THEN 16 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 32) != 0 THEN 32 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 1024) != 0 THEN 64 ELSE 0 END) |
        (CASE WHEN (CAST(ow.deny AS INTEGER) & 2048) != 0 THEN 128 ELSE 0 END)
    END AS deny_permissions,
    'discord_import' AS source,
    ow.target_discord_id AS source_discord_id,
    NULL AS unsupported_reason,
    ow.created_at
FROM discord_import_permission_overwrites ow
JOIN discord_imports di ON di.id = ow.import_id
JOIN discord_import_map channel_map
  ON channel_map.import_id = ow.import_id
 AND channel_map.entity_type = 'channel'
 AND channel_map.discord_id = ow.channel_discord_id
LEFT JOIN discord_import_map target_map
  ON target_map.import_id = ow.import_id
 AND target_map.entity_type = CASE WHEN ow.target_type = 'member' THEN 'user' ELSE 'role' END
 AND target_map.discord_id = ow.target_discord_id
WHERE ow.target_type IN ('role','member')
  AND (
    (ow.target_type = 'role' AND ow.target_discord_id = di.guild_id)
    OR target_map.ohiyo_id IS NOT NULL
  );
