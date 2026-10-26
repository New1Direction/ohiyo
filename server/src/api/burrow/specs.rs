//! Project-owned knowledge. Agents propose; only authenticated humans decide.
use super::{owned, Error, Task};
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
        "Proposal unavailable, stale, or already decided. Refresh before acting.".into(),
    )
}
fn project(task: &Task) -> Result<&str, Error> {
    task.project
        .as_deref()
        .ok_or((StatusCode::BAD_REQUEST, "Choose a project first.".into()))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Proposal {
    pub kind: String,
    pub base_revision: i64,
    pub content: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Skill {
    name: String,
    description: String,
    instructions: String,
}
impl Proposal {
    fn validate(&self) -> Result<(), Error> {
        let valid = self.base_revision >= 0
            && !self.content.trim().is_empty()
            && self.content.len() <= 8000
            && match self.kind.as_str() {
                "spec" => true,
                "skill" => serde_json::from_str::<Skill>(&self.content).is_ok_and(|s| {
                    !s.name.trim().is_empty()
                        && s.name.len() <= 80
                        && !s.description.trim().is_empty()
                        && s.description.len() <= 500
                        && !s.instructions.trim().is_empty()
                        && s.instructions.len() <= 6000
                }),
                _ => false,
            };
        if !valid {
            return Err((StatusCode::BAD_REQUEST, "Use a bounded spec or guidance-only skill {name,description,instructions}; no tool or executable fields.".into()));
        }
        Ok(())
    }
}

pub async fn snapshot(s: &AppState, user: &str, task: &Task) -> Result<Value, Error> {
    let Some(scope) = &task.project else {
        return Ok(Value::Null);
    };
    let row: Option<(i64, String)> = sqlx::query_as("SELECT revision,content FROM burrow_project_specs WHERE user_id=? AND project=? ORDER BY revision DESC LIMIT 1")
        .bind(user).bind(scope).fetch_optional(&s.db).await.map_err(internal)?;
    let (revision, content) = row.unwrap_or((0, String::new()));
    Ok(json!({"project":scope,"revision":revision,"content":content}))
}

pub async fn get(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &id).await?;
    let scope = project(&task)?;
    let proposals: Vec<(String,String,i64,String,String,Option<String>)> = sqlx::query_as("SELECT id,kind,base_revision,content,status,test_report FROM burrow_project_proposals WHERE user_id=? AND project=? ORDER BY created_at,id")
        .bind(&user).bind(scope).fetch_all(&s.db).await.map_err(internal)?;
    let history: Vec<(i64,String,String)> = sqlx::query_as("SELECT revision,content,proposal_id FROM burrow_project_specs WHERE user_id=? AND project=? ORDER BY revision")
        .bind(&user).bind(scope).fetch_all(&s.db).await.map_err(internal)?;
    Ok(Json(
        json!({"spec":snapshot(&s,&user,&task).await?,"history":history.into_iter().map(|(revision,content,proposal_id)|json!({"revision":revision,"content":content,"proposal_id":proposal_id})).collect::<Vec<_>>(),
        "proposals":proposals.into_iter().map(|(id,kind,base_revision,content,status,test_report)|json!({"id":id,"kind":kind,"base_revision":base_revision,"content":content,"status":status,"test_report":test_report})).collect::<Vec<_>>()}),
    ))
}

async fn insert(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user: &str,
    task: &Task,
    id: &str,
    body: &Proposal,
) -> Result<(), Error> {
    body.validate()?;
    let scope = project(task)?;
    let changed = sqlx::query("INSERT OR IGNORE INTO burrow_project_proposals(id,user_id,project,source_task,kind,base_revision,content,created_at) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM burrow_project_proposals WHERE user_id=? AND project=?)<200")
        .bind(id).bind(user).bind(scope).bind(&task.id).bind(&body.kind).bind(body.base_revision).bind(&body.content).bind(now_unix()).bind(user).bind(scope).execute(&mut **tx).await.map_err(internal)?.rows_affected();
    if changed == 0 {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_project_proposals WHERE id=? AND user_id=? AND project=? AND kind=? AND base_revision=? AND content=?)")
            .bind(id).bind(user).bind(scope).bind(&body.kind).bind(body.base_revision).bind(&body.content).fetch_one(&mut **tx).await.map_err(internal)?;
        if !exists {
            return Err(conflict());
        }
    }
    Ok(())
}

