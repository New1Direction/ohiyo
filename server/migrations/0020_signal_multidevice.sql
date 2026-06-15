-- Multi-device E2E: the Signal prekey directory becomes per-(user, device). Each
-- device publishes its own identity + prekeys, and a sender fetches every device's
-- bundle to fan out an encrypted copy to each. Recreated (vs ALTER) because SQLite
-- can't repoint a primary key; published keys are re-uploaded by clients on next login.
DROP TABLE IF EXISTS signal_one_time_prekeys;
DROP TABLE IF EXISTS signal_identity;

CREATE TABLE signal_identity (
    user_id           TEXT    NOT NULL,
    device_id         INTEGER NOT NULL,
    identity_key      TEXT    NOT NULL,
    registration_id   INTEGER NOT NULL,
    signed_prekey_id  INTEGER NOT NULL,
    signed_prekey     TEXT    NOT NULL,
    signed_prekey_sig TEXT    NOT NULL,
    updated_at        INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id)
);

CREATE TABLE signal_one_time_prekeys (
    user_id    TEXT    NOT NULL,
    device_id  INTEGER NOT NULL,
    key_id     INTEGER NOT NULL,
    public_key TEXT    NOT NULL,
    PRIMARY KEY (user_id, device_id, key_id)
);
CREATE INDEX IF NOT EXISTS idx_otk_user_device ON signal_one_time_prekeys(user_id, device_id);
