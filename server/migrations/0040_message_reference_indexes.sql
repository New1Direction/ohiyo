-- Columns looked up when a message or a user goes (reply previews, the dead-man's-switch
-- wipe, ON DELETE CASCADE / SET NULL from messages). Without an index that leads with
-- them, each such delete scans the whole table.
CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_hidden_messages_message ON hidden_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_saved_messages_message ON saved_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_message ON abuse_reports(message_id);
