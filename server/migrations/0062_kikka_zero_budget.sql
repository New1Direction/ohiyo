-- Allow an explicitly approved $0 task without rewriting previous admissions.
-- Rebuild dependent journals together so foreign-key cascades cannot erase them.
CREATE TABLE burrow_agent_runs_new (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    request_version INTEGER NOT NULL,
    target TEXT NOT NULL,
    root_goal TEXT NOT NULL UNIQUE,
    goal TEXT NOT NULL,
    max_cost_cents INTEGER NOT NULL CHECK(max_cost_cents BETWEEN 0 AND 50),
    runtime_id TEXT,
    phase TEXT NOT NULL CHECK(phase IN ('queued','dispatching','attached','review','finished')),
    activity TEXT NOT NULL,
    last_seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'research',
    routing TEXT,
    usage TEXT,
    UNIQUE(task_id, request_version)
);
INSERT INTO burrow_agent_runs_new SELECT * FROM burrow_agent_runs;

CREATE TABLE burrow_agent_commands_new (
    id TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES burrow_agent_runs_new(id) ON DELETE CASCADE,
    action TEXT NOT NULL CHECK(action IN ('steer','stop','continue','resume')),
    message TEXT NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('queued','dispatching','sent','review','discarded')),
    PRIMARY KEY(run_id, id)
);
INSERT INTO burrow_agent_commands_new SELECT * FROM burrow_agent_commands;
CREATE TABLE burrow_agent_events_new (
    run_id TEXT NOT NULL REFERENCES burrow_agent_runs_new(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    event TEXT NOT NULL,
    PRIMARY KEY(run_id, seq)
);
INSERT INTO burrow_agent_events_new SELECT * FROM burrow_agent_events;

DROP TABLE burrow_agent_commands;
DROP TABLE burrow_agent_events;
DROP TABLE burrow_agent_runs;
ALTER TABLE burrow_agent_runs_new RENAME TO burrow_agent_runs;
ALTER TABLE burrow_agent_commands_new RENAME TO burrow_agent_commands;
ALTER TABLE burrow_agent_events_new RENAME TO burrow_agent_events;
CREATE INDEX burrow_agent_pending ON burrow_agent_runs(phase);
