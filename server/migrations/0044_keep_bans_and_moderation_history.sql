-- When an account was deleted, its bans, moderation actions and reports went with it (ON
-- DELETE CASCADE): every ban it had issued was lifted, and the moderation log lost what
-- it had done. The account's id is now cleared instead (ON DELETE SET NULL): a ban stays
-- in force and the log keeps the action, by an account that no longer exists.
--
-- SQLite can't change a foreign key in place, so each table is rebuilt with the same
-- columns and indexes. sqlx runs every SQLite migration inside a transaction, where
-- PRAGMA foreign_keys can't be switched off, so this works with them on: the rows are
-- set aside in temporary tables, and moderation_actions is dropped before abuse_reports.
-- Dropping a table runs the delete actions of the tables that still point at it, and
-- that order leaves none to run (report_id would otherwise lose its reports).
CREATE TEMP TABLE kept_bans AS SELECT * FROM server_bans;
CREATE TEMP TABLE kept_reports AS SELECT * FROM abuse_reports;
CREATE TEMP TABLE kept_actions AS SELECT * FROM moderation_actions;

DROP TABLE moderation_actions;
DROP TABLE abuse_reports;
DROP TABLE server_bans;

CREATE TABLE server_bans (
    server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    banned_at  INTEGER NOT NULL,
    PRIMARY KEY (server_id, user_id)
);
INSERT INTO server_bans (server_id, user_id, banned_by, banned_at)
    SELECT server_id, user_id, banned_by, banned_at FROM kept_bans;

CREATE TABLE abuse_reports (
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
INSERT INTO abuse_reports (
    id, reporter_id, target_type, target_id, server_id, channel_id, message_id,
    accused_user_id, reason, details, status, created_at, resolved_by, resolved_at,
    resolution_note
)
SELECT
    id, reporter_id, target_type, target_id, server_id, channel_id, message_id,
    accused_user_id, reason, details, status, created_at, resolved_by, resolved_at,
    resolution_note
FROM kept_reports;
CREATE INDEX IF NOT EXISTS idx_abuse_reports_server_status ON abuse_reports(server_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_reporter ON abuse_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_accused ON abuse_reports(accused_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_message ON abuse_reports(message_id);

CREATE TABLE moderation_actions (
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
INSERT INTO moderation_actions (
    id, server_id, actor_id, action, target_type, target_id, report_id, metadata, created_at
)
SELECT id, server_id, actor_id, action, target_type, target_id, report_id, metadata, created_at
FROM kept_actions;
CREATE INDEX IF NOT EXISTS idx_moderation_actions_server ON moderation_actions(server_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_actions_actor ON moderation_actions(actor_id, created_at DESC);

DROP TABLE kept_bans;
DROP TABLE kept_reports;
DROP TABLE kept_actions;
