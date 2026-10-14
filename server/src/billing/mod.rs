//! Paid Instant Servers: the billing state machine behind the ~$8/community/month plan.
//!
//! [`BillingProvider`] is the seam to the payment processor (Stripe in production, a
//! local stand-in in tests). This module owns the durable state in
//! `instance_subscriptions` and derives an instance's `tier` from it: a server is `paid`
//! while its subscription is active, trialing or past due (Stripe is still retrying the
//! card), and drops back to `free` once Stripe gives up or the owner cancels.
//! Billing never sees message content or keys.

pub mod stripe;

use crate::provision::MachineProvisioner;
use crate::types::now_unix;
use async_trait::async_trait;
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BillingError {
    #[error("billing upstream error: {0}")]
    Upstream(String),
    #[error("billing object not found")]
    NotFound,
    #[error("webhook signature is invalid")]
    BadSignature,
}

/// What the control plane asks the processor to sell.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CheckoutRequest {
    pub idempotency_key: String,
    pub expires_at: i64,
    pub customer_id: String,
    pub instance_id: String,
    pub owner_id: String,
    pub success_url: String,
    pub cancel_url: String,
}

#[derive(Debug, Clone)]
pub struct CheckoutSession {
    pub id: String,
    pub url: String,
}

// See provision::MachineProvisioner for why clippy::double_must_use is allowed.
#[allow(clippy::double_must_use)]
#[async_trait]
pub trait BillingProvider: Send + Sync {
    /// Only test-mode payments may target a simulated machine.
    fn test_mode(&self) -> bool;
    /// Create the processor-side customer for an Ohiyo account. Must be idempotent per
    /// user, so two racing checkouts don't make two customers.
    async fn create_customer(&self, user_id: &str) -> Result<String, BillingError>;
    async fn create_checkout(&self, req: &CheckoutRequest)
        -> Result<CheckoutSession, BillingError>;
    /// Close an unfinished checkout so it can't be paid after a newer one was started.
    async fn expire_checkout(&self, session_id: &str) -> Result<(), BillingError>;
    /// A self-service portal link (payment method, invoices, cancel/resume).
    async fn create_portal(
        &self,
        customer_id: &str,
        return_url: &str,
    ) -> Result<String, BillingError>;
    async fn cancel_at_period_end(&self, subscription_id: &str) -> Result<(), BillingError>;
    async fn cancel_now(&self, subscription_id: &str) -> Result<(), BillingError>;
    /// Fetch current state; webhook snapshots are not ordered, even within one second.
    async fn subscription(&self, subscription_id: &str)
        -> Result<SubscriptionUpdate, BillingError>;
    async fn checkout(&self, session_id: &str) -> Result<Value, BillingError>;
    /// Check that a webhook body really came from the processor.
    fn verify_webhook(&self, payload: &[u8], signature: &str, now: i64)
        -> Result<(), BillingError>;
}

/// Billing as configured on this server: the provider plus the product settings the
/// app shows. `None` in `AppState` means paid plans are off.
#[derive(Clone)]
pub struct Billing {
    pub provider: Arc<dyn BillingProvider>,
    /// Where checkout and the portal send people back to (the web app's origin).
    pub app_url: String,
    /// The price as shown in the app, for example "$8/month". The amount actually charged
    /// is the Stripe price's; keep the two in step.
    pub price_label: String,
}

impl Billing {
    /// Read once at startup; `None` unless Stripe is fully configured.
    pub fn from_env() -> Option<Self> {
        let provider = stripe::StripeBilling::from_env()?;
        Some(Billing {
            provider: Arc::new(provider),
            app_url: env_or("OHIYO_APP_URL", "https://app.ohiyo.gg")
                .trim_end_matches('/')
                .to_owned(),
            price_label: env_or("OHIYO_PAID_PRICE_LABEL", "$8/month"),
        })
    }
}

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default.to_owned())
}

/// Stripe subscription statuses that keep a server on the paid plan. `past_due` is the
/// grace period while Stripe retries the card; `unpaid`, `canceled`, `incomplete`,
/// `incomplete_expired` and `paused` (and our own `checkout_pending`) do not.
pub fn is_paid_status(status: &str) -> bool {
    matches!(status, "active" | "trialing" | "past_due")
}

