-- Encrypted E2E key-backup blob, one per user. The server only ever stores
-- ciphertext (AES-GCM, wrapped under the user's recovery code on the client);
-- it never sees the recovery code or the key material.
CREATE TABLE IF NOT EXISTS key_backups (
    user_id    TEXT PRIMARY KEY,
    blob       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
);
