-- Pinned messages: any channel member can pin a message to highlight it.
ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_messages_pinned ON messages(channel_id, pinned);
