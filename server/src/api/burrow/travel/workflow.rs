//! Trusted admission and capability dispatch. Pi, not this module, chooses stages.
use super::{fixtures::FixtureStays, *};
use crate::{
    api::{
        burrow::{agent, owned, Error},
        error::internal,
    },
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use sqlx::{Row, SqliteConnection};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    version: i64,
    mandate: Mandate,
    travelers: Vec<TravelerProfile>,
    materials: bool,
}
#[derive(Serialize, Deserialize)]
struct Admission {
    mandate: Mandate,
    profile_ids: Vec<String>,
    materials: bool,
}

fn http_error(e: TravelError) -> Error {
    match e {
        TravelError::NotFound => (StatusCode::NOT_FOUND, "Travel record not found.".into()),
        TravelError::Database(e) => internal(e),
        other => (StatusCode::CONFLICT, other.to_string()),
    }
}
fn enabled(s: &AppState) -> std::result::Result<(), Error> {
    if s.travel_fixtures {
        Ok(())
    } else {
        Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Travel fixtures are not enabled. No live booking path is mounted.".into(),
        ))
    }
}

/// Authenticated human admission; never reachable with the worker bearer token.
pub async fn save(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(b): Json<Draft>,
) -> std::result::Result<Json<Value>, Error> {
    enabled(&s)?;
    let _lifecycle = s.instance_lifecycle.lock().await;
    let task = owned(&s, &user, &id).await?;
    if task.version != b.version
        || task.kind != "writing"
        || task.format != "document"
        || task.comparison
    {
        return Err((
            StatusCode::CONFLICT,
            "Save a new document request before adding a trip mandate.".into(),
        ));
    }
    b.mandate.validate().map_err(http_error)?;
    require(
        b.mandate.area.is_some(),
        "A target coordinate and radius are required.",
    )
    .map_err(http_error)?;
    require(
        b.mandate.spend_capability_id == "fixture-balance",
        "Only fixture-balance is enabled; no actual spend authorization.",
    )
    .map_err(http_error)?;
    require(
        b.travelers.len() == b.mandate.guests.len() && b.travelers.len() <= 8,
        "Provide one stored profile per guest (maximum eight).",
    )
    .map_err(http_error)?;
    for p in &b.travelers {
        p.validate().map_err(http_error)?;
    }
    let workspace = new_id();
    let mandate = new_id();
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let busy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE task_id=? UNION ALL SELECT 1 FROM burrow_travel_requests WHERE task_id=?)")
        .bind(&id).bind(&id).fetch_one(&mut *tx).await.map_err(internal)?;
    if busy {
        return Err((
            StatusCode::CONFLICT,
            "Trip authority is already saved. It cannot be widened; create a separate request."
                .into(),
        ));
    }
    sqlx::query("INSERT INTO burrow_computer_workspaces VALUES(?,?,?,?)")
        .bind(&workspace)
        .bind(&user)
        .bind("Fixture travel — no computer allocated")
        .bind(now_unix())
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    let mut profile_ids = Vec::new();
    for p in b.travelers {
        let pid = new_id();
        sqlx::query("INSERT INTO burrow_travel_profiles VALUES(?,?,?)")
            .bind(&pid)
            .bind(&user)
            .bind(serde_json::to_string(&p).map_err(internal)?)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        profile_ids.push(pid);
    }
    let body = Admission {
        mandate: b.mandate,
        profile_ids,
        materials: b.materials,
    };
    sqlx::query("INSERT INTO burrow_travel_requests(task_id,user_id,workspace_id,mandate_id,body) VALUES(?,?,?,?,?)")
        .bind(&id).bind(&user).bind(&workspace).bind(&mandate).bind(serde_json::to_string(&body).map_err(internal)?).execute(&mut *tx).await.map_err(internal)?;
    let changed=sqlx::query("UPDATE burrow_tasks SET travel=1,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?")
        .bind(now_unix()).bind(&id).bind(&user).bind(b.version).execute(&mut *tx).await.map_err(internal)?.rows_affected();
    if changed != 1 {
        return Err((
            StatusCode::CONFLICT,
            "Request changed. Reopen it before saving.".into(),
        ));
    }
    tx.commit().await.map_err(internal)?;
    Ok(Json(
        json!({"task":owned(&s,&user,&id).await?,"workspace_id":workspace,"mandate_id":mandate,"mandate_version":1,"mode":"fixture"}),
    ))
}

