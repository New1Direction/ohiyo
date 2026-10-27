//! Source-bound private practice. Pi owns inference; only humans approve use.
use super::{agent, owned, Error, Task};
use crate::{
    api::error::internal,
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
use serde_json::{json, Value};

fn conflict() -> Error {
    (
        StatusCode::CONFLICT,
        "The material or practice changed. Refresh before deciding. Nothing was repeated.".into(),
    )
}
fn material(task: &Task) -> Result<(), Error> {
    super::presentation::material(task)?;
    if task.format != "document" {
        return Err((
            StatusCode::BAD_REQUEST,
            "Practice currently uses saved text outlines and notes, not interactive pages.".into(),
        ));
    }
    Ok(())
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Passage {
    text: String,
    quote: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Question {
    question: String,
    options: Vec<String>,
    answer: usize,
    explanation: String,
    quote: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Content {
    objective: String,
    explanation: Passage,
    worked_example: Passage,
    questions: Vec<Question>,
}
#[derive(sqlx::FromRow)]
struct SavedPack {
    id: String,
    version: i64,
    state: String,
    result: String,
    error: Option<String>,
    max_cost_cents: i64,
    source_version: i64,
    objective: String,
    audience: String,
    material: String,
}
fn bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max
}
fn content(result: &str, source: &str, objective: &str) -> Result<Content, Error> {
    let invalid = || {
        (StatusCode::CONFLICT, "The practice draft has invalid questions or unsupported quotations. It cannot be approved; no automatic retry is allowed.".into())
    };
    if result.len() > 30000 {
        return Err(invalid());
    }
    let pack: Content = serde_json::from_str(result).map_err(|_| invalid())?;
    let quote = |q: &str| bounded(q, 2000) && q.trim().chars().count() >= 8 && source.contains(q);
    if pack.objective != objective
        || pack.questions.len() != 3
        || !bounded(&pack.explanation.text, 2000)
        || !quote(&pack.explanation.quote)
        || !bounded(&pack.worked_example.text, 2000)
        || !quote(&pack.worked_example.quote)
    {
        return Err(invalid());
    }
    let mut prompts = std::collections::HashSet::new();
    for q in &pack.questions {
        let distinct: std::collections::HashSet<_> =
            q.options.iter().map(|o| o.trim().to_lowercase()).collect();
        if !bounded(&q.question, 500)
            || !prompts.insert(q.question.trim().to_lowercase())
            || !(2..=4).contains(&q.options.len())
            || q.answer >= q.options.len()
            || distinct.len() != q.options.len()
            || q.options.iter().any(|o| !bounded(o, 500))
            || !bounded(&q.explanation, 500)
            || !quote(&q.quote)
        {
            return Err(invalid());
        }
    }
    Ok(pack)
}

pub async fn get(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let mut tx = s.db.begin().await.map_err(internal)?;
    let task: Task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(&user)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::NOT_FOUND, "Task unavailable.".into()))?;
    let row: Option<SavedPack> = sqlx::query_as("SELECT t.id,t.version,t.state,t.result,t.error,p.max_cost_cents,p.source_version,p.objective,p.audience,p.material FROM burrow_practice_packs p JOIN burrow_tasks t ON t.id=p.task_id WHERE p.source_task=? AND t.user_id=? ORDER BY p.source_version DESC LIMIT 1")
        .bind(&id).bind(&user).fetch_optional(&mut *tx).await.map_err(internal)?;
    let mut view = json!({"source_version":task.version,"pack":null});
    if let Some(SavedPack {
        id: child,
        version,
        state,
        result,
        error,
        max_cost_cents: limit,
        source_version,
        objective,
        audience,
        material: source,
    }) = row
    {
        let review: Option<(i64,i64,String)> = sqlx::query_as("SELECT revision,output_version,status FROM burrow_practice_reviews WHERE task_id=? ORDER BY revision DESC LIMIT 1")
            .bind(&child).fetch_optional(&mut *tx).await.map_err(internal)?;
        let history: Vec<(i64,i64,String,i64)> = sqlx::query_as("SELECT revision,output_version,status,created_at FROM burrow_practice_reviews WHERE task_id=? ORDER BY revision")
            .bind(&child).fetch_all(&mut *tx).await.map_err(internal)?;
        let history: Vec<Value> = history.into_iter().map(|(revision,output_version,status,created_at)| json!({"revision":revision,"output_version":output_version,"status":status,"created_at":created_at})).collect();
        let stale =
            source_version != task.version || source != task.result || material(&task).is_err();
        let parsed = if state == "draft_ready" {
            Some(content(&result, &source, &objective))
        } else {
            None
        };
        let invalid = parsed
            .as_ref()
            .and_then(|p| p.as_ref().err())
            .map(|e| e.1.clone());
        let pack = parsed.and_then(Result::ok);
        let status = review
            .as_ref()
            .filter(|r| r.1 == version && pack.is_some())
            .map_or("draft", |r| r.2.as_str());
        view["pack"] = json!({"id":child,"version":version,"state":state,"max_cost_cents":limit,"source_version":source_version,"objective":objective,"audience":audience,
            "revision":review.as_ref().map_or(0,|r|r.0),"status":status,"stale":stale,"content":pack,"error":invalid.or(error),"history":history});
    }
    Ok(Json(view))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generate {
    version: i64,
    objective: String,
    audience: String,
    allow_practice: bool,
    max_cost_cents: i64,
    routing: Value,
}
pub async fn generate(
    State(s): State<AppState>,
    AuthUser(user, device): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Generate>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &id).await?;
    material(&task)?;
    if super::presentation::is_evaluation(&s, &id).await? {
        return Err(conflict());
    }
    let k = agent::connected(&s, &user)?;
    if k.pi.is_none()
        || !body.allow_practice
        || !(0..=50).contains(&body.max_cost_cents)
        || !bounded(&body.objective, 300)
        || !bounded(&body.audience, 300)
        || task.result.len() > 40000
    {
        return Err((StatusCode::BAD_REQUEST, "Explicitly allow one practice draft, an audience, one objective and a 0–50 US-cent limit. Saved text is limited to 40 KB.".into()));
    }
    let routes = super::routing::snapshot(&s, &user).await?;
    if !super::routing::same_snapshot(Some(&body.routing), Some(&routes))
        || routes["general"].is_null()
        || routes["general"]["connectionId"]
            .as_str()
            .is_some_and(|s| s.starts_with("subscription-"))
    {
        return Err((StatusCode::CONFLICT, "Review the current API or free general model first. Subscription billing cannot enforce this dollar limit.".into()));
    }
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let current: Task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(&user)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    material(&current)?;
    if current.version != body.version || current.result != task.result {
        return Err(conflict());
    }
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_practice_packs WHERE source_task=? AND source_version=?)").bind(&id).bind(body.version).fetch_one(&mut *tx).await.map_err(internal)?;
    if exists {
        return Err((StatusCode::CONFLICT, "This material version already has a practice request. Refresh its outcome; no new allowance or retry was authorized.".into()));
    }
    let child = new_id();
    let now = now_unix();
    sqlx::query("INSERT INTO burrow_tasks(id,user_id,kind,format,request,state,result,project,created_at,updated_at) VALUES(?,?,'writing','document',?,'waiting','',?,?,?)")
        .bind(&child).bind(&user).bind("Create one source-grounded practice draft from the selected saved material. Return the required practice JSON only.").bind(&task.project).bind(now).bind(now).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO burrow_practice_packs VALUES(?,?,?,?,?,?,?,?)")
        .bind(&id)
        .bind(body.version)
        .bind(&child)
        .bind(&task.result)
        .bind(body.objective.trim())
        .bind(body.audience.trim())
        .bind(body.max_cost_cents)
        .bind(routes.to_string())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    let start: agent::Start = serde_json::from_value(json!({"version":0,"allow_agent":true,"max_cost_cents":body.max_cost_cents,"role":"general","routing":routes})).map_err(internal)?;
    let _ = agent::start(
        State(s.clone()),
        AuthUser(user.clone(), device),
        Path(child),
        Json(start),
    )
    .await?;
    get(State(s), AuthUser(user, device), Path(id)).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Review {
    version: i64,
    pack_id: String,
    pack_version: i64,
    revision: i64,
    action: String,
    #[serde(default)]
    answers_checked: bool,
    #[serde(default)]
    age_checked: bool,
}
pub async fn review(
    State(s): State<AppState>,
    AuthUser(user, device): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Review>,
) -> Result<Json<Value>, Error> {
    owned(&s, &user, &id).await?;
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let parent: Task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(&user)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    let row: Option<(i64,String,String,i64,String,String)> = sqlx::query_as("SELECT p.source_version,p.material,p.objective,t.version,t.state,t.result FROM burrow_practice_packs p JOIN burrow_tasks t ON t.id=p.task_id WHERE p.source_task=? AND p.task_id=? AND t.user_id=? AND t.project IS ?")
        .bind(&id).bind(&body.pack_id).bind(&user).bind(&parent.project).fetch_optional(&mut *tx).await.map_err(internal)?;
    let Some((source_version, source, objective, version, state, result)) = row else {
        return Err((StatusCode::NOT_FOUND, "Practice unavailable.".into()));
    };
    let current: Option<(i64,String)> = sqlx::query_as("SELECT revision,status FROM burrow_practice_reviews WHERE task_id=? ORDER BY revision DESC LIMIT 1").bind(&body.pack_id).fetch_optional(&mut *tx).await.map_err(internal)?;
    if parent.version != body.version
        || version != body.pack_version
        || current.as_ref().map_or(0, |r| r.0) != body.revision
    {
        return Err(conflict());
    }
    let status = match body.action.as_str() {
        "approve" => {
            material(&parent)?;
            if source_version != parent.version
                || source != parent.result
                || state != "draft_ready"
                || current.as_ref().is_some_and(|r| r.1 == "approved")
            {
                return Err(conflict());
            }
            content(&result, &source, &objective)?;
            if !body.answers_checked || !body.age_checked {
                return Err((StatusCode::BAD_REQUEST,"Read the source excerpts, answers and age suitability before approving private practice.".into()));
            }
            "approved"
        }
        "withdraw" if current.as_ref().is_some_and(|r| r.1 == "approved") => "withdrawn",
        _ => return Err(conflict()),
    };
    sqlx::query("INSERT INTO burrow_practice_reviews VALUES(?,?,?,?,?)")
        .bind(&body.pack_id)
        .bind(body.revision + 1)
        .bind(version)
        .bind(status)
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    get(State(s), AuthUser(user, device), Path(id)).await
}