fn is_terminal(status: &str) -> bool {
    matches!(status, "canceled" | "incomplete_expired")
}

/// Where this deployment runs Instant Servers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provisioner {
    /// Real Fly Machines.
    Live,
    /// The in-memory fake of a development build: nothing really runs.
    Simulated,
    /// Neither: Instant Servers are off.
    Off,
}

pub fn provisioner_kind(has_fly_token: bool, debug_build: bool) -> Provisioner {
    if has_fly_token {
        Provisioner::Live
    } else if debug_build {
        Provisioner::Simulated
    } else {
        Provisioner::Off
    }
}

/// Whether the paid plan can be bought here, and if not, why — in words the app shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaidPlan {
    pub available: bool,
    pub price_label: Option<String>,
    pub reason: Option<String>,
}

/// Selling "stays on" needs both a way to take payment and machines that really run.
pub fn paid_plan(billing: Option<&Billing>, provisioner: Provisioner) -> PaidPlan {
    let price_label = billing.map(|b| b.price_label.clone());
    let reason = match (billing.is_some(), provisioner) {
        (_, Provisioner::Off) => Some(
            "Managed hosting is offline on this server, so the paid plan can't be bought here."
                .to_owned(),
        ),
        (false, _) => Some("Payments aren't set up on this server yet.".to_owned()),
        (true, Provisioner::Simulated) if !billing.is_some_and(|b| b.provider.test_mode()) => {
            Some("Real payments require live managed hosting, not simulated servers.".to_owned())
        }
        (true, _) => None,
    };
    PaidPlan {
        available: reason.is_none(),
        price_label,
        reason,
    }
}

/// One server's paid plan, as stored.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct InstanceSubscription {
    pub instance_id: String,
    pub owner_id: String,
    pub stripe_customer_id: String,
    pub stripe_subscription_id: Option<String>,
    pub checkout_session_id: Option<String>,
    pub checkout_request: Option<String>,
    pub status: String,
    pub cancel_at_period_end: bool,
    pub current_period_end: Option<i64>,
    pub last_event_at: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What the app is told about a server's paid plan. No processor ids.
#[derive(Debug, Clone, Serialize)]
pub struct BillingSummary {
    pub status: String,
    pub cancel_at_period_end: bool,
    pub current_period_end: Option<i64>,
}

impl From<&InstanceSubscription> for BillingSummary {
    fn from(s: &InstanceSubscription) -> Self {
        BillingSummary {
            status: s.status.clone(),
            cancel_at_period_end: s.cancel_at_period_end,
            current_period_end: s.current_period_end,
        }
    }
}

type ApiError = (StatusCode, String);

fn upstream(e: BillingError) -> ApiError {
    tracing::warn!(error = %e, "billing provider call failed");
    (
        StatusCode::BAD_GATEWAY,
        "the payment service didn't answer — try again in a moment".into(),
    )
}

pub async fn subscription_for(
    db: &sqlx::SqlitePool,
    instance_id: &str,
) -> Result<Option<InstanceSubscription>, ApiError> {
    sqlx::query_as::<_, InstanceSubscription>(
        "SELECT * FROM instance_subscriptions WHERE instance_id = ?",
    )
    .bind(instance_id)
    .fetch_optional(db)
    .await
    .map_err(crate::api::error::internal)
}

pub async fn subscriptions_for_owner(
    db: &sqlx::SqlitePool,
    owner_id: &str,
) -> Result<Vec<InstanceSubscription>, ApiError> {
    sqlx::query_as::<_, InstanceSubscription>(
        "SELECT * FROM instance_subscriptions WHERE owner_id = ?",
    )
    .bind(owner_id)
    .fetch_all(db)
    .await
    .map_err(crate::api::error::internal)
}

pub async fn customer_for(
    db: &sqlx::SqlitePool,
    user_id: &str,
) -> Result<Option<String>, ApiError> {
    sqlx::query_scalar("SELECT stripe_customer_id FROM billing_customers WHERE user_id = ?")
        .bind(user_id)
        .fetch_optional(db)
        .await
        .map_err(crate::api::error::internal)
}

