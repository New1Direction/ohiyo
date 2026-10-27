-- One independently consented generation per source version. No learner records.
CREATE TABLE burrow_practice_packs (
    source_task TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    source_version INTEGER NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    material TEXT NOT NULL,
    objective TEXT NOT NULL,
    audience TEXT NOT NULL,
    max_cost_cents INTEGER NOT NULL CHECK(max_cost_cents BETWEEN 0 AND 50),
    routing TEXT NOT NULL,
    PRIMARY KEY(source_task, source_version)
);
-- Human decisions refer to the exact generated task version and never spend.
CREATE TABLE burrow_practice_reviews (
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    output_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('approved','withdrawn')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(task_id, revision)
);
