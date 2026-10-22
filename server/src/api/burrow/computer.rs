//! Authenticated computer scope and host-only lifecycle. No engine or task loop.
use super::{agent, owned, Error};
use crate::{
    api::error::internal,
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{header::CACHE_CONTROL, StatusCode},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    name: String,
}

pub async fn create(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Json(body): Json<Workspace>,
) -> Result<Json<Value>, Error> {
    if body.name.trim().is_empty()
        || body.name.len() > 80
        || body.name.chars().any(char::is_control)
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Use a workspace name of 1–80 bytes.".into(),
        ));
    }
    let id = new_id();
    let inserted = sqlx::query("INSERT INTO burrow_computer_workspaces(id,user_id,name,created_at) SELECT ?,?,?,? WHERE (SELECT count(*) FROM burrow_computer_workspaces WHERE user_id=?)<20")
        .bind(&id).bind(&user).bind(body.name.trim()).bind(now_unix()).bind(&user).execute(&s.db).await.map_err(internal)?.rows_affected();
    if inserted == 0 {
        return Err((
            StatusCode::CONFLICT,
            "Computer workspace limit reached.".into(),
        ));
    }
    Ok(Json(
        json!({"id":id,"name":body.name.trim(),"provisioned":false}),
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    action: String,
    request_id: String,
    mode: Option<String>,
    browser: Option<BrowserCommand>,
}

#[derive(Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct BrowserCommand {
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    input: Option<Value>,
}

pub async fn command(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Command>,
) -> Result<impl IntoResponse, Error> {
    owned(&s, &user, &id).await?;
    if !matches!(
        body.action.as_str(),
        "status"
            | "open"
            | "capabilities"
            | "reconnect"
            | "replace"
            | "release"
            | "release_workspace"
            | "live_view"
            | "receipt"
            | "browser_control"
    ) || body.request_id.is_empty()
        || body.request_id.len() > 160
        || !body
            .request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
        || body
            .mode
            .as_deref()
            .is_some_and(|m| !matches!(m, "read_only" | "interactive"))
    {
        return Err((StatusCode::BAD_REQUEST, "Invalid computer command.".into()));
    }
    if (body.action == "browser_control") != body.browser.is_some()
        || body.browser.as_ref().is_some_and(|b| {
            !matches!(
                b.action.as_str(),
                "status" | "take_over" | "give_back" | "frame" | "input"
            ) || (b.action == "input") != b.input.is_some()
                || b.input
                    .as_ref()
                    .is_some_and(|v| v.to_string().len() > 12000)
                || b.session_id.as_ref().is_some_and(|id| {
                    id.is_empty()
                        || id.len() > 160
                        || !id
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || b"-_:".contains(&b))
                })
        })
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Invalid private browser command.".into(),
        ));
    }
    let k = agent::connected(&s, &user)?;
    let runtime: Option<String> = sqlx::query_scalar("SELECT r.runtime_id FROM (SELECT * FROM burrow_agent_runs WHERE task_id=? ORDER BY request_version DESC LIMIT 1) r JOIN burrow_computer_workspaces w ON w.id=r.computer_workspace WHERE w.user_id=?")
        .bind(&id).bind(&user).fetch_optional(&s.db).await.map_err(internal)?.flatten();
    let runtime = runtime.ok_or((
        StatusCode::NOT_FOUND,
        "No computer is attached to this task.".into(),
    ))?;
    let bytes = k.pi_call(json!({"operation":"computer","owner":user,"run":runtime,"action":body.action,"request_id":body.request_id,"mode":body.mode,"browser":body.browser})).await
        .map_err(|_|(StatusCode::CONFLICT,"Computer acknowledgement unavailable. Check saved status before repeating a lifecycle change.".into()))?;
    let value: Value = serde_json::from_slice(&bytes).map_err(internal)?;
    // Private frames/input acknowledgements are never task content or cacheable.
    Ok(([(CACHE_CONTROL, "no-store")], Json(value)))
}
