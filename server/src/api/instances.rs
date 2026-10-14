//! Instant Servers control-plane endpoints. Authenticated; owner-scoped.

use crate::auth::AuthUser;
use crate::billing::{self, BillingSummary, PaidPlan, Provisioner};
use crate::types::HostedInstance;
use crate::{provision, AppState};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Provisioning spins up a billable cloud VM — cap the rate per user, on top of the
/// hard free-tier instance cap enforced in `provision::create_instance`.
const MAX_PROVISIONS_PER_HOUR: usize = 5;

#[derive(Deserialize)]
pub struct CreateInstanceBody {
    pub name: String,
}

#[derive(Deserialize)]
pub struct SetTierBody {
    pub tier: String,
}

/// Starting a checkout more often than this is a bug or abuse, not a customer.
const MAX_CHECKOUTS_PER_HOUR: usize = 10;

/// An instance as the owner's app sees it: the registry row plus its paid plan, if any.
#[derive(Serialize)]
pub struct InstanceView {
    #[serde(flatten)]
    pub instance: HostedInstance,
    pub billing: Option<BillingSummary>,
}

#[derive(Serialize)]
pub struct CheckoutStarted {
    pub checkout_url: String,
}

#[derive(Serialize)]
pub struct PortalLink {
    pub url: String,
}

#[derive(Serialize)]
pub struct SelfHostGuide {
    pub docker_image: String,
    pub export_url: String,
    pub raw_data_export_url: Option<String>,
    pub one_liner: String,
    pub steps: Vec<String>,
}

#[derive(Serialize)]
pub struct InstanceExport {
    pub version: u8,
    pub generated_at: i64,
    pub instance: HostedInstance,
    pub data_note: String,
    pub self_host: SelfHostGuide,
    pub billing_note: String,
}

async fn load_owner_instance(
    state: &AppState,
    owner_id: &str,
    id: &str,
) -> Result<HostedInstance, (StatusCode, String)> {
    sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE id = ? AND owner_id = ?",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?
    .ok_or((StatusCode::NOT_FOUND, "instance not found".to_string()))
}

fn self_host_guide(inst: &HostedInstance) -> SelfHostGuide {
    let image = std::env::var("FLY_IMAGE")
        .unwrap_or_else(|_| "registry.fly.io/ohiyo-instances:latest".into());
    let export_url = format!("/api/v1/instances/{}/export", inst.id);
    let raw_data_export_url = inst
        .public_url
        .as_ref()
        .map(|url| format!("{}/api/v1/server-pack/export", url.trim_end_matches('/')));
    SelfHostGuide {
        docker_image: image.clone(),
        export_url,
        raw_data_export_url,
        one_liner: format!(
            "docker run -d --name ohiyo -p 3000:3000 -v ohiyo-data:/data -e JWT_SECRET=$(openssl rand -hex 32) -e PUBLIC_BASE_URL=https://YOUR_DOMAIN {image}"
        ),
        steps: vec![
            "Download this ownership pack and keep it with your backups.".into(),
            "From the hosted home, download the raw Server Pack export: SQLite snapshot + uploads + signed manifest.".into(),
            "Run the Docker image on your own VM with a persistent /data volume.".into(),
            "Point your domain at the VM, set PUBLIC_BASE_URL, then add it as an Ohiyo home in the app.".into(),
            "Keep the managed instance sleeping or delete it after you verify the self-host works.".into(),
        ],
    }
}

#[derive(Serialize)]
pub struct InstancesAvailable {
    pub available: bool,
    /// `live` (Fly Machines), `simulated` (a development build's fake: nothing really
    /// runs) or `off`.
    pub provisioner: Provisioner,
    pub paid_plan: PaidPlan,
}

fn current_provisioner() -> Provisioner {
    billing::provisioner_kind(
        std::env::var("FLY_API_TOKEN").is_ok(),
        cfg!(debug_assertions),
    )
}