async fn ensure_customer(
    db: &sqlx::SqlitePool,
    provider: &dyn BillingProvider,
    user_id: &str,
) -> Result<String, ApiError> {
    if let Some(id) = customer_for(db, user_id).await? {
        return Ok(id);
    }
    let created = provider.create_customer(user_id).await.map_err(upstream)?;
    // A racing request may have stored one first; the provider call is idempotent per
    // user, so both hold the same id, and whichever row exists wins.
    sqlx::query(
        "INSERT OR IGNORE INTO billing_customers (user_id, stripe_customer_id, created_at)
         VALUES (?, ?, ?)",
    )
    .bind(user_id)
    .bind(&created)
    .bind(now_unix())
    .execute(db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(customer_for(db, user_id).await?.unwrap_or(created))
}

/// Start a checkout for the paid plan of `inst`, which the caller has already checked
/// belongs to `owner_id`. Returns the processor's hosted checkout URL.
pub async fn start_checkout(
    db: &sqlx::SqlitePool,
    billing: &Billing,
    owner_id: &str,
    inst: &crate::types::HostedInstance,
) -> Result<String, ApiError> {
    if !matches!(inst.status.as_str(), "healthy" | "sleeping" | "waking") {
        return Err((
            StatusCode::CONFLICT,
            "this server isn't running yet, so it can't be upgraded".into(),
        ));
    }
    let existing = subscription_for(db, &inst.id).await?;
    if inst.tier == "paid"
        || existing
            .as_ref()
            .is_some_and(|s| s.stripe_subscription_id.is_some() && !is_terminal(&s.status))
    {
        return Err((
            StatusCode::CONFLICT,
            "this server already has a subscription; manage it in the billing portal".into(),
        ));
    }
    let provider = billing.provider.as_ref();
    let customer_id = ensure_customer(db, provider, owner_id).await?;

    if let Some(old) = existing.as_ref().filter(|s| s.status == "checkout_pending") {
        let session_id = recover_checkout(db, provider, old).await?;
        if let Some(id) = session_id {
            let session = provider.checkout(&id).await.map_err(upstream)?;
            match session["status"].as_str() {
                Some("open") => {
                    return session["url"].as_str().map(str::to_owned).ok_or_else(|| {
                        upstream(BillingError::Upstream("checkout has no URL".into()))
                    })
                }
                Some("expired") => {}
                _ => {
                    return Err((
                        StatusCode::CONFLICT,
                        "checkout is complete; waiting for payment confirmation".into(),
                    ))
                }
            }
        }
    }

    let back = |outcome: &str| {
        format!(
            "{}/?instant_billing={outcome}&instance={}",
            billing.app_url, inst.id
        )
    };
    let now = now_unix();
    let request = CheckoutRequest {
        idempotency_key: crate::types::new_id(),
        expires_at: now + 3600,
        customer_id: customer_id.clone(),
        instance_id: inst.id.clone(),
        owner_id: owner_id.to_owned(),
        success_url: back("success"),
        cancel_url: back("canceled"),
    };
    sqlx::query(
        "INSERT INTO instance_subscriptions
         (instance_id, owner_id, stripe_customer_id, checkout_request, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'checkout_pending', ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           owner_id = excluded.owner_id,
           stripe_customer_id = excluded.stripe_customer_id,
           checkout_request = excluded.checkout_request,
           checkout_session_id = NULL,
           stripe_subscription_id = NULL,
           current_period_end = NULL,
           last_event_at = 0,
           status = 'checkout_pending',
           cancel_at_period_end = 0,
           updated_at = excluded.updated_at",
    )
    .bind(&inst.id)
    .bind(owner_id)
    .bind(&customer_id)
    .bind(serde_json::to_string(&request).map_err(crate::api::error::internal)?)
    .bind(now)
    .bind(now)
    .execute(db)
    .await
    .map_err(crate::api::error::internal)?;
    let session = provider.create_checkout(&request).await.map_err(upstream)?;
    save_checkout(db, &inst.id, &session.id).await?;
    Ok(session.url)
}

async fn save_checkout(
    db: &sqlx::SqlitePool,
    instance: &str,
    session: &str,
) -> Result<(), ApiError> {
    sqlx::query("UPDATE instance_subscriptions SET checkout_session_id = ? WHERE instance_id = ?")
        .bind(session)
        .bind(instance)
        .execute(db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(())
}

async fn recover_checkout(
    db: &sqlx::SqlitePool,
    provider: &dyn BillingProvider,
    row: &InstanceSubscription,
) -> Result<Option<String>, ApiError> {
    if let Some(id) = &row.checkout_session_id {
        return Ok(Some(id.clone()));
    }
    let Some(saved) = &row.checkout_request else {
        return Ok(None);
    };
    let request: CheckoutRequest =
        serde_json::from_str(saved).map_err(crate::api::error::internal)?;
    // Stripe may discard idempotency keys after 24h. Never recreate an ambiguous old
    // checkout then: an operator must locate it in Stripe before clearing this row.
    if now_unix() >= request.expires_at + 22 * 3600 {
        return Err((
            StatusCode::CONFLICT,
            "checkout needs operator reconciliation".into(),
        ));
    }
    let session = provider.create_checkout(&request).await.map_err(upstream)?;
    save_checkout(db, &row.instance_id, &session.id).await?;
    Ok(Some(session.id))
}

/// Ask the processor to end the plan at the end of the paid period. The server stays
/// paid until then; the webhook that follows confirms the change.
pub async fn cancel_at_period_end(
    db: &sqlx::SqlitePool,
    billing: &Billing,
    instance_id: &str,
) -> Result<(), ApiError> {
    let sub = subscription_for(db, instance_id)
        .await?
        .filter(|s| is_paid_status(&s.status));
    let Some(subscription_id) = sub.and_then(|s| s.stripe_subscription_id) else {
        return Err((
            StatusCode::CONFLICT,
            "this server has no paid plan to cancel".into(),
        ));
    };
    billing
        .provider
        .cancel_at_period_end(&subscription_id)
        .await
        .map_err(upstream)?;
    sqlx::query(
        "UPDATE instance_subscriptions SET cancel_at_period_end = 1, updated_at = ?
         WHERE instance_id = ?",
    )
    .bind(now_unix())
    .bind(instance_id)
    .execute(db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(())
}

/// Before a server is deleted: end its paid plan now, so nobody is billed for a server
/// that no longer exists. Fails (and the delete must stop) if that can't be done.
pub async fn release_instance(
    db: &sqlx::SqlitePool,
    billing: Option<&Billing>,
    instance_id: &str,
) -> Result<(), ApiError> {
    let Some(sub) = subscription_for(db, instance_id).await? else {
        return Ok(());
    };
    if let Some(subscription_id) = sub.stripe_subscription_id.as_deref() {
        let Some(billing) = billing else {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                "this server has a paid plan, and payments are offline here, so it can't be cancelled right now".into(),
            ));
        };
        match billing.provider.cancel_now(subscription_id).await {
            Ok(()) | Err(BillingError::NotFound) => {}
            Err(e) => return Err(upstream(e)),
        }
    }
    if sub.status == "checkout_pending" {
        let billing = billing.ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "payments are offline; checkout cannot be closed".into(),
        ))?;
        if let Some(id) = recover_checkout(db, billing.provider.as_ref(), &sub).await? {
            let session = billing.provider.checkout(&id).await.map_err(upstream)?;
            if session["status"].as_str() == Some("open") {
                // A concurrent payment makes expiration fail: retry deletion, then
                // retrieve the completed session and cancel its subscription below.
                billing
                    .provider
                    .expire_checkout(&id)
                    .await
                    .map_err(upstream)?;
            } else if let Some(id) = str_field(&session, "subscription") {
                match billing.provider.cancel_now(&id).await {
                    Ok(()) | Err(BillingError::NotFound) => {}
                    Err(e) => return Err(upstream(e)),
                }
            } else if session["status"].as_str() != Some("expired") {
                return Err((StatusCode::CONFLICT, "checkout has not settled".into()));
            }
        }
    }
    let mut tx = db.begin().await.map_err(crate::api::error::internal)?;
    sqlx::query(
        "UPDATE instance_subscriptions SET status = 'canceled', cancel_at_period_end = 0, updated_at = ?
         WHERE instance_id = ?",
    )
    .bind(now_unix())
    .bind(instance_id)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    sqlx::query("UPDATE hosted_instances SET tier = 'free' WHERE id = ?")
        .bind(instance_id)
        .execute(&mut *tx)
        .await
        .map_err(crate::api::error::internal)?;
    tx.commit().await.map_err(crate::api::error::internal)?;
    Ok(())
}

