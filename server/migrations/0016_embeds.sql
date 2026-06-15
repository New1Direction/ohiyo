-- Link-preview embeds: a JSON array string of resolved Open Graph cards, populated
-- asynchronously after a message with URLs is sent (mirrors the attachments column).
-- Nullable + no default so existing rows and embed-less messages stay valid.
ALTER TABLE messages ADD COLUMN embeds TEXT;
