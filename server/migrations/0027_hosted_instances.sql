-- Control-plane registry for Instant Servers. Holds INFRA METADATA ONLY —
-- never message content or E2E keys. One row per provisioned Ohiyo instance.
CREATE TABLE IF NOT EXISTS hosted_instances (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    subdomain   TEXT NOT NULL UNIQUE,
    region      TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','paid')),
    status      TEXT NOT NULL CHECK(status IN ('requested','provisioning','healthy','failed')),
    machine_id  TEXT,
    volume_id   TEXT,
    public_url  TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosted_instances_owner ON hosted_instances(owner_id);