// ── Webhook events ────────────────────────────────────────────────────────────

/// The part of a Stripe event that moves a server's plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionUpdate {
    /// From the metadata the checkout stamped on the session and subscription.
    pub instance_id: Option<String>,
    pub subscription_id: String,
    pub customer_id: String,
    pub status: String,
    pub cancel_at_period_end: Option<bool>,
    pub current_period_end: Option<i64>,
    /// Diagnostic event time only; current Stripe state, not timestamps, orders updates.
    pub event_created: i64,
}

fn str_field(v: &Value, key: &str) -> Option<String> {
    // Expandable fields are either an id string or an object with an id.
    match &v[key] {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Object(o) => o.get("id").and_then(Value::as_str).map(str::to_owned),
        _ => None,
    }
}

/// Read a Stripe event into a plan change, or `None` for events this ignores.
pub fn parse_event(event: &Value) -> Option<SubscriptionUpdate> {
    let kind = event["type"].as_str()?;
    let obj = &event["data"]["object"];
    let event_created = event["created"].as_i64().unwrap_or(0);
    match kind {
        "checkout.session.completed" | "checkout.session.async_payment_succeeded" => {
            if obj["mode"].as_str() != Some("subscription") {
                return None;
            }
            let paid = matches!(
                obj["payment_status"].as_str(),
                Some("paid" | "no_payment_required")
            );
            Some(SubscriptionUpdate {
                instance_id: obj["metadata"]["instance_id"]
                    .as_str()
                    .or(obj["client_reference_id"].as_str())
                    .map(str::to_owned),
                subscription_id: str_field(obj, "subscription")?,
                customer_id: str_field(obj, "customer")?,
                status: if paid { "active" } else { "incomplete" }.into(),
                cancel_at_period_end: None,
                current_period_end: None,
                event_created,
            })
        }
        "customer.subscription.created"
        | "customer.subscription.updated"
        | "customer.subscription.deleted"
        | "customer.subscription.paused"
        | "customer.subscription.resumed" => {
            // Newer Stripe API versions moved the period to the subscription's items.
            let period_end = obj["current_period_end"]
                .as_i64()
                .or_else(|| obj["items"]["data"][0]["current_period_end"].as_i64());
            Some(SubscriptionUpdate {
                instance_id: obj["metadata"]["instance_id"].as_str().map(str::to_owned),
                subscription_id: str_field(obj, "id")?,
                customer_id: str_field(obj, "customer")?,
                status: obj["status"].as_str()?.to_owned(),
                cancel_at_period_end: obj["cancel_at_period_end"].as_bool(),
                current_period_end: period_end,
                event_created,
            })
        }
        _ => None,
    }
}

