//! Instant Servers control-plane endpoints. Authenticated; owner-scoped.

use crate::auth::AuthUser;
use crate::types::HostedInstance;
use crate::{provision, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
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

#[derive(Serialize)]
pub struct BillingCheckout {
    pub mode: String,
    pub checkout_url: String,
    pub note: String,
}

#[derive(Serialize)]
pub struct SelfHostGuide {
    pub docker_image: String,
    pub export_url: String,
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
    SelfHostGuide {
        docker_image: image.clone(),
        export_url,
        one_liner: format!(
            "docker run -d --name ohiyo -p 3000:3000 -v ohiyo-data:/data -e JWT_SECRET=$(openssl rand -hex 32) -e PUBLIC_BASE_URL=https://YOUR_DOMAIN {image}"
        ),
        steps: vec![
            "Download this ownership pack and keep it with your backups.".into(),
            "Download the raw encrypted server database/uploads from the hosted instance when raw export is enabled.".into(),
            "Run the Docker image on your own VM with a persistent /data volume.".into(),
            "Point your domain at the VM, set PUBLIC_BASE_URL, then add it as an Ohiyo home in the app.".into(),
            "Keep the managed instance sleeping or delete it after you verify the self-host works.".into(),
        ],
    }
}

/// POST /api/v1/instances — provision a new instance for the caller.
pub async fn create_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateInstanceBody>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
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
) -> Result<Json<Vec<HostedInstance>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

/// GET /api/v1/instances/{id} — status of one of the caller's instances.
pub async fn get_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let inst = sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE id = ? AND owner_id = ?",
    )
    .bind(&id)
    .bind(&auth.0)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?
    .ok_or((StatusCode::NOT_FOUND, "instance not found".to_string()))?;
    Ok(Json(inst))
}

/// POST /api/v1/instances/{id}/sleep — stop the managed machine and mark it sleeping.
pub async fn sleep_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
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
    let inst =
        provision::wake_instance(&state.db, state.provisioner.as_ref(), &auth.0, &id).await?;
    Ok(Json(inst))
}

/// PATCH /api/v1/instances/{id}/tier — local billing/tier switch used by MVP ops.
pub async fn set_tier(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<SetTierBody>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let inst = provision::set_instance_tier(&state.db, &auth.0, &id, &body.tier).await?;
    Ok(Json(inst))
}

/// GET /api/v1/instances/{id}/export — portable ownership pack. It intentionally
/// contains registry/self-host metadata only; raw encrypted DB/upload export is a follow-up
/// hosted-instance endpoint so the control plane never mounts user data volumes.
pub async fn export_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<InstanceExport>, (StatusCode, String)> {
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    let guide = self_host_guide(&inst);
    Ok(Json(InstanceExport {
        version: 1,
        generated_at: crate::types::now_unix(),
        instance: inst,
        data_note: "This MVP exports a portable ownership pack immediately. Raw encrypted DB/uploads stay on the managed instance until the raw export worker is enabled; Ohiyo still cannot read plaintext because messages and private files are E2E encrypted.".into(),
        self_host: guide,
        billing_note: "Free managed servers can sleep. Paid managed servers are intended to be always-on after checkout/manual activation.".into(),
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

/// GET /api/v1/instances/{id}/billing — return a checkout/contact URL. If a real
/// checkout URL is not configured, the product still has a working operator handoff.
pub async fn billing_checkout(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<BillingCheckout>, (StatusCode, String)> {
    let inst = load_owner_instance(&state, &auth.0, &id).await?;
    let configured = std::env::var("OHIYO_BILLING_CHECKOUT_URL")
        .ok()
        .filter(|s| !s.is_empty());
    let checkout_url = configured.unwrap_or_else(|| {
        format!(
            "mailto:hello@ohiyo.gg?subject=Upgrade%20{}%20to%20Ohiyo%20Always-On&body=Please%20upgrade%20Instant%20Server%20{}%20({})%20to%20the%20paid%20always-on%20tier.",
            inst.name.replace(' ', "%20"),
            inst.name.replace(' ', "%20"),
            inst.id
        )
    });
    Ok(Json(BillingCheckout {
        mode: if checkout_url.starts_with("mailto:") { "operator" } else { "checkout" }.into(),
        checkout_url,
        note: "Paid tier keeps a managed encrypted community server always-on for the whole group; billing activation is intentionally separate from E2E keys/data.".into(),
    }))
}

/// DELETE /api/v1/instances/{id} — destroy one of the caller's instances and remove it
/// from the routing registry.
pub async fn delete_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    provision::delete_instance(&state.db, state.provisioner.as_ref(), &auth.0, &id).await?;
    Ok(StatusCode::NO_CONTENT)
}
