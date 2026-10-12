-- no-transaction
-- When an account was deleted, its bans, moderation actions and reports went with it (ON
-- DELETE CASCADE): every ban it had issued was lifted, and the moderation log lost what
-- it had done. The account's id is now cleared instead (ON DELETE SET NULL): a ban stays
-- in force and the log keeps the action, by an account that no longer exists.
--
-- SQLite can't change a foreign key in place, so each table is rebuilt: create, copy,
-- drop, rename, with the same columns and indexes. Foreign keys are off while that runs,
-- because dropping a table with them on runs the delete actions of the tables that point
-- at it (moderation_actions.report_id would lose its reports). PRAGMA foreign_keys can't
-- change inside a transaction, so this migration manages its own (the first line tells
-- sqlx); the rebuild itself is all-or-nothing.
PRAGMA foreign_keys = OFF;
BEGIN;

CREATE TABLE server_bans_rebuilt (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    banned_at  INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);
INSERT INTO server_bans_rebuilt (server_id, user_id, banned_by, banned_at)
    SELECT server_id, user_id, banned_by, banned_at FROM server_bans;
DROP TABLE server_bans;
ALTER TABLE server_bans_rebuilt RENAME TO server_bans;

CREATE TABLE abuse_reports_rebuilt (
    id TEXT PRIMARY KEY,
    reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
INSERT INTO abuse_reports_rebuilt (
    id, reporter_id, target_type, target_id, server_id, channel_id, message_id,
    accused_user_id, reason, details, status, created_at, resolved_by, resolved_at,
    resolution_note
)
SELECT
    id, reporter_id, target_type, target_id, server_id, channel_id, message_id,
    accused_user_id, reason, details, status, created_at, resolved_by, resolved_at,
    resolution_note
FROM abuse_reports;
DROP TABLE abuse_reports;
ALTER TABLE abuse_reports_rebuilt RENAME TO abuse_reports;
CREATE INDEX IF NOT EXISTS idx_abuse_reports_server_status ON abuse_reports(server_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_reporter ON abuse_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_accused ON abuse_reports(accused_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_message ON abuse_reports(message_id);

CREATE TABLE moderation_actions_rebuilt (
    id TEXT PRIMARY KEY,
    server_id TEXT REFERENCES servers(id) ON DELETE SET NULL,
    actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    report_id TEXT REFERENCES abuse_reports(id) ON DELETE SET NULL,
    metadata TEXT,
    created_at INTEGER NOT NULL
);
INSERT INTO moderation_actions_rebuilt (
    id, server_id, actor_id, action, target_type, target_id, report_id, metadata, created_at
)
SELECT id, server_id, actor_id, action, target_type, target_id, report_id, metadata, created_at
FROM moderation_actions;
DROP TABLE moderation_actions;
ALTER TABLE moderation_actions_rebuilt RENAME TO moderation_actions;
CREATE INDEX IF NOT EXISTS idx_moderation_actions_server ON moderation_actions(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_actor ON moderation_actions(actor_id, created_at DESC);

COMMIT;
PRAGMA foreign_keys = ON;
