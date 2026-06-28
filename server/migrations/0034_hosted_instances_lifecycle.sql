-- Expand Instant Server lifecycle states for sleep/wake/suspend UX.
-- SQLite cannot ALTER a CHECK constraint in-place, so rebuild the registry table.
PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS hosted_instances_next (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    subdomain   TEXT NOT NULL UNIQUE,
    region      TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','paid')),
    status      TEXT NOT NULL CHECK(status IN ('requested','provisioning','healthy','sleeping','waking','failed','suspended')),
    machine_id  TEXT,
    volume_id   TEXT,
    public_url  TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

INSERT INTO hosted_instances_next
SELECT id, owner_id, name, subdomain, region, tier, status, machine_id, volume_id, public_url, error, created_at, updated_at
FROM hosted_instances;

DROP TABLE hosted_instances;
ALTER TABLE hosted_instances_next RENAME TO hosted_instances;
CREATE INDEX IF NOT EXISTS idx_hosted_instances_owner ON hosted_instances(owner_id);

PRAGMA foreign_keys=on;
