-- User profile extensions
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN pronouns TEXT;
ALTER TABLE users ADD COLUMN banner_color TEXT;
ALTER TABLE users ADD COLUMN social_spotify TEXT;
ALTER TABLE users ADD COLUMN social_github TEXT;
ALTER TABLE users ADD COLUMN social_twitter TEXT;
ALTER TABLE users ADD COLUMN social_steam TEXT;
ALTER TABLE users ADD COLUMN social_youtube TEXT;
ALTER TABLE users ADD COLUMN social_twitch TEXT;
ALTER TABLE users ADD COLUMN custom_status TEXT;
ALTER TABLE users ADD COLUMN theme_data TEXT; -- JSON blob of user theme prefs

-- Uploaded files (content-addressed, unlimited size)
CREATE TABLE files (
    id          TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    filename    TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    path        TEXT NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE INDEX idx_files_sha256 ON files(sha256);

-- Message attachments
ALTER TABLE messages ADD COLUMN attachments TEXT; -- JSON array of file ids

-- User preferences (plugin settings, layout prefs, etc.)
CREATE TABLE user_prefs (
    user_id     TEXT PRIMARY KEY REFERENCES users(id),
    prefs_json  TEXT NOT NULL DEFAULT '{}'
);
