-- Remembers the identity key of a Signal device even after it's removed, so a
-- token-holder can't delete-then-republish a device under the same id with a NEW
-- identity key (which would let them MITM messages fanned out to that device). A
-- reinstall always gets a fresh random device id, so this never blocks legitimate use.
CREATE TABLE IF NOT EXISTS signal_device_tombstones (
    user_id      TEXT    NOT NULL,
    device_id    INTEGER NOT NULL,
    identity_key TEXT    NOT NULL,
    PRIMARY KEY (user_id, device_id)
);