/// GET /api/v1/instances/available — whether this server can make Instant Servers, by the
/// same rule `create_instance` applies, so the app doesn't offer what it would refuse;
/// and whether the paid plan can be bought, with the reason when it can't.
pub async fn instances_available(
    _auth: AuthUser,
    State(state): State<AppState>,
) -> Json<InstancesAvailable> {
    let provisioner = current_provisioner();
    Json(InstancesAvailable {
        available: provisioner != Provisioner::Off,
        provisioner,
        paid_plan: billing::paid_plan(state.billing.as_ref(), provisioner),
    })
}

/// POST /api/v1/instances — provision a new instance for the caller.
pub async fn create_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateInstanceBody>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    if current_provisioner() == Provisioner::Off {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Instant Servers aren't available on this server yet.".into(),
        ));
    }
    if !state.rate.check(
        &format!("provision:{}", auth.0),
        MAX_PROVISIONS_PER_HOUR,
        Duration::from_secs(3600),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "you're creating servers too fast — try again in a bit".into(),
        ));
    }
    let inst =
        provision::create_instance(&state.db, state.provisioner.as_ref(), &auth.0, &body.name)
            .await?;
    Ok(Json(inst))
}

/// GET /api/v1/instances — list the caller's instances, newest first.
pub async fn list_instances(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<InstanceView>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    let subs = billing::subscriptions_for_owner(&state.db, &auth.0).await?;
    Ok(Json(
        rows.into_iter()
            .map(|instance| {
                let billing = subs
                    .iter()
                    .find(|s| s.instance_id == instance.id)
                    .map(BillingSummary::from);
                InstanceView { instance, billing }
            })
            .collect(),
    ))
}

async fn view(
    state: &AppState,
    instance: HostedInstance,
) -> Result<InstanceView, (StatusCode, String)> {
    let billing = billing::subscription_for(&state.db, &instance.id)
        .await?
        .as_ref()
        .map(BillingSummary::from);
    Ok(InstanceView { instance, billing })
}

/// GET /api/v1/instances/{id} — status of one of the caller's instances.
pub async fn get_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<InstanceView>, (StatusCode, String)> {
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    Ok(Json(view(&state, inst).await?))
}

/// POST /api/v1/instances/{id}/sleep — stop the managed machine and mark it sleeping.
pub async fn sleep_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    let inst =
        provision::sleep_instance(&state.db, state.provisioner.as_ref(), &auth.0, &id).await?;
    Ok(Json(inst))
}

/// POST /api/v1/instances/{id}/wake — start the managed machine and mark it healthy.
pub async fn wake_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    let inst =
        provision::wake_instance(&state.db, state.provisioner.as_ref(), &auth.0, &id).await?;
    Ok(Json(inst))
}

/// PATCH /api/v1/instances/{id}/tier — billing/tier switch for operators (MVP ops).
/// Operators may change any instance; everyone else, owners included, gets 403.
pub async fn set_tier(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SetTierBody>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    if !crate::auth::is_operator(&auth.0) {
        return Err((
            StatusCode::FORBIDDEN,
            "only an operator can change an instance's tier".into(),
        ));
    }
    let inst = provision::set_instance_tier(&state.db, &id, &body.tier).await?;
    Ok(Json(inst))
}

/// GET /api/v1/instances/{id}/export — portable ownership pack. The raw encrypted
/// DB/upload export is produced by the hosted instance itself at /server-pack/export so
/// the control plane never mounts user data volumes.
pub async fn export_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<InstanceExport>, (StatusCode, String)> {
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    let guide = self_host_guide(&inst);
    Ok(Json(InstanceExport {
        version: 2,
        generated_at: crate::types::now_unix(),
        instance: inst,
        data_note: "This ownership pack is control-plane metadata plus self-host instructions. The raw Server Pack comes from the hosted home and includes its database and uploads. End-to-end encrypted conversations stay ciphertext; server channels, unencrypted conversations and files may be readable. Treat the export as sensitive.".into(),
        self_host: guide,
        billing_note: "Free managed servers can be put to sleep. On the paid plan Ohiyo keeps the server running and never puts it to sleep; there is no uptime SLA during the beta. Exporting and self-hosting stay free on either plan.".into(),
    }))
}

/// GET /api/v1/instances/{id}/graduate — self-hosting instructions for this instance.
pub async fn graduate_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SelfHostGuide>, (StatusCode, String)> {
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    Ok(Json(self_host_guide(&inst)))
}

