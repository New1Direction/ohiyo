//! Durable user-owned research; no execution or spending on reads or edits.
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
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::{Sqlite, Transaction};
use std::collections::{HashMap, HashSet};

type Tx<'a> = Transaction<'a, Sqlite>;

pub(super) async fn load(tx: &mut Tx<'_>, task: &Task) -> Result<Value, sqlx::Error> {
    let saved: Option<String> =
        sqlx::query_scalar("SELECT workspace FROM burrow_research WHERE task_id=?")
            .bind(&task.id)
            .fetch_optional(&mut **tx)
            .await?;
    if let Some(saved) = saved {
        return serde_json::from_str(&saved).map_err(|e| sqlx::Error::Decode(Box::new(e)));
    }
    let brief =
        json!({"revision":1,"text":task.request,"purchase_budget":"","created_at":task.created_at});
    Ok(
        json!({"version":0,"brief":brief,"briefs":[brief],"comparisons":[],"candidates":[],"contributions":[],"decisions":[],"activity":[]}),
    )
}

async fn save(tx: &mut Tx<'_>, task: &str, w: &Value, change: Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO burrow_research(task_id,workspace) VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET workspace=excluded.workspace")
        .bind(task).bind(w.to_string()).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO burrow_research_changes(task_id,version,change) VALUES(?,?,?)")
        .bind(task)
        .bind(w["version"].as_i64())
        .bind(change.to_string())
        .execute(&mut **tx)
        .await?;
    Ok(())
}

fn activity(w: &mut Value, kind: &str, text: &str) {
    w["version"] = json!(w["version"].as_i64().unwrap() + 1);
    w["activity"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":new_id(),"kind":kind,"text":text,"created_at":now_unix()}));
}

pub async fn get(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let _lifecycle = s.instance_lifecycle.lock().await;
    let task = owned(&s, &user, &id).await?;
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    // Import legacy durable events, never the last-100 presentation window or
    // task.result. Missing revision stays unattributed. No worker is contacted.
    let events: Vec<(String, i64, String)> = sqlx::query_as("SELECT e.run_id,e.seq,e.event FROM burrow_agent_events e JOIN burrow_agent_runs r ON r.id=e.run_id WHERE r.task_id=? AND json_extract(e.event,'$.type')='final_message' AND NOT EXISTS(SELECT 1 FROM burrow_research_ingested i WHERE i.run_id=e.run_id AND i.seq=e.seq) ORDER BY r.rowid,e.seq")
        .bind(&id).fetch_all(&mut *tx).await.map_err(internal)?;
    for (run, seq, event) in events {
        let event: Value = serde_json::from_str(&event).map_err(internal)?;
        ingest(&mut tx, &task, &run, seq, &event["data"])
            .await
            .map_err(internal)?;
    }
    let w = load(&mut tx, &task).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(w))
}

#[derive(Deserialize)]
pub struct Change {
    version: i64,
    #[serde(flatten)]
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum Action {
    Brief {
        text: String,
        purchase_budget: String,
    },
    Candidate {
        candidate_id: String,
        note: String,
        shortlisted: bool,
    },
    Contribution {
        id: Option<String>,
        label: String,
        answer: String,
        done: bool,
    },
    Decision {
        candidate_id: String,
        comparison_id: String,
        rationale: String,
        tradeoffs: String,
        uncertainties: String,
    },
}

fn bounded(s: &str, max: usize, required: bool) -> Result<(), Error> {
    if s.len() > max || (required && s.trim().is_empty()) {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("Use {}–{max} bytes.", usize::from(required)),
        ));
    }
    Ok(())
}
fn conflict() -> Error {
    (
        StatusCode::CONFLICT,
        "Workspace changed or reached its limit. Refresh before editing.".into(),
    )
}

