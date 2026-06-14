-- Message replies: a message may quote another message in the same channel.
ALTER TABLE messages ADD COLUMN reply_to TEXT REFERENCES messages(id) ON DELETE SET NULL;
