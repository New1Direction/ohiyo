-- One-time, short-lived codes that link a NEW device to an account without re-entering
-- the password. The primary device mints a code (shown as text/QR); the new device
-- redeems it for a session token. Single-use (deleted on redeem) + short TTL.
CREATE TABLE IF NOT EXISTS device_link_tokens (
    code       TEXT    PRIMARY KEY,
    user_id    TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
);
