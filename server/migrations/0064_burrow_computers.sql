-- Computer scope is a Burrow authorization record, not an ImOrb runtime task.
CREATE TABLE burrow_computer_workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX burrow_computer_workspace_owner ON burrow_computer_workspaces(user_id);
ALTER TABLE burrow_agent_runs ADD COLUMN computer_workspace TEXT REFERENCES burrow_computer_workspaces(id);
