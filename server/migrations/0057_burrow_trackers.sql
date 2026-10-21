ALTER TABLE burrow_tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'writing'
    CHECK (kind IN ('writing', 'tracker'));

CREATE TABLE burrow_tracker_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    result TEXT NOT NULL
);
CREATE INDEX burrow_tracker_history_task ON burrow_tracker_history(task_id, id DESC);
