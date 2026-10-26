//! Opt-in writing pilot. The only external input is the task's explicit request.
//! No tools, chat access, automatic retries, or claims of verified completion.
pub mod agent;
pub mod computer;
pub mod context;
pub mod creation;
pub mod everyday;
pub mod research;
pub mod routing;
mod skills;
pub mod specs;
pub mod subscriptions;
pub mod tracker;
pub mod travel;

use std::{collections::HashSet, time::Duration};

use super::error::internal;
use crate::{
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

type Error = (StatusCode, String);

#[derive(Clone)]
pub struct Burrow {
    pub endpoint: String,
    pub model: String,
    pub api_key: String,
    pub users: HashSet<String>,
    pub client: reqwest::Client,
}

impl Burrow {
    pub fn from_env() -> Option<Self> {
        let endpoint = std::env::var("BURROW_COMPLETIONS_URL").ok()?;
        let url = url::Url::parse(&endpoint).ok()?;
        if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let model = std::env::var("BURROW_MODEL").ok()?.trim().to_owned();
        let api_key = std::env::var("BURROW_API_KEY").ok()?.trim().to_owned();
        let users: HashSet<String> = std::env::var("BURROW_USER_IDS")
            .ok()?
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if model.is_empty() || api_key.is_empty() || users.is_empty() {
            return None;
        }
        Some(Self {
            endpoint,
            model,
            api_key,
            users,
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(90))
                .build()
                .ok()?,
        })
    }
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Task {
    pub id: String,
    pub kind: String,
    pub format: String,
    pub template: Option<String>,
    pub request: String,
    pub state: String,
    pub result: String,
    pub error: Option<String>,
    pub project: Option<String>,
    pub routine_id: Option<String>,
    pub routine_version: Option<i64>,
    pub comparison: bool,
    pub travel: bool,
    pub coding: bool,
    pub manual_notes: String,
    pub manual_edited: bool,
    pub proposed_result: String,
    pub version: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize)]
pub struct Workspace {
    tasks: Vec<Task>,
    can_run: bool,
    service: Option<String>,
    can_research: bool,
    can_travel: bool,
    agent_task_ids: Vec<String>,
}

pub async fn list(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
) -> Result<Json<Workspace>, Error> {
    let tasks = sqlx::query_as::<_, Task>(
        "SELECT * FROM burrow_tasks WHERE user_id = ? ORDER BY created_at DESC, id DESC",
    )
    .bind(&user)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let runner = s.burrow.as_ref().filter(|b| b.users.contains(&user));
    Ok(Json(Workspace {
        tasks,
        can_run: runner.is_some(),
        can_research: s.kikka.as_ref().is_some_and(|k| (k.user == user || k.user == "*") && k.pi.is_some()),
        can_travel: s.travel_fixtures && s.kikka.as_ref().is_some_and(|k| (k.user == user || k.user == "*") && k.pi.is_some()),
        agent_task_ids: sqlx::query_scalar("SELECT DISTINCT r.task_id FROM burrow_agent_runs r JOIN burrow_tasks t ON t.id=r.task_id WHERE t.user_id=?")
            .bind(&user).fetch_all(&s.db).await.map_err(internal)?,
        service: runner
            .and_then(|b| url::Url::parse(&b.endpoint).ok())
            .and_then(|u| u.host_str().map(str::to_owned)),
    }))
}

#[derive(Deserialize)]
pub struct NewTask {
    request: String,
    #[serde(default = "writing_kind")]
    kind: String,
    template: Option<String>,
    #[serde(default = "document_format")]
    format: String,
    example: Option<String>,
    project: Option<String>,
    routine_id: Option<String>,
    #[serde(default)]
    comparison: bool,
    #[serde(default)]
    coding: bool,
    // Travel authority is saved separately; this flag only rejects mixed coding intent.
    #[serde(default)]
    travel: bool,
}

