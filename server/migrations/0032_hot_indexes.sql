-- Hot-path indexes: both columns are full-scanned on the critical path today.
-- dm_participants(user_id): the DM list runs on every gateway connect.
-- files(uploader_id): the per-user upload-quota sum runs on every upload.
CREATE INDEX IF NOT EXISTS idx_dm_participants_user ON dm_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id);
