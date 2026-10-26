-- Project knowledge and inert proposals, never chat inputs or executable extensions.
ALTER TABLE burrow_agent_runs ADD COLUMN project_knowledge INTEGER NOT NULL DEFAULT 0 CHECK(project_knowledge IN (0,1));
CREATE TABLE burrow_project_specs (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    content TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, project, revision)
);
CREATE TABLE burrow_project_proposals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    project TEXT NOT NULL,
    source_task TEXT REFERENCES burrow_tasks(id) ON DELETE SET NULL,
    kind TEXT NOT NULL CHECK(kind IN ('spec','skill')),
    base_revision INTEGER NOT NULL CHECK(base_revision >= 0),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN
        ('pending','approved','rejected','testing','tested','test_failed','rolled_back')),
    test_report TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX burrow_project_proposal_scope ON burrow_project_proposals(user_id, project, created_at);
