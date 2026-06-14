-- Polls: a message can carry a poll with options members vote on.
CREATE TABLE polls (
    message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    multi      INTEGER NOT NULL DEFAULT 0,  -- allow voting for multiple options
    closes_at  INTEGER                      -- NULL = never closes
);

CREATE TABLE poll_options (
    id         TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    text       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE poll_votes (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    option_id  TEXT NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, option_id, user_id)
);

CREATE INDEX idx_poll_options_msg ON poll_options(message_id, position);
CREATE INDEX idx_poll_votes_msg ON poll_votes(message_id);
