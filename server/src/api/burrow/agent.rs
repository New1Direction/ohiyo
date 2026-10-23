//! Optional, single-account runtime bridge: private Pi worker or existing ImOrb CLI.
//! Reattach known runs; never repeat an uncertain submission or steering command.
use super::{owned, Error, Task};
use crate::{api::error::internal, auth::AuthUser, types::now_unix, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{io::AsyncReadExt, process::Command, sync::Mutex};

#[derive(Clone)]
pub struct Kikka {
    pub binary: PathBuf,
    pub home: PathBuf,
    pub user: String,
    pub orb: String,
    pub model: String,
    pub verify: String,
    pub lock: Arc<Mutex<()>>,
    pub pi: Option<Pi>,
    pub routing: Option<super::routing::Routing>,
}

#[derive(Clone)]
pub struct Pi {
    pub endpoint: String,
    pub token: String,
}

impl Kikka {
    pub fn from_env() -> Option<Self> {
        if std::env::var("KIKKA_RUNTIME").as_deref() == Ok("pi") {
            let endpoint = std::env::var("KIKKA_WORKER_URL").ok()?;
            let url = url::Url::parse(&endpoint).ok()?;
            let token = std::env::var("KIKKA_WORKER_TOKEN").ok()?;
            let user = std::env::var("KIKKA_USER_ID").ok()?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.path() != "/command"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || token.len() < 32
                || user.trim().is_empty()
            {
                return None;
            }
            return Some(Self {
                binary: PathBuf::new(),
                home: PathBuf::new(),
                user,
                orb: "pi".into(),
                model: "gpt-4o-mini".into(),
                verify: String::new(),
                lock: Arc::default(),
                pi: Some(Pi { endpoint, token }),
                routing: super::routing::Routing::from_env(),
            });
        }
        let binary = PathBuf::from(std::env::var("KIKKA_ORBD_BINARY").ok()?);
        let home = PathBuf::from(std::env::var("KIKKA_ORBD_HOME").ok()?);
        let user = std::env::var("KIKKA_USER_ID").ok()?;
        let orb = std::env::var("KIKKA_ORB").ok()?;
        let model = std::env::var("KIKKA_MODEL").ok()?;
        let verify = std::env::var("KIKKA_VERIFY").ok()?;
        if !binary.is_absolute()
            || !binary.is_file()
            || !home.is_absolute()
            || !home.is_dir()
            || [&user, &orb, &model, &verify]
                .iter()
                .any(|s| s.trim().is_empty())
        {
            return None;
        }
        Some(Self {
            binary,
            home,
            user,
            orb,
            model,
            verify,
            lock: Arc::default(),
            pi: None,
            routing: super::routing::Routing::from_env(),
        })
    }

    fn target(&self) -> String {
        // A changed operator configuration must not silently move a saved task.
        if let Some(pi) = &self.pi {
            return format!(
                "{:x}",
                Sha256::digest(json!(["pi", pi.endpoint, self.user, self.model]).to_string())
            );
        }
        format!(
            "{:x}",
            Sha256::digest(
                json!([
                    self.binary,
                    self.home,
                    self.user,
                    self.orb,
                    self.model,
                    self.verify
                ])
                .to_string()
            )
        )
    }

    async fn cli(&self, args: &[&str]) -> Result<String, String> {
        if self.pi.is_some() {
            let body = match args {
                ["status", run] | ["watch", run, "--json"] => {
                    json!({"operation":args[0],"run":run})
                }
                _ => return Err("Unsupported research operation.".into()),
            };
            let value: Value = serde_json::from_slice(&self.pi_call(body).await?)
                .map_err(|_| "Kikka couldn't read the worker response.".to_owned())?;
            return if args[0] == "watch" {
                Ok(value
                    .as_array()
                    .ok_or("Missing activity history.".to_owned())?
                    .iter()
                    .map(|v| format!("{v}\n"))
                    .collect::<String>())
            } else {
                Ok(value.to_string())
            };
        }
        let mut child = Command::new(&self.binary)
            .args(["host", "agent"])
            .args(args)
            .env("ORBD_HOME", &self.home)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "Kikka's workspace could not be reached.".to_owned())?;
        let mut stdout = child.stdout.take().expect("piped stdout").take(1_048_577);
        let result = tokio::time::timeout(Duration::from_secs(30), async {
            let mut bytes = Vec::new();
            stdout.read_to_end(&mut bytes).await.map_err(|_| ())?;
            if bytes.len() > 1_048_576 {
                return Err(());
            }
            let status = child.wait().await.map_err(|_| ())?;
            if !status.success() {
                return Err(());
            }
            String::from_utf8(bytes).map_err(|_| ())
        })
        .await;
        result
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| "Kikka couldn't confirm the workspace response.".into())
    }

    pub(super) async fn pi_call(&self, body: Value) -> Result<Vec<u8>, String> {
        let pi = self.pi.as_ref().ok_or("Research isn't connected.")?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "Worker connection failed.")?;
        let mut response = client
            .post(&pi.endpoint)
            .bearer_auth(&pi.token)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Worker acknowledgement was not received.")?;
        if !response.status().is_success() {
            return Err("Worker could not acknowledge this operation.".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Worker response was interrupted.")?
        {
            if bytes.len() + chunk.len() > 8_388_608 {
                return Err("Worker response exceeded its limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

#[derive(Clone, Serialize, sqlx::FromRow)]
pub struct Run {
    pub id: String,
    pub task_id: String,
    pub request_version: i64,
    #[serde(skip)]
    target: String,
    #[serde(skip)]
    root_goal: String,
    #[serde(skip)]
    goal: String,
    pub max_cost_cents: i64,
    pub runtime_id: Option<String>,
    pub phase: String,
    pub activity: String,
    pub last_seq: i64,
    pub role: String,
    pub routing: Option<sqlx::types::Json<Value>>,
    pub usage: Option<sqlx::types::Json<Value>>,
    pub computer_workspace: Option<String>,
    pub requirements: Option<sqlx::types::Json<Value>>,
    pub coding: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Start {
    version: i64,
    allow_agent: bool,
    max_cost_cents: i64,
    role: Option<String>,
    routing: Option<Value>,
    computer_workspace: Option<String>,
    #[serde(default)]
    coding: bool,
}

pub(super) fn connected(s: &AppState, user: &str) -> Result<Kikka, Error> {
    s.kikka
        .as_ref()
        .filter(|k| k.user == user || (k.pi.is_some() && k.user == "*"))
        .cloned()
        .ok_or((
            StatusCode::SERVICE_UNAVAILABLE,
            "Kikka's workspace isn't connected for this account. Your request is saved.".into(),
        ))
}

async fn latest(s: &AppState, task: &str) -> Result<Run, Error> {
    sqlx::query_as(
        "SELECT * FROM burrow_agent_runs WHERE task_id=? ORDER BY request_version DESC LIMIT 1",
    )
    .bind(task)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?
    .ok_or((
        StatusCode::NOT_FOUND,
        "Kikka hasn't started this task in a workspace.".into(),
    ))
}

pub async fn managed(s: &AppState, task: &str) -> Result<bool, Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE task_id=? AND phase!='finished')",
    )
    .bind(task)
    .fetch_one(&s.db)
    .await
    .map_err(internal)
}

pub async fn start(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Start>,
) -> Result<Json<Run>, Error> {
    // Serialize admission with account deletion, as hosted-machine mutations do.
    let _lifecycle = s.instance_lifecycle.lock().await;
    let task = owned(&s, &user, &id).await?;
    if task.coding && !body.coding {
        return Err((
            StatusCode::CONFLICT,
            "This is a saved coding request. Explicitly approve coding and a computer workspace before starting.".into(),
        ));
    }
    let kikka = connected(&s, &user)?;
    let travel_workspace = super::travel::workflow::workspace(&s, &id).await?;
    if body.coding {
        // Coding is explicit computer authority, never a research/travel extension.
        // Research requirements are snapshotted only for comparison tasks below.
        if task.comparison
            || task.travel
            || travel_workspace.is_some()
            || task.routine_id.is_some()
            || task.routine_version.is_some()
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "Coding cannot be combined with comparison, travel, research requirements or routines. Start a separate document request.".into(),
            ));
        }
        if kikka.pi.is_none() || body.computer_workspace.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Coding requires a Pi connection and an owned computer workspace.".into(),
            ));
        }
    }
    if task.travel && (!s.travel_fixtures || kikka.pi.is_none() || travel_workspace.is_none()) {
        return Err((
            StatusCode::CONFLICT,
            "Fixture travel requires its saved mandate and Pi connection.".into(),
        ));
    }
    if travel_workspace.is_some()
        && body.computer_workspace.is_some()
        && body.computer_workspace != travel_workspace
    {
        return Err((
            StatusCode::CONFLICT,
            "Travel uses its stored workspace scope.".into(),
        ));
    }
    let computer_workspace = travel_workspace.or(body.computer_workspace.clone());
    if !body.allow_agent
        || !(0..=50).contains(&body.max_cost_cents)
        || (body.max_cost_cents == 0 && body.routing.is_none())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Approve this task and a spending limit of at most 50 US cents.".into(),
        ));
    }
    if task.kind != "writing" || task.format != "document" {
        return Err((
            StatusCode::BAD_REQUEST,
            "Start with a saved document request. Created pages keep their existing editor.".into(),
        ));
    }
    if let Some(workspace) = &computer_workspace {
        let authorized: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM burrow_computer_workspaces WHERE id=? AND user_id=?)",
        )
        .bind(workspace)
        .bind(&user)
        .fetch_one(&s.db)
        .await
        .map_err(internal)?;
        if !authorized {
            return Err((
                StatusCode::NOT_FOUND,
                "Computer workspace unavailable.".into(),
            ));
        }
        if kikka.pi.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Computers require Pi Durable as task owner.".into(),
            ));
        }
    }
    let target = kikka.target();
    let role = body
        .role
        .as_deref()
        .unwrap_or(if body.coding { "general" } else { "research" });
    if !super::routing::ROLES.contains(&role) {
        return Err((StatusCode::BAD_REQUEST, "Unknown research role.".into()));
    }
    // A retried HTTP request returns the original admission, not another paid run.
    let previous: Option<Run> =
        sqlx::query_as("SELECT * FROM burrow_agent_runs WHERE task_id=? AND request_version=?")
            .bind(&id)
            .bind(body.version)
            .fetch_optional(&s.db)
            .await
            .map_err(internal)?;
    if let Some(previous) = previous {
        if previous.max_cost_cents != body.max_cost_cents
            || previous.target != target
            || previous.role != role
            || previous.computer_workspace != computer_workspace
            || previous.coding != body.coding
            || !super::routing::same_snapshot(
                previous.routing.as_ref().map(|v| &v.0),
                body.routing.as_ref(),
            )
        {
            return Err((
                StatusCode::CONFLICT,
                "This approval already refers to different terms.".into(),
            ));
        }
        return Ok(Json(previous));
    }
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE task_id=?)")
            .bind(&id)
            .fetch_one(&s.db)
            .await
            .map_err(internal)?;
    if exists {
        return Err((StatusCode::CONFLICT, "Use a revision on the existing task and its remaining budget. A new approval cannot reset this task’s spending.".into()));
    }
    let routing = if kikka.routing.is_some() || body.routing.is_some() {
        if kikka.pi.is_none() {
            return Err((
                StatusCode::BAD_REQUEST,
                "Model routing requires the Pi worker.".into(),
            ));
        }
        let routes = super::routing::snapshot(&s, &user).await?;
        if super::routing::ROLES.iter().any(|r| routes[*r].is_null()) {
            return Err((
                StatusCode::BAD_REQUEST,
                "Every role requires an explicit active model route.".into(),
            ));
        }
        if !super::routing::same_snapshot(body.routing.as_ref(), Some(&routes)) {
            return Err((
                StatusCode::CONFLICT,
                "Model routing changed. Review the current providers and funding before approving."
                    .into(),
            ));
        }
        Some(routes.to_string())
    } else {
        if body.routing.is_some() {
            return Err((
                StatusCode::CONFLICT,
                "Model routing is no longer configured.".into(),
            ));
        }
        None
    };
    if body.max_cost_cents == 0
        && !body.routing.as_ref().is_some_and(|routes| {
            super::routing::ROLES.iter().all(|role| {
                routes[*role]["inputUsdPerMillion"].as_f64() == Some(0.0)
                    && routes[*role]["outputUsdPerMillion"].as_f64() == Some(0.0)
            })
        })
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "A zero spending limit requires verified zero-price routes for every role.".into(),
        ));
    }
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let now = now_unix();
    let changed = sqlx::query("UPDATE burrow_tasks SET state='working',error=NULL,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND state IN ('waiting','failed','draft_ready') AND NOT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE task_id=? AND phase!='finished') AND (SELECT count(*) FROM burrow_tasks WHERE state='working')<8 AND (SELECT count(*) FROM burrow_tasks WHERE user_id=? AND state='working')<3 AND (SELECT count(*) FROM burrow_attempts a JOIN burrow_tasks t ON t.id=a.task_id WHERE t.user_id=? AND a.started_at>?)<10")
        .bind(now).bind(&id).bind(&user).bind(body.version).bind(&id).bind(&user).bind(&user).bind(now-86400)
        .execute(&mut *tx).await.map_err(internal)?.rows_affected();
    if changed != 1 {
        return Err((
            StatusCode::CONFLICT,
            "This task changed or cannot start within the pilot limits.".into(),
        ));
    }
    let run = crate::types::new_id();
    let requirements = if task.comparison {
        Some(
            super::research::load(&mut tx, &task)
                .await
                .map_err(internal)?["brief"]
                .clone(),
        )
    } else {
        None
    };
    let goal = requirements
        .as_ref()
        .map(|brief| {
            if kikka.pi.is_some() {
                brief["text"].as_str().unwrap_or("").to_owned()
            } else {
                super::research::instruction(brief)
            }
        })
        .unwrap_or_else(|| task.request.clone());
    sqlx::query("INSERT INTO burrow_agent_runs(id,task_id,request_version,target,root_goal,goal,max_cost_cents,phase,activity,role,routing,computer_workspace,requirements,coding) VALUES(?,?,?,?,?,?,?,'queued','Getting ready…',?,?,?,?,?)")
        .bind(&run).bind(&id).bind(body.version).bind(target).bind(format!("burrow-{run}"))
        .bind(goal).bind(body.max_cost_cents).bind(role).bind(routing).bind(&computer_workspace).bind(requirements.map(|v| v.to_string())).bind(body.coding).execute(&mut *tx).await.map_err(internal)?;
    super::travel::workflow::admit(&mut tx, &id, &format!("burrow-{run}"))
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO burrow_attempts(task_id,started_at) VALUES(?,?)")
        .bind(&id)
        .bind(now)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    latest(&s, &id).await.map(Json)
}

