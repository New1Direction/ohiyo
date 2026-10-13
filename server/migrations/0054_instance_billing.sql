-- Paid Instant Servers: Stripe billing state for the control plane. Infra/billing
-- metadata only — never message content or keys.

-- One Stripe customer per Ohiyo account, reused across that account's servers and the
-- customer portal.
CREATE TABLE IF NOT EXISTS billing_customers (
    user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    stripe_customer_id  TEXT NOT NULL UNIQUE,
    created_at          INTEGER NOT NULL
);

-- The paid plan of one Instant Server. No foreign key to hosted_instances on purpose:
-- the row must outlive a deleted server so a late Stripe event can still be matched
-- (and a subscription that somehow survived the server is cancelled, not billed on).
-- `status` is 'checkout_pending' until Stripe reports a subscription, then Stripe's own
-- subscription status (active, trialing, past_due, unpaid, canceled, incomplete, …).
CREATE TABLE IF NOT EXISTS instance_subscriptions (
    instance_id             TEXT PRIMARY KEY,
    owner_id                TEXT NOT NULL,
    stripe_customer_id      TEXT NOT NULL,
    stripe_subscription_id  TEXT UNIQUE,
    checkout_session_id     TEXT,
    status                  TEXT NOT NULL,
    cancel_at_period_end    INTEGER NOT NULL DEFAULT 0,
    current_period_end      INTEGER,
    -- `created` of the newest Stripe event applied; older events arriving late are ignored.
    last_event_at           INTEGER NOT NULL DEFAULT 0,
    created_at              INTEGER NOT NULL,
    updated_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instance_subscriptions_owner ON instance_subscriptions(owner_id);

-- Stripe delivers webhooks at least once; processed event ids are remembered here.
CREATE TABLE IF NOT EXISTS stripe_events (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    received_at INTEGER NOT NULL
);