pub async fn change(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Change>,
) -> Result<Json<Value>, Error> {
    let _lifecycle = s.instance_lifecycle.lock().await;
    let task = owned(&s, &user, &id).await?;
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let mut w = load(&mut tx, &task).await.map_err(internal)?;
    if w["version"] != body.version || w["activity"].as_array().unwrap().len() >= 2000 {
        return Err(conflict());
    }
    let change = match body.action {
        Action::Brief {
            text,
            purchase_budget,
        } => {
            bounded(&text, 6000, true)?;
            bounded(&purchase_budget, 500, false)?;
            if w["briefs"].as_array().unwrap().len() >= 200 {
                return Err(conflict());
            }
            let brief = json!({"revision":w["brief"]["revision"].as_i64().unwrap()+1,"text":text,"purchase_budget":purchase_budget,"created_at":now_unix()});
            w["brief"] = brief.clone();
            w["briefs"].as_array_mut().unwrap().push(brief.clone());
            activity(&mut w, "brief", "Requirements saved. Existing research keeps its original basis; no new work started.");
            brief
        }
        Action::Candidate {
            candidate_id,
            note,
            shortlisted,
        } => {
            bounded(&note, 4000, false)?;
            let candidate = w["candidates"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|c| c["id"] == candidate_id)
                .ok_or_else(conflict)?;
            candidate["note"] = json!(note);
            candidate["shortlisted"] = json!(shortlisted);
            let saved = candidate.clone();
            activity(&mut w, "candidate", "Candidate note and shortlist saved.");
            saved
        }
        Action::Contribution {
            id,
            label,
            answer,
            done,
        } => {
            bounded(&label, 200, true)?;
            bounded(&answer, 4000, false)?;
            let contributions = w["contributions"].as_array_mut().unwrap();
            let value = json!({"id":id.clone().unwrap_or_else(new_id),"label":label,"answer":answer,"done":done});
            if let Some(id) = id {
                *contributions
                    .iter_mut()
                    .find(|c| c["id"] == id)
                    .ok_or_else(conflict)? = value.clone();
            } else {
                if contributions.len() >= 100 {
                    return Err(conflict());
                }
                contributions.push(value.clone());
            }
            activity(&mut w, "contribution", "Contribution saved.");
            value
        }
        Action::Decision {
            candidate_id,
            comparison_id,
            rationale,
            tradeoffs,
            uncertainties,
        } => {
            for text in [&rationale, &tradeoffs, &uncertainties] {
                bounded(text, 4000, false)?;
            }
            if w["decisions"].as_array().unwrap().len() >= 200 {
                return Err(conflict());
            }
            let comparison = w["comparisons"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["id"] == comparison_id)
                .ok_or_else(conflict)?;
            if !comparison["comparison"]["options"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o["id"] == candidate_id)
            {
                return Err(conflict());
            }
            let decision = json!({"id":new_id(),"candidate_id":candidate_id,"comparison_id":comparison_id,"requirements_revision":comparison["requirements_revision"],"rationale":rationale,"tradeoffs":tradeoffs,"uncertainties":uncertainties,"created_at":now_unix()});
            w["decisions"]
                .as_array_mut()
                .unwrap()
                .push(decision.clone());
            activity(
                &mut w,
                "decision",
                "Decision saved with its original comparison. Nothing was purchased.",
            );
            decision
        }
    };
    save(&mut tx, &id, &w, change).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(Json(w))
}

// Only exact normalized names plus exact source URL sets; never fuzzy matching.
fn key(option: &Value) -> Option<String> {
    let name = option["name"]
        .as_str()?
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    let mut urls = option["sources"]
        .as_array()?
        .iter()
        .map(|s| s["url"].as_str().map(str::to_owned))
        .collect::<Option<Vec<_>>>()?;
    urls.sort();
    urls.dedup();
    if name.is_empty() || urls.is_empty() {
        return None;
    }
    Some(json!([name, urls]).to_string())
}

