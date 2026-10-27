//! No model or helper can sign off school materials. All authority is human,
//! account-scoped, version-bound, and independent of optional AI evaluation.
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
        "This material or review changed. Refresh before deciding. Nothing was repeated.".into(),
    )
}
fn material(task: &Task) -> Result<(), Error> {
    if task.kind != "writing"
        || task.coding
        || task.comparison
        || task.travel
        || task.template.is_some()
        || task.result.trim().is_empty()
        || task.state != "draft_ready"
        || !task.proposed_result.is_empty()
    {
        return Err((
            StatusCode::CONFLICT,
            "Finish and choose your saved material before reviewing it.".into(),
        ));
    }
    if task.format == "creation"
        && serde_json::from_str::<Value>(&task.result)
            .ok()
            .is_none_or(|v| !v["page"].is_object())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "There is no saved page to review.".into(),
        ));
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Citation {
    claim: String,
    title: String,
    url: String,
    quote: String,
    checked: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewChange {
    version: i64,
    revision: i64,
    action: String,
    audience: String,
    citations: Vec<Citation>,
    #[serde(default)]
    facts_checked: bool,
    #[serde(default)]
    age_checked: bool,
    #[serde(default)]
    school_use_approved: bool,
}

pub async fn get(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &id).await?;
    let history: Vec<(i64,i64,String,String,String,i64)> = sqlx::query_as("SELECT revision,source_version,status,audience,citations,created_at FROM burrow_presentation_reviews WHERE task_id=? ORDER BY revision")
        .bind(&id).fetch_all(&s.db).await.map_err(internal)?;
    let history: Vec<Value> = history.into_iter().map(|(revision,source_version,status,audience,citations,created_at)| json!({"revision":revision,"source_version":source_version,"status":status,"audience":audience,"citations":serde_json::from_str::<Value>(&citations).unwrap_or(json!([])),"created_at":created_at})).collect();
    let review = history.last().cloned();
    let evaluation: Option<(String,i64,String,String,Option<String>,i64)> = sqlx::query_as("SELECT t.id,t.version,t.state,t.result,t.error,e.max_cost_cents FROM burrow_presentation_evaluations e JOIN burrow_tasks t ON t.id=e.task_id WHERE e.source_task=? AND e.source_version=? AND t.user_id=?")
        .bind(&id).bind(task.version).bind(&user).fetch_optional(&s.db).await.map_err(internal)?;
    Ok(Json(
        json!({"version":task.version,"review":review,"history":history,"approved": review.as_ref().is_some_and(|r| r["source_version"] == task.version && r["status"] == "approved") && material(&task).is_ok(),
        "evaluation":evaluation.map(|(id,version,state,result,error,max_cost_cents)|json!({"id":id,"version":version,"state":state,"result":result,"error":error,"max_cost_cents":max_cost_cents}))}),
    ))
}