fn billing_or_unavailable(state: &AppState) -> Result<&billing::Billing, (StatusCode, String)> {
    let plan = billing::paid_plan(state.billing.as_ref(), current_provisioner());
    match (state.billing.as_ref(), plan.reason) {
        (Some(b), None) => Ok(b),
        (_, reason) => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            reason.unwrap_or_else(|| "Payments aren't set up on this server yet.".into()),
        )),
    }
}

/// POST /api/v1/instances/{id}/billing/checkout — start Stripe Checkout for the paid
/// plan of one of the caller's servers. The plan only turns on when Stripe's signed
/// webhook confirms the payment, never on the strength of the redirect back.
pub async fn billing_checkout(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CheckoutStarted>, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    let billing = billing_or_unavailable(&state)?;
    if !state.rate.check(
        &format!("checkout:{}", auth.0),
        MAX_CHECKOUTS_PER_HOUR,
        Duration::from_secs(3600),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many checkouts started — try again in a bit".into(),
        ));
    }
    let checkout_url = billing::start_checkout(&state.db, billing, &auth.0, &inst).await?;
    Ok(Json(CheckoutStarted { checkout_url }))
}

/// POST /api/v1/instances/{id}/billing/cancel — end the paid plan when the current
/// period ends. The server stays paid until then, then drops to the free plan.
pub async fn billing_cancel(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<InstanceView>, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    let Some(billing) = state.billing.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Payments aren't set up on this server yet.".into(),
        ));
    };
    billing::cancel_at_period_end(&state.db, billing, &inst.id).await?;
    Ok(Json(view(&state, inst).await?))
}

/// POST /api/v1/billing/portal — a Stripe customer-portal link for the caller's own
/// billing account (payment method, invoices, cancel or resume).
pub async fn billing_portal(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<PortalLink>, (StatusCode, String)> {
    let Some(billing) = state.billing.as_ref() else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Payments aren't set up on this server yet.".into(),
        ));
    };
    let Some(customer) = billing::customer_for(&state.db, &auth.0).await? else {
        return Err((
            StatusCode::NOT_FOUND,
            "you have no billing account yet".into(),
        ));
    };
    let url = billing
        .provider
        .create_portal(
            &customer,
            &format!("{}/?instant_billing=portal", billing.app_url),
        )
        .await
        .map_err(|e| {
            tracing::warn!(error = %e, "couldn't open the billing portal");
            (
                StatusCode::BAD_GATEWAY,
                "the payment service didn't answer — try again in a moment".to_string(),
            )
        })?;
    Ok(Json(PortalLink { url }))
}

/// POST /api/v1/billing/stripe/webhook — Stripe's signed event feed. A bad signature is
/// a 400; a failure to apply is a 5xx so Stripe delivers the event again.
pub async fn stripe_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<StatusCode, (StatusCode, String)> {
    let Some(billing) = state.billing.as_ref() else {
        return Err((StatusCode::NOT_FOUND, "billing is not configured".into()));
    };
    let signature = headers
        .get("stripe-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    billing
        .provider
        .verify_webhook(&body, signature, crate::types::now_unix())
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid signature".to_string()))?;
    let event: serde_json::Value = serde_json::from_slice(&body)
        .map_err(|_| (StatusCode::BAD_REQUEST, "invalid event".to_string()))?;
    let _lifecycle = state.instance_lifecycle.lock().await;
    billing::handle_event(
        &state.db,
        state.provisioner.as_ref(),
        billing.provider.as_ref(),
        &event,
    )
    .await?;
    Ok(StatusCode::OK)
}

/// DELETE /api/v1/instances/{id} — destroy one of the caller's instances and remove it
/// from the routing registry. A paid plan is cancelled first; if it can't be, nothing
/// is destroyed.
pub async fn delete_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let _lifecycle = state.instance_lifecycle.lock().await;
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    billing::release_instance(&state.db, state.billing.as_ref(), &inst.id).await?;
    provision::delete_instance(&state.db, state.provisioner.as_ref(), &auth.0, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
