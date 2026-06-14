-- Saved messages: a personal bookmark collection per user.
CREATE TABLE saved_messages (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    saved_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_saved_user ON saved_messages(user_id, saved_at);
