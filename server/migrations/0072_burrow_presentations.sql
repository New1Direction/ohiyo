-- Human attestations are append-only and refer to an exact saved task version.
CREATE TABLE burrow_presentation_reviews (
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK(revision > 0),
    source_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('draft','approved','withdrawn')),
    audience TEXT NOT NULL,
    citations TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(task_id, revision)
);
-- One immutable evaluation allowance per material version, not one per HTTP attempt.
CREATE TABLE burrow_presentation_evaluations (
    source_task TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    source_version INTEGER NOT NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    material TEXT NOT NULL,
    max_cost_cents INTEGER NOT NULL CHECK(max_cost_cents BETWEEN 0 AND 50),
    routing TEXT NOT NULL,
    PRIMARY KEY(source_task, source_version)
);