fn document_format() -> String {
    "document".into()
}

fn writing_kind() -> String {
    "writing".into()
}

pub async fn create(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Json(body): Json<NewTask>,
) -> Result<Json<Task>, Error> {
    let request = body.request.trim();
    if request.is_empty() || request.chars().count() > 8000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "Describe the task in 1–8,000 characters.".into(),
        ));
    }
    if body.coding
        && (body.kind != "writing"
            || body.format != "document"
            || body.template.is_some()
            || body.comparison
            || body.travel
            || body.routine_id.is_some())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Save coding as a separate document request without templates, comparison, travel or routines.".into(),
        ));
    }
    if !matches!(body.kind.as_str(), "writing" | "tracker") {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose writing or a launch tracker.".into(),
        ));
    }
    if body.template.is_some() && body.kind != "tracker" {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose an interactive page for this activity.".into(),
        ));
    }
    if !matches!(body.format.as_str(), "document" | "creation")
        || (body.format == "creation" && (body.kind != "writing" || body.template.is_some()))
        || (body.example.is_some() && body.format != "creation")
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a supported page format.".into(),
        ));
    }
    let (state, result) = if body.format == "creation" {
        let result = creation::initial(request, body.example.as_deref())?;
        (
            if result.page.is_some() {
                "draft_ready"
            } else {
                "waiting"
            },
            serde_json::to_string(&result).map_err(internal)?,
        )
    } else if let Some(template) = &body.template {
        (
            "draft_ready",
            serde_json::to_string(&everyday::initial(template)?).map_err(internal)?,
        )
    } else if body.kind == "tracker" {
        (
            "draft_ready",
            serde_json::to_string(&tracker::initial(request)).map_err(internal)?,
        )
    } else {
        ("waiting", String::new())
    };
    let id = new_id();
    let now = now_unix();
    let project = context::project(body.project.as_deref())?;
    let routine_version = if let Some(routine) = &body.routine_id {
        if !body.comparison {
            return Err((
                StatusCode::BAD_REQUEST,
                "Routines produce research comparisons.".into(),
            ));
        }
        Some(context::routine(&s, &user, routine, &project).await?.0)
    } else {
        None
    };
    // One statement makes the storage cap atomic under concurrent submissions.
    let inserted = sqlx::query("INSERT INTO burrow_tasks (id,user_id,request,kind,template,format,state,result,created_at,updated_at,project,routine_id,routine_version,comparison,coding) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM burrow_tasks WHERE user_id=?) < 200")
        .bind(&id).bind(&user).bind(request).bind(&body.kind).bind(&body.template).bind(&body.format).bind(state).bind(result).bind(now).bind(now).bind(project).bind(&body.routine_id).bind(routine_version).bind(body.comparison).bind(body.coding).bind(&user)
        .execute(&s.db).await.map_err(internal)?.rows_affected();
    if inserted == 0 {
        return Err((
            StatusCode::CONFLICT,
            "Your workspace has reached its 200-task pilot limit.".into(),
        ));
    }
    owned(&s, &user, &id).await.map(Json)
}

async fn owned(s: &AppState, user: &str, id: &str) -> Result<Task, Error> {
    sqlx::query_as::<_, Task>("SELECT * FROM burrow_tasks WHERE id=? AND user_id=?")
        .bind(id)
        .bind(user)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "Task not found.".into()))
}

#[derive(Deserialize)]
pub struct Permission {
    allow_generation: bool,
    version: Option<i64>,
    instruction: Option<String>,
}

