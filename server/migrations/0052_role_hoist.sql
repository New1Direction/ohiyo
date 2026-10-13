-- A role can list its members separately in the member list ("show members separately",
-- Discord's hoist). Off for every existing role, so nothing changes until someone turns it on.
ALTER TABLE roles ADD COLUMN hoist INTEGER NOT NULL DEFAULT 0;
