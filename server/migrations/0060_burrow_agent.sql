-- Burrow owns admission/identity; ImOrb remains the execution journal authority.
CREATE TABLE burrow_agent_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    request_version INTEGER NOT NULL,
    target TEXT NOT NULL,
    root_goal TEXT NOT NULL UNIQUE,
    goal TEXT NOT NULL,
    max_cost_cents INTEGER NOT NULL CHECK(max_cost_cents BETWEEN 1 AND 50),
    runtime_id TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('queued','dispatching','attached','review','finished')),
    activity TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    UNIQUE(task_id, request_version)
);
CREATE INDEX burrow_agent_pending ON burrow_agent_runs(phase);

-- Commands have a durable outbox, not Pi's process-local steering queue.
CREATE TABLE burrow_agent_commands (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES burrow_agent_runs(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('steer','stop','continue','resume')),
    message TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','dispatching','sent','review','discarded')),
    PRIMARY KEY(run_id, id)
);
CREATE TABLE burrow_agent_events (
    run_id TEXT NOT NULL REFERENCES burrow_agent_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY(run_id, seq)
);