pub async fn run(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(permission): Json<Permission>,
) -> Result<Json<Task>, Error> {
    let task = owned(&s, &user, &id).await?;
    if agent::managed(&s, &id).await? {
        return Err((StatusCode::CONFLICT, "Kikka is already handling this in her workspace. Open that task instead of starting another attempt.".into()));
    }
    if task.kind != "writing" {
        return Err((
            StatusCode::BAD_REQUEST,
            "This page doesn't need a writing service.".into(),
        ));
    }
    if !permission.allow_generation {
        return Err((
            StatusCode::BAD_REQUEST,
            "Your approval is required to send this request.".into(),
        ));
    }
    let mut creation = if task.format == "creation" {
        if permission.version != Some(task.version) {
            return Err((
                StatusCode::CONFLICT,
                "This page changed. Reopen it before asking for another change.".into(),
            ));
        }
        Some(serde_json::from_str::<creation::Creation>(&task.result).map_err(internal)?)
    } else {
        None
    };
    if let Some(creation) = &mut creation {
        if let Some(instruction) = permission
            .instruction
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            if instruction.chars().count() > 8000 {
                return Err((
                    StatusCode::BAD_REQUEST,
                    "Keep each change under 8,000 characters.".into(),
                ));
            }
            creation.messages.push(creation::Message {
                role: "user".into(),
                text: instruction.into(),
            });
            if creation.messages.len() > 20 {
                creation.messages.drain(..creation.messages.len() - 20);
            }
        } else if task.state == "draft_ready" {
            return Err((
                StatusCode::BAD_REQUEST,
                "Tell Kikka what you want to change.".into(),
            ));
        }
    }
    let runner = s
        .burrow
        .as_ref()
        .filter(|b| b.users.contains(&user))
        .cloned()
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "Kikka isn't connected to a writing service for this account. Your request is saved."
                .into(),
        ))?;
    let now = now_unix();
    let mut tx = s.db.begin().await.map_err(internal)?;
    // Admission, concurrency limits and daily spending limits share one write transaction.
    // Count attempts, not successes: failed/uncertain calls can still cost money.
    let pending = if let Some(c) = &creation {
        serde_json::to_string(c).map_err(internal)?
    } else {
        task.result.clone()
    };
    let changed = sqlx::query("UPDATE burrow_tasks SET state='working',result=?,error=NULL,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND version=? AND (state IN ('waiting','failed') OR (format='creation' AND state='draft_ready')) AND NOT EXISTS(SELECT 1 FROM burrow_agent_runs r WHERE r.task_id=burrow_tasks.id AND r.phase!='finished') AND (SELECT count(*) FROM burrow_tasks WHERE state='working') < 8 AND (SELECT count(*) FROM burrow_tasks WHERE user_id=? AND state='working') < 3 AND (SELECT count(*) FROM burrow_attempts a JOIN burrow_tasks t ON t.id=a.task_id WHERE t.user_id=? AND a.started_at>?) < 10")
        .bind(&pending).bind(now).bind(&id).bind(&user).bind(task.version).bind(&user).bind(&user).bind(now-86400)
        .execute(&mut *tx).await.map_err(internal)?.rows_affected();
    if changed == 0 {
        return Err((StatusCode::CONFLICT, "This task cannot start now. It may already be running or ready; the pilot allows 3 active tasks and 10 attempts per day.".into()));
    }
    sqlx::query("INSERT INTO burrow_attempts (task_id,started_at) VALUES (?,?)")
        .bind(&id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    let response = owned(&s, &user, &id).await?;
    let working_version = task.version + 1;
    tokio::spawn(async move {
        let result = async {
            let request = if let Some(c) = &creation {
                json!({"original_request":task.request,"current_page":c.page,"request":c.messages.iter().rev().find(|m|m.role=="user").map(|m|&m.text)}).to_string()
            } else { task.request.clone() };
            let generated = generate(&runner, &request, creation.is_some(), &s.db, &task).await?;
            if let Some(c) = creation.clone() {
                let had_page = c.page.is_some();
                let mut completed = creation::finish(c, &generated)?;
                completed.can_undo = had_page;
                completed.example = false;
                serde_json::to_string(&completed).map_err(|_| "Couldn't save this version.".to_owned())
            } else { Ok(generated) }
        }.await;
        let success = result.is_ok();
        let (state, text, error) = match result {
            Ok(text) => ("draft_ready", text, None),
            Err(message) => ("failed", pending, Some(message)),
        };
        let saved: Result<(), sqlx::Error> = async {
            let mut tx = s.db.begin().await?;
            let changed = sqlx::query("UPDATE burrow_tasks SET state=?,result=?,error=?,updated_at=?,version=version+1 WHERE id=? AND user_id=? AND state='working' AND version=?")
                .bind(state).bind(text).bind(error).bind(now_unix()).bind(&id).bind(&user).bind(working_version).execute(&mut *tx).await?.rows_affected();
            if changed == 1 && success && creation.as_ref().is_some_and(|c|c.page.is_some()) {
                sqlx::query("INSERT INTO burrow_creation_history (task_id,result) VALUES (?,?)").bind(&id).bind(&task.result).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM burrow_creation_history WHERE task_id=? AND id NOT IN (SELECT id FROM burrow_creation_history WHERE task_id=? ORDER BY id DESC LIMIT 30)").bind(&id).bind(&id).execute(&mut *tx).await?;
            }
            tx.commit().await
        }.await;
        if let Err(e) = saved {
            tracing::error!(error=%e, "Burrow task result could not be saved");
        }
    });
    Ok(Json(response))
}

