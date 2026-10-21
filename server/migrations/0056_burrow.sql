-- Burrow is separate from chat: no channel messages or encryption keys are inputs.
CREATE TABLE burrow_tasks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'working', 'draft_ready', 'failed')),
    result TEXT NOT NULL DEFAULT '',
    error TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX burrow_tasks_owner ON burrow_tasks(user_id, created_at DESC);

-- Admissions are durable, including failed/uncertain calls. Never auto-retry spending.
CREATE TABLE burrow_attempts (
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    started_at INTEGER NOT NULL
);
CREATE INDEX burrow_attempts_time ON burrow_attempts(started_at);
