CREATE TABLE kikka_connections (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, template_id TEXT NOT NULL, model_mapping TEXT NOT NULL,
 active BOOLEAN NOT NULL, priority INTEGER NOT NULL, ciphertext BLOB NOT NULL,
 revision TEXT NOT NULL
);
CREATE INDEX kikka_connections_owner ON kikka_connections(owner,priority);
CREATE TABLE kikka_roles (
 owner TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, roles TEXT NOT NULL
);
ALTER TABLE burrow_agent_runs ADD COLUMN role TEXT NOT NULL DEFAULT 'research';
ALTER TABLE burrow_agent_runs ADD COLUMN routing TEXT;
ALTER TABLE burrow_agent_runs ADD COLUMN usage TEXT;
-- Opaque key versions survive restart without publishing credential fingerprints.
CREATE TABLE kikka_operator_versions (
 id TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, revision TEXT NOT NULL
);
