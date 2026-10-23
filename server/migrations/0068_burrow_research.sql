-- Workspace data is independent of generated documents and bounded event views.
CREATE TABLE burrow_research (
    task_id TEXT PRIMARY KEY REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    workspace TEXT NOT NULL
);
CREATE TABLE burrow_research_changes (
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    change TEXT NOT NULL,
    PRIMARY KEY(task_id, version)
);
-- Idempotent ingestion and its plain-text presentation survive event pruning.
CREATE TABLE burrow_research_ingested (
    run_id TEXT NOT NULL REFERENCES burrow_agent_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    comparison_id TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    PRIMARY KEY(run_id, seq)
);
ALTER TABLE burrow_agent_runs ADD COLUMN requirements TEXT;
ALTER TABLE burrow_agent_commands ADD COLUMN requirements TEXT;
