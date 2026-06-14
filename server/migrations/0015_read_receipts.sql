-- Per-user read cursor per channel. Powers read receipts (Delivered/Seen) and
-- is the foundation for accurate unread counts. One row per (channel, user);
-- `last_read_at` mirrors the acked message's created_at so "seen" comparisons
-- are monotonic even though message ids are random UUIDs (not time-ordered).
CREATE TABLE IF NOT EXISTS channel_reads (
    channel_id           TEXT    NOT NULL,
    user_id              TEXT    NOT NULL,
    last_read_message_id TEXT,
    last_read_at         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_reads_channel ON channel_reads (channel_id);
