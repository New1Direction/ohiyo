-- Real content-free push dispatch lifecycle.
-- Rows still contain no message text/channel names/file names; this only tracks attempts.

PRAGMA foreign_keys=off;

ALTER TABLE push_deliveries RENAME TO push_deliveries_old;

CREATE TABLE push_deliveries (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id       TEXT REFERENCES push_devices(id) ON DELETE SET NULL,
    kind            TEXT NOT NULL CHECK(kind IN ('message','test')),
    status          TEXT NOT NULL CHECK(status IN ('queued','delivered','failed','skipped')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_attempt_at INTEGER,
    next_attempt_at INTEGER,
    dispatched_at   INTEGER,
    last_error      TEXT
);

INSERT INTO push_deliveries (
    id, user_id, device_id, kind, status, attempts, created_at,
    last_attempt_at, next_attempt_at, dispatched_at, last_error
)
SELECT
    id, user_id, device_id, kind, status, 0, created_at,
    NULL, NULL, NULL, NULL
FROM push_deliveries_old;

DROP TABLE push_deliveries_old;

PRAGMA foreign_keys=on;

CREATE INDEX IF NOT EXISTS idx_push_deliveries_user ON push_deliveries(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_dispatch ON push_deliveries(status, next_attempt_at, created_at);