/// What applying one update did; tests and logs read it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Applied {
    Updated,
    /// Out of order, for another customer, or for nothing we sold.
    Ignored,
    /// A live subscription with no server behind it, or a second one for a server that
    /// is already paid for: cancelled so nobody pays for nothing.
    CancelledStray,
}

/// Apply one plan change: store it and move the server's tier to match.
pub async fn apply_update(
    db: &sqlx::SqlitePool,
    provisioner: &dyn MachineProvisioner,
    provider: &dyn BillingProvider,
    up: &SubscriptionUpdate,
) -> Result<Applied, ApiError> {
    let row = match up.instance_id.as_deref() {
        Some(id) => subscription_for(db, id).await?,
        None => sqlx::query_as::<_, InstanceSubscription>(
            "SELECT * FROM instance_subscriptions WHERE stripe_subscription_id = ?",
        )
        .bind(&up.subscription_id)
        .fetch_optional(db)
        .await
        .map_err(crate::api::error::internal)?,
    };
    let Some(row) = row else {
        // Only subscriptions our checkout made carry an instance id; leave others alone.
        if up.instance_id.is_some() && !is_terminal(&up.status) {
            return cancel_stray(provider, &up.subscription_id).await;
        }
        return Ok(Applied::Ignored);
    };
    if row.stripe_customer_id != up.customer_id {
        tracing::warn!(
            instance = %row.instance_id,
            "billing event names a different customer than the server's owner; ignored"
        );
        return Ok(Applied::Ignored);
    }
    let same_subscription = row.stripe_subscription_id.as_deref() == Some(&up.subscription_id);
    if !same_subscription && row.stripe_subscription_id.is_some() {
        // Never replace an established subscription, even one that is unpaid/paused.
        if !is_terminal(&up.status) {
            return cancel_stray(provider, &up.subscription_id).await;
        }
        return Ok(Applied::Ignored);
    }
    // A late event for the previous purchase must not claim a fresh checkout slot.
    if !same_subscription && is_terminal(&up.status) {
        let Some(session_id) = row.checkout_session_id.as_deref() else {
            return Ok(Applied::Ignored);
        };
        let session = provider.checkout(session_id).await.map_err(upstream)?;
        if str_field(&session, "subscription").as_deref() != Some(&up.subscription_id) {
            return Ok(Applied::Ignored);
        }
    }

    let mut tx = db.begin().await.map_err(crate::api::error::internal)?;
    sqlx::query(
        "UPDATE instance_subscriptions SET
           stripe_subscription_id = ?,
           status = ?,
           cancel_at_period_end = COALESCE(?, cancel_at_period_end),
           current_period_end = COALESCE(?, current_period_end),
           last_event_at = MAX(last_event_at, ?),
           updated_at = ?
         WHERE instance_id = ?",
    )
    .bind(&up.subscription_id)
    .bind(&up.status)
    .bind(up.cancel_at_period_end)
    .bind(up.current_period_end)
    .bind(up.event_created)
    .bind(now_unix())
    .bind(&row.instance_id)
    .execute(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;

    let inst = sqlx::query_as::<_, crate::types::HostedInstance>(
        "SELECT * FROM hosted_instances WHERE id = ?",
    )
    .bind(&row.instance_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(crate::api::error::internal)?;
    let Some(inst) = inst else {
        tx.commit().await.map_err(crate::api::error::internal)?;
        // The server was deleted; its plan must not keep charging.
        if !is_terminal(&up.status) {
            let result = cancel_stray(provider, &up.subscription_id).await?;
            sqlx::query(
                "UPDATE instance_subscriptions SET status = 'canceled' WHERE instance_id = ?",
            )
            .bind(&row.instance_id)
            .execute(db)
            .await
            .map_err(crate::api::error::internal)?;
            return Ok(result);
        }
        return Ok(Applied::Updated);
    };

    let tier = if is_paid_status(&up.status) {
        "paid"
    } else {
        "free"
    };
    if inst.tier != tier {
        sqlx::query("UPDATE hosted_instances SET tier = ?, updated_at = ? WHERE id = ?")
            .bind(tier)
            .bind(now_unix())
            .bind(&inst.id)
            .execute(&mut *tx)
            .await
            .map_err(crate::api::error::internal)?;
        tracing::info!(instance = %inst.id, tier, status = %up.status, "instance plan changed");
    }
    tx.commit().await.map_err(crate::api::error::internal)?;
    // A server that was asleep when it was paid for wakes up; the paid plan is the one
    // Ohiyo doesn't put to sleep.
    if tier == "paid" {
        if let Some(machine_id) = inst.machine_id.as_deref().filter(|m| !m.is_empty()) {
            let result = async {
                let status = provisioner.status(machine_id).await?;
                if status == crate::provision::MachineState::Stopped {
                    provisioner.start(machine_id).await?;
                }
                provisioner.status(machine_id).await
            }
            .await;
            let status = match result {
                Ok(crate::provision::MachineState::Started) => "healthy",
                Ok(crate::provision::MachineState::Starting) => "waking",
                other => {
                    tracing::warn!(instance = %inst.id, ?other, "paid machine recovery failed");
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        "paid server could not be started; retrying".into(),
                    ));
                }
            };
            sqlx::query("UPDATE hosted_instances SET status = ?, updated_at = ? WHERE id = ?")
                .bind(status)
                .bind(now_unix())
                .bind(&inst.id)
                .execute(db)
                .await
                .map_err(crate::api::error::internal)?;
        }
    }
    Ok(Applied::Updated)
}