/// Ingest once per durable event, before event presentation can be bounded.
pub(super) async fn ingest(
    tx: &mut Tx<'_>,
    task: &Task,
    run: &str,
    seq: i64,
    data: &Value,
) -> Result<(), sqlx::Error> {
    let Some(options) = data["comparison"]["options"].as_array() else {
        return Ok(());
    };
    if options.is_empty()
        || options.len() > 10
        || data["comparison"].to_string().len() > 256000
        || options
            .iter()
            .any(|o| !o.is_object() || !o["name"].is_string() || !o["sources"].is_array())
    {
        return Ok(());
    }
    let ingested: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM burrow_research_ingested WHERE run_id=? AND seq=?)",
    )
    .bind(run)
    .bind(seq)
    .fetch_one(&mut **tx)
    .await?;
    if ingested {
        return Ok(());
    }
    let mut w = load(tx, task).await?;
    let id = format!("{run}-{seq}");
    // No eviction: hit the bound rather than silently erase a decision's basis.
    if w["comparisons"].as_array().unwrap().len() >= 201 {
        return Err(sqlx::Error::Protocol(
            "Research comparison limit reached.".into(),
        ));
    }
    let mut old: HashMap<String, HashSet<String>> = HashMap::new();
    for c in w["comparisons"].as_array().unwrap() {
        for o in c["comparison"]["options"].as_array().unwrap() {
            if let Some(k) = key(o) {
                old.entry(k)
                    .or_default()
                    .insert(o["id"].as_str().unwrap().into());
            }
        }
    }
    let mut counts = HashMap::new();
    for o in options {
        if let Some(k) = key(o) {
            *counts.entry(k).or_insert(0) += 1;
        }
    }
    let mut comparison = data["comparison"].clone();
    for o in comparison["options"].as_array_mut().unwrap() {
        let existing = key(o)
            .and_then(|k| old.get(&k).filter(|ids| ids.len() == 1 && counts[&k] == 1))
            .and_then(|ids| ids.iter().next())
            .cloned();
        let candidate_id = existing.unwrap_or_else(new_id);
        if !w["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == candidate_id)
        {
            w["candidates"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":candidate_id,"name":o["name"],"note":"","shortlisted":false}));
        }
        o["id"] = json!(candidate_id);
    }
    // Attribution must refer to a captured admission/command, not today's brief.
    let requested = data["requirements_revision"].as_i64();
    let authorized: bool = if let Some(revision) = requested {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_runs WHERE id=? AND json_extract(requirements,'$.revision')=? UNION ALL SELECT 1 FROM burrow_agent_commands WHERE run_id=? AND phase='sent' AND json_extract(requirements,'$.revision')=?)")
            .bind(run).bind(revision).bind(run).bind(revision).fetch_one(&mut **tx).await?
    } else {
        false
    };
    let snapshot = json!({"id":id,"requirements_revision":requested.filter(|_| authorized),"created_at":now_unix(),"comparison":comparison});
    w["comparisons"]
        .as_array_mut()
        .unwrap()
        .push(snapshot.clone());
    activity(
        &mut w,
        "comparison",
        "Comparison saved with its research basis. Earlier snapshots remain available.",
    );
    save(tx, &task.id, &w, snapshot).await?;
    let content = data["content"]
        .as_str()
        .filter(|v| v.len() <= 100_000)
        .unwrap_or("");
    sqlx::query(
        "INSERT INTO burrow_research_ingested(run_id,seq,comparison_id,content) VALUES(?,?,?,?)",
    )
    .bind(run)
    .bind(seq)
    .bind(id)
    .bind(content)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

pub(super) fn instruction(brief: &Value) -> String {
    format!(
        "{}\nPurchasing budget (context only, NOT the research spending allowance): {}",
        brief["text"].as_str().unwrap_or(""),
        brief["purchase_budget"].as_str().unwrap_or("")
    )
}

/// Arrays remain chronological. Consumers select the last snapshot at the
/// greatest attributed revision; null ranks below every attributed revision.
pub(super) fn preferred(w: &Value) -> Option<&Value> {
    w["comparisons"]
        .as_array()?
        .iter()
        .max_by_key(|c| c["requirements_revision"].as_i64().unwrap_or(-1))
}