pub async fn view(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &id).await?;
    let run = latest(&s, &id).await?;
    let rows: Vec<String> = sqlx::query_scalar("SELECT event FROM (SELECT seq,event FROM burrow_agent_events WHERE run_id=? ORDER BY seq DESC LIMIT 100) ORDER BY seq")
        .bind(&run.id).fetch_all(&s.db).await.map_err(internal)?;
    let events: Vec<Value> = rows
        .iter()
        .map(|r| serde_json::from_str(r))
        .collect::<Result<_, _>>()
        .map_err(internal)?;
    let commands: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT id,action,message,phase FROM burrow_agent_commands WHERE run_id=? ORDER BY rowid",
    )
    .bind(&run.id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    let connected = s.kikka.as_ref().is_some_and(|k| {
        (k.user == user || (k.pi.is_some() && k.user == "*")) && k.target() == run.target
    });
    let history: Vec<(i64, String)> = sqlx::query_as(
        "SELECT id,result FROM burrow_creation_history WHERE task_id=? ORDER BY id DESC LIMIT 30",
    )
    .bind(&id)
    .fetch_all(&s.db)
    .await
    .map_err(internal)?;
    Ok(Json(
        json!({"task":task,"agent":run,"connected":connected,"events":events,"commands":commands,"history":history}),
    ))
}