async fn cancel_stray(
    provider: &dyn BillingProvider,
    subscription_id: &str,
) -> Result<Applied, ApiError> {
    tracing::warn!(
        subscription = subscription_id,
        "cancelling a subscription with no unpaid server behind it; refund it if it was charged"
    );
    match provider.cancel_now(subscription_id).await {
        Ok(()) | Err(BillingError::NotFound) => Ok(Applied::CancelledStray),
        // Stripe retries the webhook on a 5xx; cancelling then gets another chance.
        Err(e) => Err(upstream(e)),
    }
}

/// Handle one verified webhook delivery. Already-processed events are skipped.
pub async fn handle_event(
    db: &sqlx::SqlitePool,
    provisioner: &dyn MachineProvisioner,
    provider: &dyn BillingProvider,
    event: &Value,
) -> Result<Applied, ApiError> {
    let Some(event_id) = event["id"].as_str().filter(|s| !s.is_empty()) else {
        return Err((StatusCode::BAD_REQUEST, "event has no id".into()));
    };
    let seen: Option<String> = sqlx::query_scalar("SELECT id FROM stripe_events WHERE id = ?")
        .bind(event_id)
        .fetch_optional(db)
        .await
        .map_err(crate::api::error::internal)?;
    if seen.is_some() {
        return Ok(Applied::Ignored);
    }
    let applied = match parse_event(event) {
        Some(up) => {
            // Delivery order and created timestamps cannot order Stripe snapshots.
            let mut current = provider
                .subscription(&up.subscription_id)
                .await
                .map_err(upstream)?;
            current.event_created = up.event_created;
            apply_update(db, provisioner, provider, &current).await?
        }
        None => Applied::Ignored,
    };
    // Recorded only after it was applied: a failure above returns 5xx and Stripe retries.
    sqlx::query("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)")
        .bind(event_id)
        .bind(event["type"].as_str().unwrap_or(""))
        .bind(now_unix())
        .execute(db)
        .await
        .map_err(crate::api::error::internal)?;
    tracing::info!(
        event_id,
        kind = event["type"].as_str().unwrap_or(""),
        ?applied,
        "billing webhook processed"
    );
    Ok(applied)
}

