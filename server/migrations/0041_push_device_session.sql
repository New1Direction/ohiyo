-- A push subscription belongs to the session that registered it. token_version is the
-- account's session generation when it was registered. Once the account's moves on
-- (sign out everywhere, Not me, a password change) the device gets no more nudges
-- until a signed-in session registers it again. Devices already registered take the
-- current generation, so nobody's notifications stop when this ships.
ALTER TABLE push_devices ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
UPDATE push_devices
   SET token_version = COALESCE(
     (SELECT token_version FROM users WHERE users.id = push_devices.user_id), 0);
