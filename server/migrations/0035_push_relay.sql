-- Content-free push relay registry. Stores device endpoints/tokens and queued
-- notification events only; never message text, filenames, channel names, or E2E keys.
CREATE TABLE IF NOT EXISTS push_devices (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform    TEXT NOT NULL CHECK(platform IN ('web','apns','fcm')),
    endpoint    TEXT NOT NULL,
    p256dh      TEXT,
    auth        TEXT,
    device_name TEXT,
    enabled     INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE(user_id, endpoint)
);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id, enabled);

CREATE TABLE IF NOT EXISTS push_deliveries (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id   TEXT REFERENCES push_devices(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL CHECK(kind IN ('message','test')),
    status      TEXT NOT NULL CHECK(status IN ('queued','skipped','failed')),
    created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_deliveries_user ON push_deliveries(user_id, created_at DESC);