pub async fn change(
    State(s): State<AppState>,
    AuthUser(user, device): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<ReviewChange>,
) -> Result<Json<Value>, Error> {
    owned(&s, &user, &id).await?;
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let task: Task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(&user)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    let current: Option<(i64,String)> = sqlx::query_as("SELECT revision,status FROM burrow_presentation_reviews WHERE task_id=? ORDER BY revision DESC LIMIT 1").bind(&id).fetch_optional(&mut *tx).await.map_err(internal)?;
    if task.version != body.version || current.as_ref().map_or(0, |r| r.0) != body.revision {
        return Err(conflict());
    }
    if body.action == "withdraw" {
        if !current.as_ref().is_some_and(|r| r.1 == "approved") {
            return Err(conflict());
        }
        // Copy the attested metadata, not caller-supplied replacements.
        sqlx::query("INSERT INTO burrow_presentation_reviews SELECT task_id,revision+1,source_version,'withdrawn',audience,citations,? FROM burrow_presentation_reviews WHERE task_id=? AND revision=?")
            .bind(now_unix()).bind(&id).bind(body.revision).execute(&mut *tx).await.map_err(internal)?;
    } else {
        material(&task)?;
        if !matches!(body.action.as_str(), "save" | "approve")
            || body.audience.trim().is_empty()
            || body.audience.len() > 300
            || body.citations.len() > 24
        {
            return Err((
                StatusCode::BAD_REQUEST,
                "Add the intended age or school year and up to 24 sources.".into(),
            ));
        }
        for c in &body.citations {
            let url = url::Url::parse(&c.url).ok().filter(|u| {
                matches!(u.scheme(), "http" | "https")
                    && u.host_str().is_some()
                    && u.username().is_empty()
                    && u.password().is_none()
            });
            if url.is_none()
                || c.url.len() > 2000
                || c.claim.trim().is_empty()
                || c.claim.len() > 500
                || c.title.trim().is_empty()
                || c.title.len() > 300
                || c.quote.trim().is_empty()
                || c.quote.len() > 2000
            {
                return Err((StatusCode::BAD_REQUEST, "Each source needs a claim, title, public web address and supporting excerpt. Source links are not fetched or verified by Burrow.".into()));
            }
        }
        if body.action == "approve"
            && (!body.facts_checked
                || !body.age_checked
                || !body.school_use_approved
                || body.citations.is_empty()
                || body.citations.iter().any(|c| !c.checked))
        {
            return Err((StatusCode::BAD_REQUEST, "Check every source, factual claim and age suitability, then explicitly sign off school use.".into()));
        }
        sqlx::query("INSERT INTO burrow_presentation_reviews VALUES(?,?,?,?,?,?,?)")
            .bind(&id)
            .bind(body.revision + 1)
            .bind(body.version)
            .bind(if body.action == "approve" {
                "approved"
            } else {
                "draft"
            })
            .bind(body.audience.trim())
            .bind(serde_json::to_string(&body.citations).map_err(internal)?)
            .bind(now_unix())
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    get(State(s), AuthUser(user, device), Path(id)).await
}

pub async fn export(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    // One read transaction prevents mixing an old approval with new page content.
    owned(&s, &user, &id).await?;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let task: Task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=? AND user_id=?")
        .bind(&id)
        .bind(&user)
        .fetch_one(&mut *tx)
        .await
        .map_err(internal)?;
    material(&task)?;
    let review: Option<(i64,String,String,String)> = sqlx::query_as("SELECT source_version,status,audience,citations FROM burrow_presentation_reviews WHERE task_id=? ORDER BY revision DESC LIMIT 1").bind(&id).fetch_optional(&mut *tx).await.map_err(internal)?;
    let Some((version, _, audience, citations)) =
        review.filter(|r| r.0 == task.version && r.1 == "approved")
    else {
        return Err((
            StatusCode::CONFLICT,
            "Review and approve this saved version before downloading.".into(),
        ));
    };
    Ok(Json(
        json!({"version":version,"format":task.format,"content":task.result,"audience":audience,"citations":serde_json::from_str::<Value>(&citations).map_err(internal)?}),
    ))
}

pub async fn is_evaluation(s: &AppState, id: &str) -> Result<bool, Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM burrow_presentation_evaluations WHERE task_id=?)",
    )
    .bind(id)
    .fetch_one(&s.db)
    .await
    .map_err(internal)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evaluate {
    version: i64,
    revision: i64,
    allow_evaluation: bool,
    max_cost_cents: i64,
    routing: Value,
}
pub async fn evaluate(
    State(s): State<AppState>,
    AuthUser(user, device): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Evaluate>,
) -> Result<Json<Value>, Error> {
    let task = owned(&s, &user, &id).await?;
    material(&task)?;
    let k = agent::connected(&s, &user)?;
    if k.pi.is_none() || !body.allow_evaluation || !(0..=50).contains(&body.max_cost_cents) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Explicitly allow one Pi review and choose a limit of 0–50 US cents.".into(),
        ));
    }
    let routes = super::routing::snapshot(&s, &user).await?;
    if !super::routing::same_snapshot(Some(&body.routing), Some(&routes))
        || routes["review"].is_null()
        || routes["review"]["connectionId"]
            .as_str()
            .is_some_and(|id| id.starts_with("subscription-"))
    {
        return Err((StatusCode::CONFLICT, "Review the current priced API or free connection first. Subscription billing cannot enforce this dollar limit.".into()));
    }
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let current: (i64, String, String) =
        sqlx::query_as("SELECT version,result,state FROM burrow_tasks WHERE id=? AND user_id=?")
            .bind(&id)
            .bind(&user)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    let review: Option<(i64,String,String)> = sqlx::query_as("SELECT revision,audience,citations FROM burrow_presentation_reviews WHERE task_id=? AND source_version=? ORDER BY revision DESC LIMIT 1").bind(&id).bind(body.version).fetch_optional(&mut *tx).await.map_err(internal)?;
    let Some((revision, audience, citations)) = review else {
        return Err(conflict());
    };
    if current.0 != body.version
        || current.1 != task.result
        || current.2 != "draft_ready"
        || revision != body.revision
    {
        return Err(conflict());
    }
    let packet = json!({"audience":audience,"format":task.format,"material":task.result,"citations":serde_json::from_str::<Value>(&citations).map_err(internal)?}).to_string();
    if packet.len() > 50000 {
        return Err((StatusCode::BAD_REQUEST, "This material is too long for one AI review (50 KB including sources). Review it without AI or shorten it first.".into()));
    }
    let evaluation_id = new_id();
    let now = now_unix();
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_presentation_evaluations WHERE source_task=? AND source_version=?)").bind(&id).bind(body.version).fetch_one(&mut *tx).await.map_err(internal)?;
    if exists {
        return Err((StatusCode::CONFLICT, "This version already has a review request. Refresh to read its outcome; no new spending was authorized.".into()));
    }
    sqlx::query("INSERT INTO burrow_tasks(id,user_id,kind,format,request,state,result,project,created_at,updated_at) VALUES(?,?,'writing','document',?,'waiting','',?,?,?)")
        .bind(&evaluation_id).bind(&user).bind("Review this presentation for the intended audience. Return concise sections: factual concerns, source support, age suitability, clarity and suggested corrections. Reference supplied source numbers and quote specific claims. Mark unsupported claims unknown. This is advisory, not human sign-off or verification.").bind(&task.project).bind(now).bind(now).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO burrow_presentation_evaluations VALUES(?,?,?,?,?,?)")
        .bind(&id)
        .bind(body.version)
        .bind(&evaluation_id)
        .bind(packet)
        .bind(body.max_cost_cents)
        .bind(routes.to_string())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    let start: agent::Start = serde_json::from_value(json!({"version":0,"allow_agent":true,"max_cost_cents":body.max_cost_cents,"role":"review","routing":routes})).map_err(internal)?;
    // The existing admission owns pricing, concurrency, credentials and dispatch.
    // A failed admission leaves a visible saved request, never an automatic retry.
    let _ = agent::start(
        State(s.clone()),
        AuthUser(user.clone(), device),
        Path(evaluation_id),
        Json(start),
    )
    .await?;
    get(State(s), AuthUser(user, device), Path(id)).await
}