pub async fn evidence(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path((id, evidence)): Path<(String, String)>,
) -> Result<impl axum::response::IntoResponse, Error> {
    owned(&s, &user, &id).await?;
    let run = latest(&s, &id).await?;
    let kikka = connected(&s, &user)?;
    if run.target != kikka.target()
        || !evidence.starts_with("e-")
        || evidence.len() != 66
        || !evidence[2..].bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err((StatusCode::NOT_FOUND, "Evidence not found.".into()));
    }
    let bytes = kikka
        .pi_call(json!({"operation":"evidence","run":run.runtime_id,"evidence":evidence}))
        .await
        .map_err(|_| {
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "Saved evidence is temporarily unavailable.".into(),
            )
        })?;
    Ok((
        [
            ("Content-Type", "image/png"),
            ("Cache-Control", "no-store"),
            ("X-Content-Type-Options", "nosniff"),
        ],
        bytes,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Control {
    version: i64,
    request_id: String,
    action: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    allow_spending: bool,
    requirements_revision: Option<i64>,
}

pub async fn control(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Control>,
) -> Result<Json<Task>, Error> {
    let _lifecycle = s.instance_lifecycle.lock().await;
    let task = owned(&s, &user, &id).await?;
    let kikka = connected(&s, &user)?;
    let message = body.message.trim();
    if body.request_id.is_empty()
        || body.request_id.len() > 100
        || !body
            .request_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
        || !matches!(
            body.action.as_str(),
            "steer" | "stop" | "continue" | "resume"
        )
        || message.chars().count() > 8000
        || (matches!(body.action.as_str(), "steer" | "continue") && message.is_empty())
        || (body.requirements_revision.is_some()
            && (body.action != "continue"
                || !body.allow_spending
                || !task.comparison
                || kikka.pi.is_none()))
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "Choose a supported action, a unique request ID and a short instruction.".into(),
        ));
    }
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let run: Run = sqlx::query_as(
        "SELECT * FROM burrow_agent_runs WHERE task_id=? ORDER BY request_version DESC LIMIT 1",
    )
    .bind(&id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?
    .ok_or((
        StatusCode::NOT_FOUND,
        "Kikka hasn't started this task in a workspace.".into(),
    ))?;
    let previous: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT action,message,requirements FROM burrow_agent_commands WHERE run_id=? AND id=?",
    )
    .bind(&run.id)
    .bind(&body.request_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    if let Some((action, saved, requirements)) = previous {
        let revision = requirements
            .and_then(|v| serde_json::from_str::<Value>(&v).ok())
            .and_then(|v| v["revision"].as_i64());
        if action != body.action || saved != message || revision != body.requirements_revision {
            return Err((
                StatusCode::CONFLICT,
                "That request ID already has a different instruction.".into(),
            ));
        }
        return Ok(Json(task));
    }
    let requirements = if let Some(revision) = body.requirements_revision {
        let w = super::research::load(&mut tx, &task)
            .await
            .map_err(internal)?;
        if w["brief"]["revision"] != revision {
            return Err((
                StatusCode::CONFLICT,
                "Requirements changed. Refresh before updating research.".into(),
            ));
        }
        Some(w["brief"].to_string())
    } else {
        None
    };
    let busy: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE target=? AND id!=? AND phase IN ('attached','dispatching','review'))")
        .bind(&run.target).bind(&run.id).fetch_one(&mut *tx).await.map_err(internal)?;
    if task.version != body.version
        || run.target != kikka.target()
        || run.phase == "review"
        || (body.requirements_revision.is_some() && task.state != "draft_ready")
        || (body.action == "continue" && (!body.allow_spending || run.phase != "finished"))
        || (body.action == "continue" && busy && kikka.pi.is_none())
        || (body.action != "continue"
            && run.phase != "attached"
            && !(body.action == "stop" && run.phase == "queued"))
    {
        return Err((StatusCode::CONFLICT, "Reopen this task before continuing. Uncertain work needs operator review, not a fresh attempt.".into()));
    }
    let changed = sqlx::query("UPDATE burrow_tasks SET state='working',error=NULL,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=? AND (SELECT count(*) FROM burrow_agent_commands WHERE run_id=?)<200")
        .bind(now_unix()).bind(&id).bind(&user).bind(body.version).bind(&run.id).execute(&mut *tx).await.map_err(internal)?.rows_affected();
    if changed != 1 {
        return Err((
            StatusCode::CONFLICT,
            "This task changed or reached its instruction limit.".into(),
        ));
    }
    if body.action == "stop" {
        super::travel::workflow::stop_in(&mut tx, &id)
            .await
            .map_err(internal)?;
        sqlx::query(
            "UPDATE burrow_agent_commands SET phase='discarded' WHERE run_id=? AND phase='queued'",
        )
        .bind(&run.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    sqlx::query("INSERT INTO burrow_agent_commands(id,run_id,action,message,phase,requirements) VALUES(?,?,?,?,'queued',?)")
        .bind(&body.request_id).bind(&run.id).bind(&body.action).bind(message).bind(requirements).execute(&mut *tx).await.map_err(internal)?;
    if run.phase == "queued" && body.action == "stop" {
        sqlx::query("UPDATE burrow_agent_commands SET phase='sent' WHERE run_id=? AND id=?")
            .bind(&run.id)
            .bind(&body.request_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        sqlx::query("UPDATE burrow_agent_runs SET phase='finished',activity='Stopped before starting.' WHERE id=? AND phase='queued'")
            .bind(&run.id).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query(
            "UPDATE burrow_tasks SET state='failed',error='Stopped before starting.' WHERE id=?",
        )
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    } else {
        sqlx::query(
            "UPDATE burrow_agent_runs SET phase='attached',activity='Updating…' WHERE id=?",
        )
        .bind(&run.id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    if task.travel && body.action == "stop" {
        super::travel::workflow::publish_snapshot(&s, &user, &id)
            .await
            .map_err(|e| internal(e.to_string()))?;
    }
    owned(&s, &user, &id).await.map(Json)
}

pub(crate) async fn publish(
    s: &AppState,
    run: &Run,
    phase: &str,
    activity: &str,
    state: &str,
    result: Option<&str>,
) -> Result<(), sqlx::Error> {
    let mut tx = s.db.begin().await?;
    // A new instruction may have arrived while status/watch were in flight.
    // Capability snapshots may publish results but never change Pi's lifecycle.
    let changed = sqlx::query("UPDATE burrow_agent_runs SET phase=CASE WHEN ?1='snapshot' THEN phase ELSE ?1 END,activity=?2 WHERE id=?3 AND (?4 IN ('review','snapshot') OR NOT EXISTS(SELECT 1 FROM burrow_agent_commands WHERE run_id=?5 AND phase IN ('queued','dispatching')))")
        .bind(phase).bind(activity).bind(&run.id).bind(phase).bind(&run.id).execute(&mut *tx).await?.rows_affected();
    if changed == 0 {
        return Ok(());
    }
    if let Some(result) = result {
        sqlx::query("INSERT INTO burrow_creation_history(task_id,result) SELECT id,result FROM burrow_tasks WHERE id=? AND result!='' AND result!=?")
            .bind(&run.task_id).bind(result).execute(&mut *tx).await?;
        sqlx::query("DELETE FROM burrow_creation_history WHERE task_id=? AND id NOT IN (SELECT id FROM burrow_creation_history WHERE task_id=? ORDER BY id DESC LIMIT 30)")
            .bind(&run.task_id).bind(&run.task_id).execute(&mut *tx).await?;
    }
    if phase == "review" {
        sqlx::query("UPDATE burrow_agent_commands SET phase='review' WHERE run_id=? AND phase='dispatching'")
            .bind(&run.id).execute(&mut *tx).await?;
    }
    let error = if matches!(state, "waiting" | "failed") {
        Some(activity)
    } else {
        None
    };
    sqlx::query("UPDATE burrow_tasks SET state=?1,result=CASE WHEN manual_edited=1 THEN result ELSE coalesce(?2,result) END,proposed_result=CASE WHEN manual_edited=1 AND ?2 IS NOT NULL THEN ?2 ELSE proposed_result END,error=?3,version=version+1,updated_at=?4 WHERE id=?5 AND (state!=?1 OR error IS NOT ?3 OR (?2 IS NOT NULL AND result!=?2 AND proposed_result!=?2))")
        .bind(state).bind(result).bind(error).bind(now_unix()).bind(&run.task_id).execute(&mut *tx).await?;
    tx.commit().await
}

/// Call once after all old bridge workers have stopped. Never resubmit uncertain commands.
pub async fn recover(db: &sqlx::SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE burrow_agent_runs SET phase='review',activity='I need help confirming what started. Nothing will be repeated automatically.' WHERE phase='dispatching' OR id IN (SELECT run_id FROM burrow_agent_commands WHERE phase='dispatching')").execute(&mut *tx).await?;
    sqlx::query("UPDATE burrow_agent_commands SET phase='review' WHERE phase='dispatching'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE burrow_tasks SET state='waiting',error='Kikka needs help confirming interrupted work. No new spending was authorized.',version=version+1,updated_at=? WHERE id IN (SELECT task_id FROM burrow_agent_runs WHERE phase='review') AND state!='waiting'").bind(now_unix()).execute(&mut *tx).await?;
    tx.commit().await
}

/// The bridge reconciles durable runs; it does not execute a reasoning loop.
pub fn spawn(s: AppState) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = tick(&s).await {
                tracing::error!(%error, "Kikka reconciliation failed");
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
}

pub async fn tick(s: &AppState) -> Result<(), sqlx::Error> {
    let Some(k) = &s.kikka else {
        return Ok(());
    };
    let Ok(_guard) = k.lock.try_lock() else {
        return Ok(());
    };
    let runs: Vec<Run> = sqlx::query_as("SELECT r.* FROM burrow_agent_runs r JOIN burrow_tasks t ON t.id=r.task_id WHERE (t.user_id=? OR ?) AND r.target=? AND r.phase IN ('queued','attached') ORDER BY r.rowid")
        .bind(&k.user).bind(k.pi.is_some() && k.user == "*").bind(k.target()).fetch_all(&s.db).await?;
    for mut run in runs {
        if run.phase == "queued" {
            let changed = sqlx::query("UPDATE burrow_agent_runs SET phase='dispatching',activity='Starting…' WHERE id=? AND phase='queued' AND (? OR NOT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE target=? AND phase IN ('attached','dispatching','review')))")
                .bind(&run.id).bind(k.pi.is_some()).bind(&run.target).execute(&s.db).await?.rows_affected();
            if changed != 1 {
                continue;
            }
            let budget = format!(
                "{}.{:02}",
                run.max_cost_cents / 100,
                run.max_cost_cents % 100
            );
            let started = if k.pi.is_some() {
                let owner: String =
                    sqlx::query_scalar("SELECT user_id FROM burrow_tasks WHERE id=?")
                        .bind(&run.task_id)
                        .fetch_one(&s.db)
                        .await?;
                let task = owned(s, &owner, &run.task_id)
                    .await
                    .map_err(|e| sqlx::Error::Protocol(e.1))?;
                let mut admission = json!({"owner":owner,"task":run.task_id,"root_goal":run.root_goal,"goal":run.goal,"max_cost_cents":run.max_cost_cents,"coding":run.coding});
                if let Some(requirements) = &run.requirements {
                    admission["requirements"] = requirements.0.clone();
                }
                if let Some(travel) = super::travel::workflow::descriptor(s, &run.task_id).await? {
                    admission["travel"] = travel;
                } else if let Some(workspace) = &run.computer_workspace {
                    admission["computer_workspace"] = json!(workspace);
                }
                admission["burrow_context"] = json!(super::context::prompt(s, &owner, &task)
                    .await
                    .map_err(|e| sqlx::Error::Protocol(e.1))?);
                admission["comparison"] = json!(task.comparison);
                if let (Some(id), Some(version)) = (&task.routine_id, task.routine_version) {
                    let definition: String = sqlx::query_scalar("SELECT definition FROM burrow_routines WHERE id=? AND version=? AND user_id=? AND project IS ?")
                        .bind(id).bind(version).bind(&owner).bind(&task.project).fetch_one(&s.db).await?;
                    admission["routine"] = json!({"id":id,"version":version,"definition":serde_json::from_str::<Value>(&definition).unwrap_or(Value::Null)});
                }
                if run.coding || run.routing.is_some() {
                    admission["role"] = json!(run.role);
                }
                if let Some(routes) = &run.routing {
                    admission["routing"] = routes.0.clone();
                }
                match k
                    .pi_call(json!({"operation":"start","admission":admission}))
                    .await
                {
                    Ok(bytes) => serde_json::from_slice::<String>(&bytes)
                        .map_err(|_| "Worker admission was not readable.".to_owned()),
                    Err(error) => Err(error),
                }
            } else {
                k.cli(&[
                    "start",
                    &k.orb,
                    "--goal",
                    &run.goal,
                    "--model",
                    &k.model,
                    "--root-goal",
                    &run.root_goal,
                    "--verify",
                    &k.verify,
                    "--permissions",
                    "standard",
                    "--kind",
                    "investigate",
                    "--engine",
                    "orbd",
                    "--network",
                    "restricted",
                    "--max-usd",
                    &budget,
                    "--max-turns",
                    "15",
                    "--max-tool-calls",
                    "30",
                    "--max-tokens",
                    "50000",
                    "--max-verifications",
                    "2",
                    "--deadline-secs",
                    "900",
                ])
                .await
            };
            match started {
                Ok(id) if valid_id(id.trim()) => {
                    run.runtime_id = Some(id.trim().to_owned());
                    sqlx::query("UPDATE burrow_agent_runs SET runtime_id=?,phase='attached',activity='Working…' WHERE id=?")
                        .bind(&run.runtime_id).bind(&run.id).execute(&s.db).await?;
                }
                _ => {
                    publish(s,&run,"review","I couldn't confirm whether work started. Nothing will be repeated automatically.","waiting",None).await?;
                    continue;
                }
            }
        }
        if let Err(message) = reconcile(s, k, &run).await {
            // Status/event reads are safe to retry. Never retry start/control from here.
            sqlx::query("UPDATE burrow_agent_runs SET activity=? WHERE id=?")
                .bind(message)
                .bind(&run.id)
                .execute(&s.db)
                .await?;
        }
    }
    Ok(())
}

fn valid_id(id: &str) -> bool {
    id.starts_with("run-")
        && id.len() > 4
        && id.len() <= 100
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}

async fn reconcile(s: &AppState, k: &Kikka, run: &Run) -> Result<(), String> {
    let runtime = run
        .runtime_id
        .as_deref()
        .ok_or("This task needs help reconnecting.")?;
    let uncertain: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_commands WHERE run_id=? AND phase IN ('dispatching','review'))")
        .bind(&run.id).fetch_one(&s.db).await.map_err(|e|e.to_string())?;
    if uncertain {
        publish(
            s,
            run,
            "review",
            "An interrupted instruction needs review. Nothing will be sent again.",
            "waiting",
            None,
        )
        .await
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let commands: Vec<(String,String,String,Option<String>)> = sqlx::query_as("SELECT id,action,message,requirements FROM burrow_agent_commands WHERE run_id=? AND phase='queued' ORDER BY rowid")
        .bind(&run.id).fetch_all(&s.db).await.map_err(|e|e.to_string())?;
    // Controls are submitted only after validating this runtime's identity below.
    let status = k.cli(&["status", runtime]).await?;
    let status: Value =
        serde_json::from_str(&status).map_err(|_| "Kikka couldn't read the workspace status.")?;
    if status["run"] != runtime || status["root_goal_id"] != run.root_goal || status["orb"] != k.orb
    {
        return Err(
            "This workspace doesn't match the saved task. Reconnection needs review.".into(),
        );
    }
    if let Some(usage) = status.get("usage") {
        if !usage.is_null() {
            sqlx::query("UPDATE burrow_agent_runs SET usage=? WHERE id=?")
                .bind(usage.to_string())
                .bind(&run.id)
                .execute(&s.db)
                .await
                .map_err(|_| "Usage could not be saved.")?;
        }
    }
    if let Some((id, action, message, requirements)) = commands.first() {
        let changed = sqlx::query("UPDATE burrow_agent_commands SET phase='dispatching' WHERE run_id=? AND id=? AND phase='queued'")
            .bind(&run.id).bind(id).execute(&s.db).await.map_err(|e|e.to_string())?.rows_affected();
        if changed != 1 {
            return Ok(());
        }
        let args = match action.as_str() {
            "steer" => vec!["steer", runtime, message],
            "stop" => vec!["cancel", runtime],
            "continue" => vec!["continue", runtime, message, "--extra-secs", "900"],
            "resume" => vec!["resume", runtime],
            _ => return Err("Unsupported saved instruction.".into()),
        };
        let sent = if k.pi.is_some() {
            let owner: String = sqlx::query_scalar("SELECT user_id FROM burrow_tasks WHERE id=?")
                .bind(&run.task_id)
                .fetch_one(&s.db)
                .await
                .map_err(|e| e.to_string())?;
            let task = owned(s, &owner, &run.task_id).await.map_err(|e| e.1)?;
            let context = super::context::prompt(s, &owner, &task)
                .await
                .map_err(|e| e.1)?;
            let mut command =
                json!({"request_id":id,"action":action,"message":message,"burrow_context":context});
            if let Some(requirements) = requirements {
                command["requirements"] = serde_json::from_str(requirements)
                    .map_err(|_| "Invalid saved requirements.")?;
            }
            k.pi_call(json!({"operation":"control","run":runtime,"command":command}))
                .await
                .map(|_| ())
        } else {
            k.cli(&args).await.map(|_| ())
        };
        if sent.is_err() {
            publish(
                s,
                run,
                "review",
                "I need help confirming that instruction. It won't be sent twice.",
                "waiting",
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
            return Ok(());
        }
        sqlx::query("UPDATE burrow_agent_commands SET phase='sent' WHERE run_id=? AND id=?")
            .bind(&run.id)
            .bind(id)
            .execute(&s.db)
            .await
            .map_err(|e| e.to_string())?;
        // Do not finalize using the status captured before a steering/continue command.
        return Ok(());
    }
    let stream = k.cli(&["watch", runtime, "--json"]).await?;
    let owner: String = sqlx::query_scalar("SELECT user_id FROM burrow_tasks WHERE id=?")
        .bind(&run.task_id)
        .fetch_one(&s.db)
        .await
        .map_err(|e| e.to_string())?;
    let task = owned(s, &owner, &run.task_id).await.map_err(|e| e.1)?;
    let mut tx =
        s.db.begin_with("BEGIN IMMEDIATE")
            .await
            .map_err(|e| e.to_string())?;
    let mut seq = run.last_seq;
    let mut answer = None;
    for line in stream.lines().filter(|l| !l.trim().is_empty()) {
        let event: Value =
            serde_json::from_str(line).map_err(|_| "Kikka couldn't read the activity history.")?;
        let current = event["seq"]
            .as_i64()
            .filter(|n| *n > 0)
            .ok_or("Activity is missing its sequence.")?;
        if current <= seq && current > run.last_seq {
            return Err("Activity history arrived out of order.".into());
        }
        seq = seq.max(current);
        sqlx::query("INSERT OR IGNORE INTO burrow_agent_events(run_id,seq,event) VALUES(?,?,?)")
            .bind(&run.id)
            .bind(current)
            .bind(line)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        if event["type"] == "final_message" {
            super::research::ingest(&mut tx, &task, &run.id, current, &event["data"])
                .await
                .map_err(|e| e.to_string())?;
            if let Some(text) = event["data"]["content"]
                .as_str()
                .filter(|t| !t.trim().is_empty() && t.len() <= 100_000)
            {
                answer = Some(text.to_owned());
            }
        }
    }
    let workspace = super::research::load(&mut tx, &task)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(preferred) = super::research::preferred(&workspace) {
        // Late older answers cannot replace a newer attributed comparison.
        answer = sqlx::query_scalar(
            "SELECT content FROM burrow_research_ingested WHERE comparison_id=? AND content!=''",
        )
        .bind(preferred["id"].as_str())
        .fetch_optional(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }
    sqlx::query("UPDATE burrow_agent_runs SET last_seq=? WHERE id=?")
        .bind(seq)
        .bind(&run.id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;
    let (phase,activity,state) = match status["state"].as_str() {
        Some("Completed") => ("finished","Result ready. Runtime checks are recorded; this isn't independent verification by Burrow.","draft_ready"),
        Some("Failed") => ("finished","I couldn't finish. Your saved work and activity are still here.","failed"),
        Some("Cancelled") => ("finished","Stopped. Earlier effects and charges are not undone.","failed"),
        Some("Paused"|"AwaitingApproval") => ("attached","I need you before continuing. No uncertain spending will be repeated automatically.","waiting"),
        Some("Stopping") => ("attached","Stopping…","working"),
        Some("Running"|"Verifying"|"Queued"|"Pending") => ("attached","Working…","working"),
        _ => return Err("The workspace reported an unfamiliar state. Nothing new was started.".into()),
    };
    if super::travel::workflow::descriptor(s, &run.task_id)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        let owner: String = sqlx::query_scalar("SELECT user_id FROM burrow_tasks WHERE id=?")
            .bind(&run.task_id)
            .fetch_one(&s.db)
            .await
            .map_err(|e| e.to_string())?;
        let snapshot = super::travel::workflow::snapshot(s, &owner, &run.task_id)
            .await
            .map_err(|e| e.to_string())?;
        let travel_state = if snapshot["terminal"] == true {
            "draft_ready"
        } else if phase == "finished" || state == "waiting" {
            "waiting"
        } else {
            "working"
        };
        return publish(
            s,
            run,
            phase,
            snapshot["reason"].as_str().unwrap_or(activity),
            travel_state,
            Some(&snapshot.to_string()),
        )
        .await
        .map_err(|e| e.to_string());
    }
    // Never replace a saved result with a status message or an incomplete assistant turn.
    let result = if state == "draft_ready" {
        answer.as_deref()
    } else {
        None
    };
    if state == "draft_ready" && result.is_none() {
        return Err(
            "Work finished, but its result couldn't be read. The previous result is safe.".into(),
        );
    }
    let activity = if k.pi.is_some() {
        status["activity"].as_str().unwrap_or(activity)
    } else {
        activity
    };
    publish(s, run, phase, activity, state, result)
        .await
        .map_err(|e| e.to_string())
}
