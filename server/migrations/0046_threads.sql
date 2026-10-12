-- Threads: a reply chain started from one message in a space's text channel. A thread is a
-- channel row that hangs off its parent channel (same space). It takes the parent's
-- permissions, it is left out of the space's channel list, and it is deleted with the parent.
-- thread_message_id has no foreign key on purpose: deleting the first message keeps the
-- thread (the app says the first message was deleted).
ALTER TABLE channels ADD COLUMN parent_id TEXT REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE channels ADD COLUMN thread_message_id TEXT;

-- One thread per message (NULLs, i.e. every ordinary channel, don't collide).
CREATE UNIQUE INDEX idx_channels_thread_message ON channels(thread_message_id);
CREATE INDEX idx_channels_parent ON channels(parent_id);
