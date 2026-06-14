-- Scheduled events: plan hangouts with RSVPs.
CREATE TABLE events (
    id          TEXT PRIMARY KEY,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    starts_at   INTEGER NOT NULL,
    created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL
);

CREATE TABLE event_rsvps (
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (event_id, user_id)
);

CREATE INDEX idx_events_server ON events(server_id, starts_at);
