-- Persist the exact request before calling Stripe. A lost response can be retried
-- under the same idempotency key, without creating another payable checkout.
ALTER TABLE instance_subscriptions ADD COLUMN checkout_request TEXT;
