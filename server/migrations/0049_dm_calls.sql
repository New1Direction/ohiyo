-- Calls in DMs and group chats. A call leaves one message in the chat whose call log the
-- server keeps up to date as JSON: {"state": "ringing" | "ongoing" | "ended" | "missed" |
-- "declined", "video", "started_at", "answered_at", "ended_at", "duration_secs",
-- "declined_by"}. NULL for every other message.
ALTER TABLE messages ADD COLUMN call_log TEXT;
