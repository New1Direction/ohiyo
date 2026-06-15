-- Signal Protocol (X3DH) prekey directory — the infrastructure for forward-secret,
-- async session setup. The server stores only PUBLIC keys; private keys + ratchet
-- state never leave the device. One-time prekeys are consumed (one per session init).

CREATE TABLE IF NOT EXISTS signal_identity (
    user_id           TEXT PRIMARY KEY,
    identity_key      TEXT    NOT NULL, -- base64 identity public key (long-term)
    registration_id   INTEGER NOT NULL,
    signed_prekey_id  INTEGER NOT NULL,
    signed_prekey     TEXT    NOT NULL, -- base64 signed prekey public
    signed_prekey_sig TEXT    NOT NULL, -- base64 signature over the signed prekey
    updated_at        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS signal_one_time_prekeys (
    user_id    TEXT    NOT NULL,
    key_id     INTEGER NOT NULL,
    public_key TEXT    NOT NULL, -- base64
    PRIMARY KEY (user_id, key_id)
);

CREATE INDEX IF NOT EXISTS idx_signal_otk_user ON signal_one_time_prekeys (user_id);
