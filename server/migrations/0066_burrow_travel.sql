-- Transaction/spend journal only. Pi Durable remains the task execution owner.
CREATE TABLE burrow_travel_mandates (
    id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK(version > 0),
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT NOT NULL REFERENCES burrow_tasks(id),
    root_goal_id TEXT NOT NULL REFERENCES burrow_agent_runs(root_goal),
    body TEXT NOT NULL CHECK(json_valid(body)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(id, version)
);
CREATE TRIGGER burrow_travel_mandate_immutable BEFORE UPDATE ON burrow_travel_mandates
BEGIN SELECT RAISE(ABORT, 'mandates are immutable; create a new version'); END;

CREATE TABLE burrow_travel_profiles (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL CHECK(json_valid(body))
);

CREATE TABLE burrow_travel_transactions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    task_id TEXT NOT NULL UNIQUE REFERENCES burrow_tasks(id),
    workspace_id TEXT NOT NULL REFERENCES burrow_computer_workspaces(id),
    root_goal_id TEXT NOT NULL UNIQUE REFERENCES burrow_agent_runs(root_goal),
    mandate_id TEXT NOT NULL,
    mandate_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('researching','quoting','quoted','booking_dispatched','booking_failed','booking_uncertain','reconciling','completed','stopped','unresolved_needs_attention')),
    stopped INTEGER NOT NULL DEFAULT 0,
    request_id TEXT NOT NULL UNIQUE,
    body TEXT NOT NULL CHECK(json_valid(body)),
    reconcile_started_at INTEGER,
    reconcile_attempts INTEGER NOT NULL DEFAULT 0,
    reconcile_next_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(mandate_id, mandate_version) REFERENCES burrow_travel_mandates(id, version)
);

-- Holds survive uncertainty, Stop, timeout and process loss. No payment-rail dispatch
-- is implemented here: prefunded Duffel balance is consumed by booking itself.
CREATE TABLE burrow_travel_spend (
    transaction_id TEXT PRIMARY KEY REFERENCES burrow_travel_transactions(id),
    purpose TEXT NOT NULL CHECK(purpose='hotel_booking'),
    capability TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    currency TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','committed','released')),
    updated_at INTEGER NOT NULL
);

CREATE TABLE burrow_travel_evidence (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id TEXT NOT NULL REFERENCES burrow_travel_transactions(id),
    operation TEXT NOT NULL,
    body TEXT NOT NULL CHECK(json_valid(body)),
    created_at INTEGER NOT NULL
);
