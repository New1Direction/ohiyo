-- Incoming webhooks (api::webhooks). Each webhook posts as its own account row, so its
-- messages carry an author like any other and keep it after the webhook is deleted. Those
-- rows are marked `is_bot`: they can't sign in, aren't found by search, and can't be
-- messaged, befriended or added to a group.
ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;

CREATE TABLE webhooks (
    id          TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    -- The account its messages are posted as (users.is_bot = 1).
    bot_user_id TEXT NOT NULL REFERENCES users(id),
    name        TEXT NOT NULL,
    -- SHA-256 (hex) of the URL's secret token; the token itself is never stored.
    token_hash  TEXT NOT NULL,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_webhooks_channel ON webhooks(channel_id);
