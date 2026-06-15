//! End-to-end encryption key directory. Users publish their ECDH **public** key
//! (JWK); peers fetch it to derive a shared secret. The server stores only public
//! keys + ciphertext — it can never read encrypted message content.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{auth::AuthUser, AppState};

#[derive(Deserialize)]
pub struct PublishKeyBody {
    pub public_key: String,
}

#[derive(Serialize)]
pub struct PublicKey {
    pub public_key: Option<String>,
}

/// POST /users/@me/key — publish this device's E2E public key (a JWK string).
pub async fn publish_key(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<PublishKeyBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    // A P-256 public JWK is well under 1KB; bound it to avoid abuse.
    if body.public_key.is_empty() || body.public_key.len() > 2000 {
        return Err((StatusCode::BAD_REQUEST, "invalid public key".into()));
    }
    sqlx::query("UPDATE users SET public_key = ? WHERE id = ?")
        .bind(&body.public_key)
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(|e| crate::api::error::internal(e))?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /users/{user_id}/key — fetch a user's E2E public key (public info).
pub async fn get_key(
    _auth: AuthUser,
    Path(user_id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<PublicKey>, (StatusCode, String)> {
    // public_key is NULLable — decode as Option so a NULL doesn't coerce to Some("").
    let public_key: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT public_key FROM users WHERE id = ?")
            .bind(&user_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| crate::api::error::internal(e))?
            .flatten();
    Ok(Json(PublicKey { public_key }))
}
