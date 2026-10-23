-- Explicit approval for an operator-provisioned repository computer, not host execution.
ALTER TABLE burrow_agent_runs ADD COLUMN coding INTEGER NOT NULL DEFAULT 0 CHECK(coding IN (0,1));
-- Saved draft intent survives reloads; only agent-run approval grants computer authority.
ALTER TABLE burrow_tasks ADD COLUMN coding INTEGER NOT NULL DEFAULT 0 CHECK(coding IN (0,1));
