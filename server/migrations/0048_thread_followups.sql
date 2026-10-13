-- Threads, the rest of the way: who started each one (they may rename or delete it), and who
-- follows which. A followed thread counts as unread and notifies like a channel; the rest only
-- notify on an @mention. A thread started before this has no recorded starter (null), and the
-- starter's id is cleared if they delete their account; managers can still rename or delete it.
ALTER TABLE channels ADD COLUMN thread_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE thread_follows (
    user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id  TEXT    NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, thread_id)
);
CREATE INDEX idx_thread_follows_thread ON thread_follows(thread_id);

-- Replying follows a thread, so everyone who has already replied in one follows it.
INSERT OR IGNORE INTO thread_follows (user_id, thread_id, created_at)
SELECT DISTINCT m.author_id, m.channel_id, CAST(strftime('%s', 'now') AS INTEGER)
  FROM messages m
  JOIN channels c ON c.id = m.channel_id
  JOIN users u ON u.id = m.author_id
 WHERE c.parent_id IS NOT NULL;
