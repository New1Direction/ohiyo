-- Calls in DMs and group chats. A call leaves one message in the chat whose call log the
-- server keeps up to date as JSON: {"state": "ringing" | "ongoing" | "ended" | "missed" |
-- "declined", "video", "started_at", "answered_at", "ended_at", "duration_secs",
-- "declined_by"}. NULL for every other message.
ALTER TABLE messages ADD COLUMN call_log TEXT;

-- The sweep that closes call logs a restart left open looks only at call logs.
CREATE INDEX idx_messages_call_logs ON messages(created_at) WHERE call_log IS NOT NULL;