/// Periodic recovery of missed webhooks, uncertain checkout responses and stopped
/// paid machines. Caller-visible state survives restarts; failures remain retryable.
pub async fn reconcile(state: &crate::AppState) -> Result<(), ApiError> {
    let Some(billing) = &state.billing else {
        return Ok(());
    };
    let ids: Vec<String> = sqlx::query_scalar(
        "SELECT instance_id FROM instance_subscriptions WHERE status NOT IN ('canceled', 'incomplete_expired')"
    ).fetch_all(&state.db).await.map_err(crate::api::error::internal)?;
    let mut failed = 0;
    for id in &ids {
        // Let user actions proceed between rows; re-read each row under the same lock.
        let _lifecycle = state.instance_lifecycle.lock().await;
        let result = async {
            let Some(row) = subscription_for(&state.db, id).await? else { return Ok(()); };
            let mut sub = row.stripe_subscription_id.clone();
            if row.status == "checkout_pending" {
                if let Some(session_id) = recover_checkout(&state.db, billing.provider.as_ref(), &row).await? {
                    let session = billing.provider.checkout(&session_id).await.map_err(upstream)?;
                    sub = str_field(&session, "subscription");
                    if session["status"].as_str() == Some("expired") {
                        sqlx::query("UPDATE instance_subscriptions SET status = 'incomplete_expired', updated_at = ? WHERE instance_id = ?")
                            .bind(now_unix()).bind(id).execute(&state.db).await.map_err(crate::api::error::internal)?;
                    }
                }
            }
            if let Some(sub) = sub {
                let up = billing.provider.subscription(&sub).await.map_err(upstream)?;
                apply_update(&state.db, state.provisioner.as_ref(), billing.provider.as_ref(), &up).await?;
            }
            Ok::<(), ApiError>(())
        }.await;
        if let Err((_, error)) = result {
            failed += 1;
            tracing::error!(instance = %id, %error, "billing reconciliation row failed");
        }
    }
    tracing::info!(
        checked = ids.len(),
        failed,
        "billing reconciliation completed"
    );
    if failed > 0 {
        return Err((
            StatusCode::BAD_GATEWAY,
            format!("{failed} billing rows need recovery"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_live_statuses_keep_a_server_paid() {
        for s in ["active", "trialing", "past_due"] {
            assert!(is_paid_status(s), "{s}");
        }
        for s in [
            "checkout_pending",
            "incomplete",
            "incomplete_expired",
            "unpaid",
            "canceled",
            "paused",
            "",
        ] {
            assert!(!is_paid_status(s), "{s}");
        }
    }

    #[test]
    fn the_paid_plan_needs_payments_and_real_machines() {
        let billing = Billing {
            provider: Arc::new(stripe::StripeBilling::new(
                "sk_test_x",
                "whsec",
                "price",
                "http://x",
            )),
            app_url: "https://app".into(),
            price_label: "$8/month".into(),
        };
        assert!(paid_plan(Some(&billing), Provisioner::Live).available);
        // A development build sells against the fake provisioner; the app says so.
        assert!(paid_plan(Some(&billing), Provisioner::Simulated).available);
        let off = paid_plan(Some(&billing), Provisioner::Off);
        assert!(!off.available);
        assert!(off.reason.unwrap().contains("offline"));
        let unpaid = paid_plan(None, Provisioner::Live);
        assert!(!unpaid.available);
        assert!(unpaid.reason.unwrap().contains("Payments"));
        assert_eq!(unpaid.price_label, None);
        let live = Billing {
            provider: Arc::new(stripe::StripeBilling::new(
                "sk_live_x",
                "whsec",
                "price",
                "http://x",
            )),
            ..billing
        };
        assert!(!paid_plan(Some(&live), Provisioner::Simulated).available);
    }

    #[test]
    fn provisioner_kind_follows_the_fly_token() {
        assert_eq!(provisioner_kind(true, false), Provisioner::Live);
        assert_eq!(provisioner_kind(true, true), Provisioner::Live);
        assert_eq!(provisioner_kind(false, true), Provisioner::Simulated);
        assert_eq!(provisioner_kind(false, false), Provisioner::Off);
    }

    #[test]
    fn reads_a_completed_checkout() {
        let up = parse_event(&json!({
            "id": "evt_1", "type": "checkout.session.completed", "created": 50,
            "data": { "object": {
                "mode": "subscription", "payment_status": "paid",
                "client_reference_id": "inst_from_ref",
                "metadata": { "instance_id": "inst_1" },
                "subscription": "sub_1", "customer": { "id": "cus_1" }
            }}
        }))
        .unwrap();
        assert_eq!(up.instance_id.as_deref(), Some("inst_1"));
        assert_eq!(up.subscription_id, "sub_1");
        assert_eq!(up.customer_id, "cus_1");
        assert_eq!(up.status, "active");
        assert_eq!(up.event_created, 50);
    }

    #[test]
    fn an_unpaid_checkout_does_not_activate_and_payments_are_ignored() {
        let up = parse_event(&json!({
            "id": "evt_2", "type": "checkout.session.completed", "created": 1,
            "data": { "object": {
                "mode": "subscription", "payment_status": "unpaid",
                "client_reference_id": "inst_1", "subscription": "sub_1", "customer": "cus_1"
            }}
        }))
        .unwrap();
        assert_eq!(up.status, "incomplete");
        assert_eq!(up.instance_id.as_deref(), Some("inst_1"));
        assert!(parse_event(&json!({
            "id": "evt_3", "type": "checkout.session.completed",
            "data": { "object": { "mode": "payment", "customer": "cus_1" } }
        }))
        .is_none());
        assert!(parse_event(
            &json!({ "id": "evt_4", "type": "invoice.paid", "data": { "object": {} } })
        )
        .is_none());
    }

    #[test]
    fn reads_the_period_end_from_either_place() {
        let old = parse_event(&json!({
            "id": "e", "type": "customer.subscription.updated", "created": 9,
            "data": { "object": { "id": "sub_1", "customer": "cus_1", "status": "active",
                "cancel_at_period_end": true, "current_period_end": 1000 }}
        }))
        .unwrap();
        assert_eq!(old.current_period_end, Some(1000));
        assert_eq!(old.cancel_at_period_end, Some(true));
        assert_eq!(old.instance_id, None);
        let new = parse_event(&json!({
            "id": "e", "type": "customer.subscription.deleted", "created": 9,
            "data": { "object": { "id": "sub_1", "customer": "cus_1", "status": "canceled",
                "metadata": { "instance_id": "inst_1" },
                "items": { "data": [ { "current_period_end": 2000 } ] } }}
        }))
        .unwrap();
        assert_eq!(new.current_period_end, Some(2000));
        assert_eq!(new.status, "canceled");
        assert_eq!(new.instance_id.as_deref(), Some("inst_1"));
    }
}