pub async fn propose(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Proposal>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &id).await?;
    let id = new_id();
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    insert(&mut tx, &user, &task, &id, &body).await?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(json!({"id":id,"status":"pending"})))
}

/// The enclosing event transaction binds scope to the run's real task, not model JSON.
pub async fn ingest(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    user: &str,
    task: &Task,
    run: &str,
    data: &Value,
) -> Result<(), Error> {
    let key = data["id"]
        .as_str()
        .filter(|s| s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(conflict)?;
    let body: Proposal =
        serde_json::from_value(data["proposal"].clone()).map_err(|_| conflict())?;
    insert(tx, user, task, &format!("{run}:{key}"), &body).await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    action: String,
}
pub async fn decide(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path((task_id, id)): Path<(String, String)>,
    Json(body): Json<Decision>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &task_id).await?;
    let scope = project(&task)?;
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let row: Option<(String,i64,String,String)> = sqlx::query_as("SELECT kind,base_revision,content,status FROM burrow_project_proposals WHERE id=? AND user_id=? AND project=?")
        .bind(&id).bind(&user).bind(scope).fetch_optional(&mut *tx).await.map_err(internal)?;
    let (kind, base, content, status) = row.ok_or_else(conflict)?;
    let current: Option<(i64,String,String)> = sqlx::query_as("SELECT revision,content,proposal_id FROM burrow_project_specs WHERE user_id=? AND project=? ORDER BY revision DESC LIMIT 1")
        .bind(&user).bind(scope).fetch_optional(&mut *tx).await.map_err(internal)?;
    let revision = current.as_ref().map_or(0, |r| r.0);
    let next = match body.action.as_str() {
        "approve" if status == "pending" && base == revision => {
            if kind == "spec" {
                sqlx::query("INSERT INTO burrow_project_specs VALUES(?,?,?,?,?,?)")
                    .bind(&user)
                    .bind(scope)
                    .bind(revision + 1)
                    .bind(&content)
                    .bind(&id)
                    .bind(now_unix())
                    .execute(&mut *tx)
                    .await
                    .map_err(internal)?;
            }
            "approved"
        }
        "reject" if status == "pending" => "rejected",
        "rollback"
            if kind == "skill"
                && ["approved", "testing", "tested", "test_failed"].contains(&status.as_str()) =>
        {
            "rolled_back"
        }
        "rollback"
            if kind == "spec"
                && status == "approved"
                && current.as_ref().is_some_and(|r| r.2 == id) =>
        {
            let previous: Option<String> = sqlx::query_scalar("SELECT content FROM burrow_project_specs WHERE user_id=? AND project=? AND revision=?")
                .bind(&user).bind(scope).bind(base).fetch_optional(&mut *tx).await.map_err(internal)?;
            sqlx::query("INSERT INTO burrow_project_specs VALUES(?,?,?,?,?,?)")
                .bind(&user)
                .bind(scope)
                .bind(revision + 1)
                .bind(previous.unwrap_or_default())
                .bind(format!("rollback:{id}"))
                .bind(now_unix())
                .execute(&mut *tx)
                .await
                .map_err(internal)?;
            "rolled_back"
        }
        "test" if kind == "skill" && status == "approved" => "testing",
        _ => return Err(conflict()),
    };
    sqlx::query("UPDATE burrow_project_proposals SET status=? WHERE id=?")
        .bind(next)
        .bind(&id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    if next == "testing" {
        // Commit one-shot admission BEFORE dispatch; crashes remain testing and cannot retry.
        let result = match super::agent::connected(&s, &user) {
            Ok(k) => k
                .pi_call(json!({"operation":"skill_test","content":content}))
                .await
                .ok(),
            Err(_) => None,
        };
        let passed = result
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .is_some_and(|v| {
                v == json!({"passed":true,"scope":"structural-only","installed":false})
            });
        let report = if passed {
            "Sandbox structural checks passed; usefulness and model behavior are NOT verified. Not installed."
        } else {
            "Sandbox test failed or acknowledgement unavailable. No automatic retry. Not installed."
        };
        sqlx::query("UPDATE burrow_project_proposals SET status=?,test_report=? WHERE id=? AND status='testing'")
            .bind(if passed {"tested"} else {"test_failed"}).bind(report).bind(&id).execute(&s.db).await.map_err(internal)?;
    }
    get(State(s), AuthUser(user, 0), Path(task_id)).await
}
