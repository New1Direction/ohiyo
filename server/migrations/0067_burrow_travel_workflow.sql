ALTER TABLE burrow_tasks ADD COLUMN travel INTEGER NOT NULL DEFAULT 0;
CREATE TABLE burrow_travel_requests (
    task_id TEXT PRIMARY KEY REFERENCES burrow_tasks(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    workspace_id TEXT NOT NULL REFERENCES burrow_computer_workspaces(id),
    mandate_id TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL CHECK(json_valid(body)),
    stage TEXT NOT NULL DEFAULT 'waiting',
    reason TEXT NOT NULL DEFAULT '',
    comparison TEXT NOT NULL DEFAULT '{"options":[],"context":[]}' CHECK(json_valid(comparison)),
    selected_rate_id TEXT,
    fixture_fault TEXT NOT NULL DEFAULT '',
    retry_authorized INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER burrow_travel_request_immutable BEFORE UPDATE OF body,mandate_id,workspace_id,user_id ON burrow_travel_requests
BEGIN SELECT RAISE(ABORT, 'travel admission is immutable'); END;
CREATE TABLE burrow_travel_actions (
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id),
    request_id TEXT NOT NULL,
    body TEXT NOT NULL,
    response TEXT CHECK(response IS NULL OR json_valid(response)),
    PRIMARY KEY(task_id,request_id)
);
-- Disposable provider simulator only. These rows never represent real bookings.
CREATE TABLE burrow_travel_fixture_bookings (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id),
    body TEXT NOT NULL CHECK(json_valid(body))
);
