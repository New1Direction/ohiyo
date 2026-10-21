ALTER TABLE burrow_tasks ADD COLUMN format TEXT NOT NULL DEFAULT 'document'
    CHECK (format IN ('document', 'creation'));

CREATE TABLE burrow_creation_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id) ON DELETE CASCADE,
    result TEXT NOT NULL
);
CREATE INDEX burrow_creation_history_task ON burrow_creation_history(task_id, id DESC);
