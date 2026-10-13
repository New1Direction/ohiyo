-- Two-factor sign-in with an authenticator app (api::two_factor, auth::two_factor).

-- One row per account that has started or finished turning it on. The secret is stored
-- encrypted (nonce || AES-256-GCM ciphertext, the user id as associated data). `enabled_at`
-- is NULL while it's being set up, until the first working code. `last_step` is the newest
-- time step a code was accepted for, so a code can't be used twice.
CREATE TABLE two_factor (
    user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret_enc  BLOB NOT NULL,
    enabled_at  INTEGER,
    last_step   INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);

-- Single-use recovery codes, stored as SHA-256 of the account id and the code.
CREATE TABLE two_factor_recovery_codes (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash  TEXT NOT NULL,
    used_at    INTEGER,
    PRIMARY KEY (user_id, code_hash)
);

-- A sign-in that got the password right and now needs a code. Stored by the hash of its
-- token, good for 5 minutes and one use, and given up after 10 wrong codes.
CREATE TABLE two_factor_challenges (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  INTEGER NOT NULL,
    failures    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_two_factor_challenges_user ON two_factor_challenges(user_id);
