//! Instant Servers control-plane endpoints. Authenticated; owner-scoped.

use crate::auth::AuthUser;
use crate::types::HostedInstance;
use crate::{provision, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct CreateInstanceBody {
    pub name: String,
}

/// POST /api/v1/instances — provision a new instance for the caller.
pub async fn create_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateInstanceBody>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
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
