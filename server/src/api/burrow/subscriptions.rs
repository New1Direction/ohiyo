//! Account-scoped Pi OAuth. Sign-in and selecting it for work are separate actions.
use super::{agent, Error};
use crate::{auth::AuthUser, AppState};
use axum::{
    extract::{Path, State},
    http::{header, HeaderName, StatusCode},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

type Reply = ([(HeaderName, &'static str); 1], Json<Value>);
fn reply(value: Value) -> Reply {
    ([(header::CACHE_CONTROL, "no-store")], Json(value))
}

pub(super) async fn route(s: &AppState, owner: &str, model: &str) -> Result<Value, Error> {
    let provider = model.split('/').nth(1).unwrap_or("");
    if !model.starts_with("subscription/") || !matches!(provider, "claude" | "chatgpt") {
        return Err((StatusCode::BAD_REQUEST, "Choose an available model.".into()));
    }
    let bytes = agent::connected(s, owner)?
        .pi_call(json!({"operation":"subscription",
        "owner":owner,"provider":provider,"action":"route","model":model}))
        .await
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                "Reconnect this account before using it for work.".into(),
            )
        })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Connection status unavailable.".into(),
        )
    })
}

pub(super) async fn catalog(s: &AppState, owner: &str) -> Vec<Value> {
    let mut models = Vec::new();
    for provider in ["claude", "chatgpt"] {
        if let Ok(value) = command(s, owner, provider, "status", None, None).await {
            if let Some(entries) = value["models"].as_array() {
                models.extend(entries.iter().cloned());
            }
        }
    }
    models
}

async fn command(
    s: &AppState,
    owner: &str,
    provider: &str,
    action: &str,
    attempt: Option<String>,
    code: Option<String>,
) -> Result<Value, Error> {
    if !matches!(provider, "claude" | "chatgpt") {
        return Err((StatusCode::NOT_FOUND, "Unknown connection.".into()));
    }
    let worker = agent::connected(s, owner)?;
    let bytes = worker
        .pi_call(
            json!({"operation":"subscription", "owner":owner, "provider":provider,
        "action":action, "attempt":attempt, "code":code}),
        )
        .await
        .map_err(|_| {
            (
                StatusCode::CONFLICT,
                "Sign-in was not confirmed. Refresh before trying again.".into(),
            )
        })?;
    serde_json::from_slice(&bytes).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            "Connection status unavailable.".into(),
        )
    })
}

pub async fn status(
    State(s): State<AppState>,
    AuthUser(owner, _): AuthUser,
) -> Result<Reply, Error> {
    let mut connections = json!({});
    for provider in ["claude", "chatgpt"] {
        connections[provider] = if agent::connected(&s, &owner).is_ok_and(|w| w.pi.is_some()) {
            command(&s, &owner, provider, "status", None, None)
                .await
                .unwrap_or_else(|_| json!({"state":"failed", "usableForResearch":false}))
        } else {
            json!({"state":"unavailable", "usableForResearch":false})
        };
    }
    Ok(reply(connections))
}
pub async fn connect(
    State(s): State<AppState>,
    AuthUser(owner, _): AuthUser,
    Path(provider): Path<String>,
) -> Result<Reply, Error> {
    Ok(reply(
        command(&s, &owner, &provider, "connect", None, None).await?,
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Code {
    attempt: String,
    code: String,
}
pub async fn complete(
    State(s): State<AppState>,
    AuthUser(owner, _): AuthUser,
    Path(provider): Path<String>,
    Json(body): Json<Code>,
) -> Result<Reply, Error> {
    if provider != "claude" {
        return Err((
            StatusCode::NOT_FOUND,
            "Enter the device code on OpenAI’s page, not in Burrow.".into(),
        ));
    }
    if body.attempt.len() > 100
        || body.code.is_empty()
        || body.code.len() > 4096
        || !body.code.bytes().all(|b| (33..=126).contains(&b))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Enter the code from Claude’s sign-in page.".into(),
        ));
    }
    Ok(reply(
        command(
            &s,
            &owner,
            &provider,
            "complete",
            Some(body.attempt),
            Some(body.code),
        )
        .await?,
    ))
}
pub async fn disconnect(
    State(s): State<AppState>,
    AuthUser(owner, _): AuthUser,
    Path(provider): Path<String>,
) -> Result<Reply, Error> {
    Ok(reply(
        command(&s, &owner, &provider, "disconnect", None, None).await?,
    ))
}
