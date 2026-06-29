-- Minimal abuse-safety primitives for stranger/community growth.
-- Reports store moderation metadata only; message content may be ciphertext and is not
-- copied into the report. Moderators review by ids/context they are allowed to access.

CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (blocker_id, blocked_id),
    CHECK (blocker_id <> blocked_id)
);
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS hidden_messages (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_hidden_messages_user_channel ON hidden_messages(user_id, channel_id);

CREATE TABLE IF NOT EXISTS abuse_reports (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('message','user','server')),
    target_id TEXT NOT NULL,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    accused_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL,
    details TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','dismissed')),
    created_at INTEGER NOT NULL,
    resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    resolved_at INTEGER,
    resolution_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_server_status ON abuse_reports(server_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_reporter ON abuse_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_accused ON abuse_reports(accused_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS moderation_actions (
    id TEXT PRIMARY KEY,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    report_id TEXT REFERENCES abuse_reports(id) ON DELETE SET NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_server ON moderation_actions(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_actor ON moderation_actions(actor_id, created_at DESC);
