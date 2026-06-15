-- Group-DM rekey epoch: bumped on every membership change (add/remove) so the rest
-- of the group rotates its sender keys and a removed member is locked out of all
-- future messages. Stays 0 for every non-group channel (they never rekey this way).
ALTER TABLE channels ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0;

-- Owner of a group DM (its creator). NULL for every other channel kind. Only the
-- owner may remove other members; any member may add people or leave themselves.
ALTER TABLE channels ADD COLUMN owner_id TEXT;