async fn generate(
    runner: &Burrow,
    request: &str,
    creation: bool,
    db: &sqlx::SqlitePool,
    task: &Task,
) -> Result<String, String> {
    tokio::time::timeout(Duration::from_secs(90), async {
        if creation {
            let context: serde_json::Value = serde_json::from_str(request)
                .map_err(|_| "Couldn't read this request.".to_owned())?;
            // Include the current purpose so a short follow-up can preserve a changed task.
            let brief = json!({"original_request":context["original_request"],"request":context["request"],"current_page":{"title":context["current_page"]["title"],"description":context["current_page"]["description"]}}).to_string();
            let selection = complete(runner, skills::ROUTING, &brief, 128).await?;
            let specialist = skills::selected(&selection)?;
            // Stop/retry can invalidate this attempt during selection. Do not start another call.
            let current: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_tasks WHERE id=? AND version=? AND state='working')")
                .bind(&task.id).bind(task.version + 1).fetch_one(db).await
                .map_err(|_| "Couldn't check whether this task is still working.".to_owned())?;
            if !current { return Err("This attempt was stopped or replaced.".into()); }
            let instruction = format!("{}\n{}", creation::instruction(), skills::guidance(specialist));
            complete(runner, &instruction, request, 4096).await
        } else {
            complete(runner, "You are Kikka, Burrow's friendly, practical Helper. Produce a useful draft document for the user's request in plain text or Markdown. You have NO browsing, live sources, connected accounts, monitoring, scheduling, sending, or computer tools. Never claim to have used them or completed external actions. Do not invent sources or current facts. If a request needs unavailable capabilities, state the boundary clearly and provide useful preparatory work. Mark assumptions and information needing verification. Do not claim the outcome is verified or done. No other conversations or saved tasks are available to you.", request, 2048).await
        }
    }).await.map_err(|_| "This attempt took too long. Your previous page is safe. Another attempt may still cost money.".to_owned())?
}

