-- End-to-end encryption: each user publishes an ECDH public key (JWK string) so
-- peers can derive a shared secret. Private keys never reach the server. Nullable
-- (users who haven't generated a key yet).
ALTER TABLE users ADD COLUMN public_key TEXT;
