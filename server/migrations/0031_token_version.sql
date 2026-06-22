-- Per-user token generation counter for JWT revocation ("log out everywhere").
-- Each issued token carries the user's token_version at mint time; bumping this
-- column invalidates every token minted before the bump. Defaults to 0 so existing
-- users and already-issued tokens (which carry version 0) remain valid until a bump.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;