async fn complete(
    runner: &Burrow,
    instruction: &str,
    request: &str,
    max_tokens: u32,
) -> Result<String, String> {
    let mut response = runner
        .client
        .post(&runner.endpoint)
        .bearer_auth(&runner.api_key)
        .json(
            &json!({"model": runner.model, "max_tokens": max_tokens, "messages": [
                {"role":"system","content":instruction},
                {"role":"user","content":request}
            ]}),
        )
        .send()
        .await
        .map_err(|_| {
            "The writing service didn't respond. You can retry; another attempt may incur a charge."
                .to_owned()
        })?;
    if !response.status().is_success() {
        return Err("The writing service couldn't complete this request. You can retry; another attempt may incur a charge.".into());
    }
    // Bound the response independently of the provider's advertised token limit.
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The response was interrupted. Please try again.".to_owned())?
    {
        if bytes.len() + chunk.len() > 128 * 1024 {
            return Err("The response was too large to save. Try a smaller request.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The writing service returned an unreadable response.".to_owned())?;
    let choice = &value["choices"][0];
    if choice["finish_reason"] != "stop" {
        return Err(
            "Kikka couldn't finish the draft within this attempt. Try a smaller request.".into(),
        );
    }
    let text = choice["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("The writing service returned no draft. Please try again.")?;
    Ok(text.to_owned())
}

#[derive(Deserialize)]
pub struct Edit {
    result: String,
    version: i64,
}

pub async fn edit(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Edit>,
) -> Result<Json<Task>, Error> {
    let task = owned(&s, &user, &id).await?;
    if task.format == "creation" {
        return Err((
            StatusCode::BAD_REQUEST,
            "Ask Kikka for a change instead of replacing this page.".into(),
        ));
    }
    if body.result.trim().is_empty() || body.result.len() > 100_000 {
        return Err((
            StatusCode::BAD_REQUEST,
            "A result must contain text and fit within 100 KB.".into(),
        ));
    }
    if let Some(template) = &task.template {
        let page = serde_json::from_str::<everyday::Page>(&body.result).map_err(|_| {
            (
                StatusCode::BAD_REQUEST,
                "This page couldn’t be read. Please check its fields.".into(),
            )
        })?;
        let result = everyday::result(page, template, template == "packing")?;
        let title = result["page"]["title"].as_str().unwrap();
        let changed = sqlx::query("UPDATE burrow_tasks SET result=?,request=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND template=?")
            .bind(serde_json::to_string(&result).map_err(internal)?).bind(title).bind(now_unix()).bind(&id).bind(&user).bind(body.version).bind(template).execute(&s.db).await.map_err(internal)?.rows_affected();
        if changed == 0 {
            return Err((StatusCode::CONFLICT, "This page changed elsewhere. Your edits are still here. Copy them before reopening the latest page.".into()));
        }
        return owned(&s, &user, &id).await.map(Json);
    }
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    sqlx::query("INSERT INTO burrow_creation_history(task_id,result) SELECT id,result FROM burrow_tasks WHERE id=? AND user_id=? AND version=? AND state='draft_ready' AND result!='' AND result!=?")
        .bind(&id).bind(&user).bind(body.version).bind(&body.result).execute(&mut *tx).await.map_err(internal)?;
    let changed = sqlx::query("UPDATE burrow_tasks SET result=?,manual_edited=1,version=version+1,updated_at=? WHERE id=? AND user_id=? AND kind='writing' AND state='draft_ready' AND version=?")
        .bind(&body.result).bind(now_unix()).bind(&id).bind(&user).bind(body.version)
        .execute(&mut *tx).await.map_err(internal)?.rows_affected();
    if changed == 0 {
        return Err((StatusCode::CONFLICT, "This draft changed elsewhere. Copy your edits, then reopen the task to load the latest version.".into()));
    }
    tx.commit().await.map_err(internal)?;
    owned(&s, &user, &id).await.map(Json)
}

/// Single-process pilot: never repeat an uncertain, potentially charged request on restart.
pub async fn recover(db: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    agent::recover(db).await?;
    sqlx::query("UPDATE burrow_tasks SET state='failed',error='Burrow restarted before this draft was saved. You can retry; the previous attempt may have incurred a charge.',version=version+1,updated_at=? WHERE state='working' AND NOT EXISTS(SELECT 1 FROM burrow_agent_runs r WHERE r.task_id=burrow_tasks.id AND r.phase!='finished')")
        .bind(now_unix()).execute(db).await?;
    Ok(())
}
