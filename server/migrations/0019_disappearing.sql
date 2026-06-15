-- Disappearing messages: a per-channel TTL. When a channel has
-- `disappearing_seconds` set, every new message gets `expires_at = created_at + ttl`
-- and a background sweeper deletes it server-side once it lapses (so the ciphertext
-- does not linger on the server). Also the mechanical foundation for an account-level
-- dead-man's switch (inactivity-triggered wipe).
ALTER TABLE channels ADD COLUMN disappearing_seconds INTEGER;
ALTER TABLE messages ADD COLUMN expires_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_expires_at ON messages(expires_at);
