-- Account/password recovery, NOT an encrypted-chat backup or a second-factor backup.
-- One user-held 256-bit secret per account. Only its domain/account-bound SHA-256
-- digest is stored; issuing a replacement overwrites the previous digest.
CREATE TABLE account_recovery (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