pub(crate) async fn workspace(
    s: &AppState,
    task: &str,
) -> std::result::Result<Option<String>, Error> {
    sqlx::query_scalar("SELECT workspace_id FROM burrow_travel_requests WHERE task_id=?")
        .bind(task)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)
}
/// Commit the local fence with the owner's Stop command, even if Pi is offline.
pub(crate) async fn stop_in(
    db: &mut SqliteConnection,
    task: &str,
) -> std::result::Result<(), sqlx::Error> {
    sqlx::query("UPDATE burrow_travel_requests SET stage='stopped',reason='Stopped. Previously dispatched bookings still require verification.',retry_authorized=0 WHERE task_id=?").bind(task).execute(&mut *db).await?;
    sqlx::query("UPDATE burrow_travel_transactions SET stopped=1,state=CASE WHEN state IN ('researching','quoting','quoted','booking_failed') THEN 'stopped' WHEN state='booking_dispatched' THEN 'booking_uncertain' ELSE state END,updated_at=? WHERE task_id=?")
        .bind(now_unix()).bind(task).execute(db).await?;
    Ok(())
}
/// Called in the existing run-admission transaction, before it becomes queued.
pub(crate) async fn admit(
    db: &mut SqliteConnection,
    task: &str,
    root: &str,
) -> std::result::Result<(), sqlx::Error> {
    if let Some(r) = sqlx::query("SELECT * FROM burrow_travel_requests WHERE task_id=?")
        .bind(task)
        .fetch_optional(&mut *db)
        .await?
    {
        let raw: String = r.get("body");
        let body: Admission =
            serde_json::from_str(&raw).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
        sqlx::query("INSERT INTO burrow_travel_mandates VALUES(?,1,?,?,?,?,?)")
            .bind(r.get::<String, _>("mandate_id"))
            .bind(r.get::<String, _>("user_id"))
            .bind(task)
            .bind(root)
            .bind(
                serde_json::to_string(&body.mandate)
                    .map_err(|e| sqlx::Error::Protocol(e.to_string()))?,
            )
            .bind(now_unix())
            .execute(db)
            .await?;
    }
    Ok(())
}
pub(crate) async fn descriptor(
    s: &AppState,
    task: &str,
) -> std::result::Result<Option<Value>, sqlx::Error> {
    Ok(sqlx::query("SELECT workspace_id,mandate_id FROM burrow_travel_requests WHERE task_id=?").bind(task).fetch_optional(&s.db).await?
        .map(|r|json!({"workspace_id":r.get::<String,_>("workspace_id"),"mandate_id":r.get::<String,_>("mandate_id"),"mandate_version":1})))
}
async fn scope(s: &AppState, user: &str, task: &str) -> Result<Scope> {
    let r=sqlx::query("SELECT r.root_goal,w.workspace_id FROM burrow_travel_requests w JOIN burrow_agent_runs r ON r.task_id=w.task_id JOIN burrow_tasks t ON t.id=w.task_id WHERE t.id=? AND t.user_id=? AND w.user_id=t.user_id AND r.computer_workspace=w.workspace_id")
        .bind(task).bind(user).fetch_optional(&s.db).await?.ok_or(TravelError::NotFound)?;
    Ok(Scope {
        account_id: user.into(),
        task_id: task.into(),
        root_goal_id: r.get("root_goal"),
        workspace_id: r.get("workspace_id"),
    })
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Material {
    pub id: String,
    pub name: String,
    pub source_url: String,
    pub fetched_at: i64,
    pub coords: Option<Coords>,
    pub displayed_price: Option<String>,
    pub currency: Option<String>,
    pub advisory: bool,
    pub scope: Scope,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Coords {
    pub lat: f64,
    pub lng: f64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct MaterialMatch {
    pub material: Material,
    pub confidence: String,
    pub distance_meters: f64,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct OptionCard {
    pub rate: Quote,
    pub distance_meters: f64,
    pub materials: Vec<MaterialMatch>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Comparison {
    pub options: Vec<OptionCard>,
    pub context: Vec<Material>,
}

fn name_tokens(name: &str) -> Vec<String> {
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}
/// High confidence requires exact normalized name + <=100m + unique property.
/// Partial names within 500m are visible context, never passed to model ranking.
pub fn match_materials(
    rates: Vec<Quote>,
    materials: Vec<Material>,
    area: &TravelArea,
) -> Comparison {
    let mut result = Comparison {
        options: rates
            .into_iter()
            .map(|rate| OptionCard {
                distance_meters: distance_meters(
                    area.latitude,
                    area.longitude,
                    rate.accommodation.latitude,
                    rate.accommodation.longitude,
                ),
                rate,
                materials: vec![],
            })
            .collect(),
        context: vec![],
    };
    for material in materials {
        let mut candidates = Vec::new();
        if let Some(p) = &material.coords {
            let names = name_tokens(&material.name);
            for (i, o) in result.options.iter().enumerate() {
                let other = name_tokens(&o.rate.accommodation.name);
                let distance = distance_meters(
                    p.lat,
                    p.lng,
                    o.rate.accommodation.latitude,
                    o.rate.accommodation.longitude,
                );
                let a: std::collections::BTreeSet<_> = names.iter().collect();
                let b: std::collections::BTreeSet<_> = other.iter().collect();
                let overlap = a.intersection(&b).count() as f64 / a.union(&b).count().max(1) as f64;
                if distance.is_finite() && distance <= 500.0 && overlap >= 0.5 {
                    candidates.push((i, distance, names == other && distance <= 100.0));
                }
            }
        }
        let unique: std::collections::BTreeSet<_> = candidates
            .iter()
            .filter(|(_, _, high)| *high)
            .map(|(i, _, _)| result.options[*i].rate.accommodation.id.clone())
            .collect();
        if candidates.is_empty() {
            result.context.push(material);
            continue;
        }
        for (i, distance, high) in candidates {
            result.options[i].materials.push(MaterialMatch {
                material: material.clone(),
                confidence: if high && unique.len() == 1 {
                    "high"
                } else {
                    "low"
                }
                .into(),
                distance_meters: distance,
            });
        }
    }
    result
}
fn fixture_materials(scope: &Scope) -> Vec<Material> {
    let facts = [
        ("Fictional Cerulean Stay", 35.65631, 139.69931, "40000"),
        ("Fictional Shibuya Excel", 35.65851, 139.69971, "32000"),
        ("Shibuya Stream", 35.65721, 139.70201, "36000"),
        ("Fictional Kyoto Garden", 34.9858, 135.7588, "18000"),
    ];
    facts
        .into_iter()
        .enumerate()
        .map(|(i, (name, lat, lng, price))| Material {
            id: format!("fixture-{}-{i}", scope.task_id),
            name: name.into(),
            source_url: format!("https://hotels.example.test/fixture/{i}"),
            fetched_at: now_unix(),
            coords: Some(Coords { lat, lng }),
            displayed_price: Some(price.into()),
            currency: Some("JPY".into()),
            advisory: true,
            scope: scope.clone(),
        })
        .collect()
}

pub(crate) async fn snapshot(s: &AppState, user: &str, task: &str) -> Result<Value> {
    let r = sqlx::query("SELECT * FROM burrow_travel_requests WHERE task_id=? AND user_id=?")
        .bind(task)
        .bind(user)
        .fetch_optional(&s.db)
        .await?
        .ok_or(TravelError::NotFound)?;
    let transaction: Option<String> = sqlx::query_scalar(
        "SELECT id FROM burrow_travel_transactions WHERE task_id=? AND user_id=?",
    )
    .bind(task)
    .bind(user)
    .fetch_optional(&s.db)
    .await?;
    let root: Option<String> =
        sqlx::query_scalar("SELECT root_goal FROM burrow_agent_runs WHERE task_id=?")
            .bind(task)
            .fetch_optional(&s.db)
            .await?;
    let mut stage: String = r.get("stage");
    let mut reason: String = r.get("reason");
    let mut result = Value::Null;
    if let Some(id) = &transaction {
        let scope = scope(s, user, task).await?;
        let t = TravelLedger::new(s.db.clone()).get(&scope, id).await?;
        match t.state {
            TransactionState::Completed => {
                stage = "completed".into();
                reason = "Fixture booking verified. No real reservation or charge.".into();
                result = serde_json::to_value(t.data.result)?;
            }
            TransactionState::BookingDispatched
            | TransactionState::BookingUncertain
            | TransactionState::Reconciling => {
                stage = "booking_uncertain".into();
                reason="Booking outcome is uncertain. Checking saved provider state; no new booking will be sent.".into();
            }
            TransactionState::UnresolvedNeedsAttention => {
                stage = "unresolved_needs_attention".into();
                reason="Could not verify a unique booking. The spend hold remains; a person must investigate.".into();
            }
            TransactionState::Stopped => {
                stage = "stopped".into();
                reason = "Stopped before booking. No new booking will be sent.".into();
            }
            TransactionState::BookingFailed if !r.get::<bool, _>("retry_authorized") => {
                stage = "provider_failure".into();
                reason=if t.data.retry_allowed {"Provider confirmed no booking. Explicit approval and a fresh quote are required before retry."} else {"Provider rejected the booking. This task cannot retry."}.into();
            }
            _ => {}
        }
    }
    Ok(
        json!({"type":"travel","mode":"fixture","stage":stage,"reason":reason,"root_goal_id":root,"transaction_id":transaction,
        "terminal":matches!(stage.as_str(),"completed"|"stopped"|"outside_mandate"|"provider_failure"|"unresolved_needs_attention"),
        "comparison":serde_json::from_str::<Value>(&r.get::<String,_>("comparison"))?,"selected_rate_id":r.get::<Option<String>,_>("selected_rate_id"),"result":result}),
    )
}
pub async fn view(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(task): Path<String>,
) -> std::result::Result<Json<Value>, Error> {
    owned(&s, &user, &task).await?;
    snapshot(&s, &user, &task)
        .await
        .map(Json)
        .map_err(http_error)
}
async fn stage(s: &AppState, task: &str, stage: &str, reason: &str) -> Result<()> {
    sqlx::query(
        "UPDATE burrow_travel_requests SET stage=?,reason=? WHERE task_id=? AND stage!='stopped'",
    )
    .bind(stage)
    .bind(reason)
    .bind(task)
    .execute(&s.db)
    .await?;
    Ok(())
}
async fn ensure_transaction(s: &AppState, scope: &Scope) -> Result<Transaction> {
    let ledger = TravelLedger::new(s.db.clone());
    let existing: Option<String> = sqlx::query_scalar(
        "SELECT id FROM burrow_travel_transactions WHERE task_id=? AND user_id=?",
    )
    .bind(&scope.task_id)
    .bind(&scope.account_id)
    .fetch_optional(&s.db)
    .await?;
    if let Some(id) = existing {
        return ledger.get(scope, &id).await;
    }
    let r = sqlx::query(
        "SELECT mandate_id,body FROM burrow_travel_requests WHERE task_id=? AND user_id=?",
    )
    .bind(&scope.task_id)
    .bind(&scope.account_id)
    .fetch_one(&s.db)
    .await?;
    let admission: Admission = serde_json::from_str(&r.get::<String, _>("body"))?;
    ledger
        .begin(
            scope,
            &r.get::<String, _>("mandate_id"),
            1,
            &admission.profile_ids,
            None,
            "Awaiting inventory comparison".into(),
        )
        .await
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    pub owner: String,
    pub task: String,
    pub root_goal: String,
    pub workspace_id: String,
    pub request_id: String,
    pub operation: String,
    pub args: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    rate_id: String,
    reason: String,
}

async fn execute(s: &AppState, scope: &Scope, operation: &str, args: &Value) -> Result<()> {
    if operation == "stop" {
        let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await?;
        stop_in(&mut tx, &scope.task_id).await?;
        tx.commit().await?;
        return Ok(());
    }
    if operation == "status" {
        return Ok(());
    }
    let saved = sqlx::query("SELECT * FROM burrow_travel_requests WHERE task_id=?")
        .bind(&scope.task_id)
        .fetch_one(&s.db)
        .await?;
    if operation != "reconcile" {
        require(
            saved.get::<String, _>("stage") != "stopped",
            "Stopped; no new travel work is authorized.",
        )?;
    }
    let ledger = TravelLedger::new(s.db.clone());
    let t = ensure_transaction(s, scope).await?;
    let m = ledger
        .mandate(scope, &t.mandate_id, t.mandate_version)
        .await?;
    let provider = FixtureStays {
        db: s.db.clone(),
        scope: scope.clone(),
        mandate: m.clone(),
    };
    if operation == "reconcile"
        || (operation == "book"
            && matches!(
                t.state,
                TransactionState::BookingDispatched
                    | TransactionState::BookingUncertain
                    | TransactionState::Reconciling
            ))
    {
        if matches!(
            t.state,
            TransactionState::Completed | TransactionState::UnresolvedNeedsAttention
        ) {
            return Ok(());
        }
        if t.reconcile_next_at.is_none_or(|at| at <= now_unix())
            || t.reconcile_started_at
                .is_some_and(|at| now_unix() - at >= 900)
        {
            stage(
                s,
                &scope.task_id,
                "verifying",
                "Checking provider booking state.",
            )
            .await?;
            ledger.reconcile(scope, &t.id, &provider).await?;
        }
        return Ok(());
    }
    if t.state == TransactionState::Completed {
        return Ok(());
    }
    require(!t.stopped, "Stopped; no new travel work is authorized.")?;
    require(
        !matches!(
            saved.get::<String, _>("stage").as_str(),
            "outside_mandate" | "provider_failure"
        ),
        "This flow needs attention; no automatic retry or mandate widening.",
    )?;
    match operation {
        "research" => {
            let previous: Comparison = serde_json::from_str(&saved.get::<String, _>("comparison"))?;
            if !previous.options.is_empty() {
                return Ok(());
            }
            stage(
                s,
                &scope.task_id,
                "researching",
                "Finding bookable fixture inventory.",
            )
            .await?;
            let area = m
                .area
                .as_ref()
                .ok_or_else(|| TravelError::Policy("Missing target area".into()))?;
            let inventory = ledger
                .search(scope, &t.id, &provider, area.latitude, area.longitude)
                .await?;
            let mut rates = Vec::new();
            for option in inventory {
                rates.extend(
                    ledger
                        .rates(scope, &t.id, &provider, &option.search_result_id)
                        .await?,
                );
            }
            require(
                !rates.is_empty(),
                "No bookable option satisfies the stored mandate.",
            )?;
            let admission: Admission = serde_json::from_str(&saved.get::<String, _>("body"))?;
            let comparison = match_materials(
                rates,
                if admission.materials {
                    fixture_materials(scope)
                } else {
                    vec![]
                },
                area,
            );
            sqlx::query("UPDATE burrow_travel_requests SET comparison=?,stage='comparing',reason='Compare admitted Duffel fixture rates. Research prices are advisory.' WHERE task_id=? AND stage!='stopped'")
                .bind(serde_json::to_string(&comparison)?).bind(&scope.task_id).execute(&s.db).await?;
        }
        "select" => {
            let selected: Selection = serde_json::from_value(args.clone())?;
            require(
                !selected.reason.trim().is_empty() && selected.reason.len() <= 2000,
                "Provide a bounded selection reason.",
            )?;
            if t.state == TransactionState::BookingFailed {
                require(
                    saved.get::<bool, _>("retry_authorized"),
                    "Explicit human retry approval required.",
                )?;
            }
            let comparison: Comparison =
                serde_json::from_str(&saved.get::<String, _>("comparison"))?;
            let option=comparison.options.iter().find(|o|o.rate.rate_id==selected.rate_id).ok_or_else(||TravelError::Policy("Only admitted Duffel inventory can be selected; Materials are not bookable.".into()))?;
            if t.state == TransactionState::Quoted
                && saved
                    .get::<Option<String>, _>("selected_rate_id")
                    .as_deref()
                    == Some(&selected.rate_id)
            {
                return Ok(());
            }
            let price = option
                .materials
                .iter()
                .find(|m| m.confidence == "high")
                .and_then(|m| {
                    Money::parse(
                        m.material.displayed_price.as_deref()?,
                        m.material.currency.as_deref()?,
                    )
                    .ok()
                });
            ledger
                .record_selection(scope, &t.id, selected.reason, price)
                .await?;
            sqlx::query("UPDATE burrow_travel_requests SET selected_rate_id=?,stage='quoting',reason='Checking a fresh quote against your stored mandate.',retry_authorized=0 WHERE task_id=? AND stage!='stopped'")
                .bind(&selected.rate_id).bind(&scope.task_id).execute(&s.db).await?;
            ledger
                .quote(scope, &t.id, &provider, &selected.rate_id)
                .await?;
        }
        "book" => {
            stage(
                s,
                &scope.task_id,
                "booking",
                "Authorizing fixture spend and recording the booking request.",
            )
            .await?;
            ledger
                .book(
                    scope,
                    &t.id,
                    &provider,
                    &PrefundedDuffelBalance {
                        account_id: scope.account_id.clone(),
                        capability_id: "fixture-balance".into(),
                    },
                )
                .await?;
        }
        _ => return Err(TravelError::Policy("Unknown travel operation".into())),
    }
    Ok(())
}

pub(crate) async fn publish_snapshot(s: &AppState, user: &str, task: &str) -> Result<Value> {
    let snapshot = snapshot(s, user, task).await?;
    let run: Option<agent::Run> = sqlx::query_as("SELECT * FROM burrow_agent_runs WHERE task_id=?")
        .bind(task)
        .fetch_optional(&s.db)
        .await?;
    if let Some(run) = run {
        // Keep Pi attached until its own completion/Stop; publishing is not a task owner.
        agent::publish(
            s,
            &run,
            "snapshot",
            snapshot["reason"].as_str().unwrap_or(""),
            if snapshot["terminal"] == true {
                "draft_ready"
            } else if snapshot["stage"] == "booking_uncertain" {
                "waiting"
            } else {
                "working"
            },
            Some(&snapshot.to_string()),
        )
        .await?;
    }
    Ok(snapshot)
}

pub async fn command(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<Command>,
) -> std::result::Result<Json<Value>, Error> {
    enabled(&s)?;
    let k = s.kikka.as_ref().ok_or((
        StatusCode::SERVICE_UNAVAILABLE,
        "Pi is not connected.".into(),
    ))?;
    let pi =
        k.pi.as_ref()
            .ok_or((StatusCode::SERVICE_UNAVAILABLE, "Pi is required.".into()))?;
    let supplied = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    let mut mac = Hmac::<Sha256>::new_from_slice(pi.token.as_bytes()).map_err(internal)?;
    mac.update(supplied.as_bytes());
    let mut expected = Hmac::<Sha256>::new_from_slice(pi.token.as_bytes()).map_err(internal)?;
    expected.update(pi.token.as_bytes());
    if expected.verify_slice(&mac.finalize().into_bytes()).is_err()
        || (k.user != "*" && k.user != b.owner)
    {
        return Err((StatusCode::UNAUTHORIZED, "Unauthorized.".into()));
    }
    let scope = scope(&s, &b.owner, &b.task).await.map_err(http_error)?;
    if scope.root_goal_id != b.root_goal || scope.workspace_id != b.workspace_id {
        return Err(http_error(TravelError::NotFound));
    }
    require(
        !b.request_id.is_empty()
            && b.request_id.len() <= 160
            && b.request_id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b":_-".contains(&c)),
        "Invalid durable action identity.",
    )
    .map_err(http_error)?;
    require(
        matches!(
            b.operation.as_str(),
            "research" | "select" | "book" | "reconcile" | "status" | "stop"
        ),
        "Unknown travel operation.",
    )
    .map_err(http_error)?;
    if b.operation == "select" {
        let _: Selection =
            serde_json::from_value(b.args.clone()).map_err(|e| http_error(e.into()))?;
    } else {
        require(
            b.args.as_object().is_some_and(|a| a.is_empty()),
            "This operation accepts no model authority or parameters.",
        )
        .map_err(http_error)?;
    }
    // Allow the existing bridge to finish recording its start acknowledgement.
    for _ in 0..40 {
        let phase: String =
            sqlx::query_scalar("SELECT phase FROM burrow_agent_runs WHERE task_id=?")
                .bind(&b.task)
                .fetch_one(&s.db)
                .await
                .map_err(internal)?;
        if phase != "dispatching" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let _lock = if b.operation == "stop" {
        None
    } else {
        Some(s.travel_lock.lock().await)
    };
    let fingerprint = serde_json::to_string(&b).map_err(internal)?;
    let previous: Option<(String, Option<String>)> = sqlx::query_as(
        "SELECT body,response FROM burrow_travel_actions WHERE task_id=? AND request_id=?",
    )
    .bind(&b.task)
    .bind(&b.request_id)
    .fetch_optional(&s.db)
    .await
    .map_err(internal)?;
    if let Some((saved, response)) = previous {
        if saved != fingerprint {
            return Err(http_error(TravelError::Conflict));
        }
        if let Some(response) = response {
            return Ok(Json(serde_json::from_str(&response).map_err(internal)?));
        }
    } else {
        sqlx::query("INSERT INTO burrow_travel_actions(task_id,request_id,body) VALUES(?,?,?)")
            .bind(&b.task)
            .bind(&b.request_id)
            .bind(fingerprint)
            .execute(&s.db)
            .await
            .map_err(internal)?;
    }
    if let Err(e) = execute(&s, &scope, &b.operation, &b.args).await {
        let phase = if matches!(e, TravelError::Policy(_)) {
            "outside_mandate"
        } else {
            "provider_failure"
        };
        stage(&s, &b.task, phase, &e.to_string())
            .await
            .map_err(http_error)?;
    }
    let mut output = publish_snapshot(&s, &b.owner, &b.task)
        .await
        .map_err(http_error)?;
    // Model ranking receives only high-confidence research. UI keeps low matches
    // and unmatched context, but neither can become a bookable option/price claim.
    if let Some(options) = output["comparison"]["options"].as_array_mut() {
        for option in options {
            if let Some(materials) = option["materials"].as_array_mut() {
                materials.retain(|m| m["confidence"] == "high");
            }
        }
    }
    output["comparison"]["context"] = json!([]);
    // Names are necessary to the owner result, not to the model's booking authority.
    if let Some(booking) = output["result"]["booking"].as_object_mut() {
        booking.remove("email");
        booking.remove("guests");
    }
    sqlx::query("UPDATE burrow_travel_actions SET response=? WHERE task_id=? AND request_id=?")
        .bind(output.to_string())
        .bind(&b.task)
        .bind(&b.request_id)
        .execute(&s.db)
        .await
        .map_err(internal)?;
    Ok(Json(output))
}

/// Human-only explicit retry after a documented provider no-booking rejection.
pub async fn retry(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(task): Path<String>,
) -> std::result::Result<Json<Value>, Error> {
    enabled(&s)?;
    owned(&s, &user, &task).await?;
    let _lock = s.travel_lock.lock().await;
    let scope = scope(&s, &user, &task).await.map_err(http_error)?;
    let t = ensure_transaction(&s, &scope).await.map_err(http_error)?;
    require(
        t.state == TransactionState::BookingFailed && t.data.retry_allowed && !t.stopped,
        "No proven no-booking rejection; retry is forbidden.",
    )
    .map_err(http_error)?;
    sqlx::query("UPDATE burrow_travel_requests SET retry_authorized=1,stage='comparing',reason='Retry approved. A new quote must still satisfy the original mandate.' WHERE task_id=?").bind(&task).execute(&s.db).await.map_err(internal)?;
    snapshot(&s, &user, &task)
        .await
        .map(Json)
        .map_err(http_error)
}

pub async fn reconcile(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(task): Path<String>,
) -> std::result::Result<Json<Value>, Error> {
    enabled(&s)?;
    owned(&s, &user, &task).await?;
    let _lock = s.travel_lock.lock().await;
    let scope = scope(&s, &user, &task).await.map_err(http_error)?;
    execute(&s, &scope, "reconcile", &json!({}))
        .await
        .map_err(http_error)?;
    publish_snapshot(&s, &user, &task)
        .await
        .map(Json)
        .map_err(http_error)
}
