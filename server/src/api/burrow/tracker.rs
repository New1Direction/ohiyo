//! A bounded, local launch-tracker editor. No model calls or generated executable code.
use super::{internal, new_id, now_unix, owned, AppState, AuthUser, Error, Task};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Layout {
    Table,
    Cards,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Period {
    Once,
    Monthly,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Item {
    title: String,
    owner: String,
    date: String,
    blocker: String,
    done: bool,
    extra: String,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Cost {
    title: String,
    cents: Option<i64>,
    period: Period,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Page {
    title: String,
    layout: Layout,
    simple: bool,
    stopped: bool,
    items: Vec<Item>,
    costs: Option<Vec<Cost>>,
    risks: Option<Vec<String>>,
    notes: String,
    extra_column: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub struct Proof {
    changed: Vec<String>,
    checks: Vec<String>,
    needs: Vec<String>,
    monthly_cents: i64,
    once_cents: i64,
}

#[derive(Deserialize, Serialize)]
pub struct ResultPage {
    page: Page,
    proof: Proof,
    reply: String,
    instruction: String,
    can_undo: bool,
}

pub fn initial(request: &str) -> ResultPage {
    let name = request
        .rsplit_once(" for ")
        .map(|(_, name)| name.trim().trim_end_matches(['.', '!']));
    let page = Page {
        title: name
            .filter(|s| !s.is_empty())
            .map(|s| format!("{} launch tracker", s.chars().take(60).collect::<String>()))
            .unwrap_or("Launch tracker".into()),
        layout: Layout::Table,
        simple: false,
        stopped: false,
        items: [
            "Define the launch goal",
            "Finish the first useful experience",
            "Test with early users",
            "Prepare the announcement",
            "Check support and recovery",
            "Share the launch",
        ]
        .into_iter()
        .map(|title| Item {
            title: title.into(),
            owner: String::new(),
            date: String::new(),
            blocker: String::new(),
            done: false,
            extra: String::new(),
        })
        .collect(),
        costs: None,
        risks: None,
        notes: String::new(),
        extra_column: None,
    };
    let proof = proof(None, &page);
    ResultPage {page, proof, reply: "Your tracker is ready. This is a starting checklist—add your people, dates, and real launch details.".into(), instruction: request.into(), can_undo: false}
}

#[derive(Deserialize)]
pub struct Change {
    version: i64,
    action: Action,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Action {
    Steer { text: String },
    Edit { page: Page },
    Undo,
    Fork,
}

fn invalid(message: &str) -> Error {
    (StatusCode::BAD_REQUEST, message.into())
}

fn validate(page: &Page) -> Result<(), Error> {
    if serde_json::to_vec(page).map_err(internal)?.len() > 64 * 1024 {
        return Err(invalid(
            "This page is getting too big. Keep it under 64 KB.",
        ));
    }
    if page.title.trim().is_empty()
        || page.title.len() > 300
        || page.items.is_empty()
        || page.items.len() > 100
        || page.notes.len() > 8000
    {
        return Err(invalid("Give your tracker a title and keep 1–100 checklist items. Notes can have up to 8,000 bytes."));
    }
    for item in &page.items {
        if item.title.trim().is_empty()
            || [&item.title, &item.owner, &item.blocker, &item.extra]
                .iter()
                .any(|s| s.len() > 500)
        {
            return Err(invalid(
                "Each checklist item needs a title. Keep each field under 500 bytes.",
            ));
        }
        if !item.date.is_empty()
            && (item.date.len() != 10
                || chrono::NaiveDate::parse_from_str(&item.date, "%Y-%m-%d").is_err())
        {
            return Err(invalid("Choose a valid date for each dated item."));
        }
    }
    if let Some(costs) = &page.costs {
        if costs.len() > 100
            || costs.iter().any(|c| {
                c.title.trim().is_empty()
                    || c.title.len() > 500
                    || c.cents.is_some_and(|n| !(0..=100_000_000_000).contains(&n))
            })
        {
            return Err(invalid(
                "Costs need names and non-negative amounts, with at most 100 entries.",
            ));
        }
    }
    if page
        .risks
        .as_ref()
        .is_some_and(|r| r.len() > 100 || r.iter().any(|s| s.trim().is_empty() || s.len() > 1000))
        || page
            .extra_column
            .as_ref()
            .is_some_and(|s| s.trim().is_empty() || s.len() > 80)
    {
        return Err(invalid(
            "Give each risk and column a short, non-empty name.",
        ));
    }
    Ok(())
}

fn proof(before: Option<&Page>, page: &Page) -> Proof {
    let mut changed = Vec::new();
    if before.is_none_or(|p| p.items != page.items) {
        changed.push("Launch checklist".into());
    }
    if before.is_none_or(|p| p.notes != page.notes) {
        changed.push("Notes".into());
    }
    if before.is_none_or(|p| p.costs != page.costs)
        && (page.costs.is_some() || before.is_some_and(|p| p.costs.is_some()))
    {
        changed.push("Supplier costs".into());
    }
    if before.is_none_or(|p| p.risks != page.risks)
        && (page.risks.is_some() || before.is_some_and(|p| p.risks.is_some()))
    {
        changed.push("Risks".into());
    }
    if before.is_some_and(|p| {
        p.layout != page.layout
            || p.simple != page.simple
            || p.extra_column != page.extra_column
            || p.title != page.title
    }) {
        changed.push("Page layout".into());
    }
    if before.is_some_and(|p| p.stopped != page.stopped) {
        changed.push("Editing status".into());
    }
    let mut checks = vec![
        format!(
            "Validated {} checklist titles and date formats",
            page.items.len()
        ),
        format!(
            "Recalculated progress: {} of {} complete",
            page.items.iter().filter(|i| i.done).count(),
            page.items.len()
        ),
    ];
    let mut monthly_cents = 0;
    let mut once_cents = 0;
    let mut needs = Vec::new();
    let owners = page
        .items
        .iter()
        .filter(|i| i.owner.trim().is_empty())
        .count();
    let dates = page.items.iter().filter(|i| i.date.is_empty()).count();
    if owners > 0 {
        needs.push(format!("{owners} owners still to choose"));
    }
    if dates > 0 {
        needs.push(format!("{dates} dates still to choose"));
    }
    if let Some(costs) = &page.costs {
        for cost in costs {
            match cost.period {
                Period::Monthly => monthly_cents += cost.cents.unwrap_or(0),
                Period::Once => once_cents += cost.cents.unwrap_or(0),
            }
        }
        checks.push(format!(
            "Recalculated {} cost entries, separating monthly and one-time amounts",
            costs.len()
        ));
        let unknown = costs.iter().filter(|c| c.cents.is_none()).count();
        if unknown > 0 {
            needs.push(format!(
                "{unknown} cost amounts still to fill in; totals include known amounts only"
            ));
        }
    }
    Proof {
        changed,
        checks,
        needs,
        monthly_cents,
        once_cents,
    }
}

fn steer(page: &mut Page, text: &str) -> Result<String, Error> {
    let text = text.trim().trim_end_matches(['.', '!']).to_lowercase();
    if text == "stop" {
        page.stopped = true;
        return Ok("Stopped. Your saved page stays here. Say ‘continue’ when you’re ready.".into());
    }
    if text == "continue" {
        page.stopped = false;
        return Ok("Ready for your next change.".into());
    }
    if page.stopped {
        return Err(invalid("Changes are stopped. Say ‘continue’ first."));
    }
    match text.as_str() {
        "add supplier costs and a risk section" | "add costs and risks" => {
            page.costs.get_or_insert_with(|| vec![Cost {title: "Supplier 1".into(), cents: None, period: Period::Once}, Cost {title: "Supplier 2".into(), cents: None, period: Period::Once}]);
            page.risks.get_or_insert_with(Vec::new);
            Ok("Added supplier costs and risks. Amounts are blank until you enter them.".into())
        }
        "actually make the costs monthly" | "make the costs monthly" | "make costs monthly" => {
            let costs = page.costs.as_mut().ok_or(invalid("Add supplier costs first."))?;
            for cost in costs { cost.period = Period::Monthly; }
            Ok("Costs are monthly now. I kept the amounts you entered and recalculated the monthly total.".into())
        }
        "make it simpler" => { page.simple = true; Ok("A simpler view. Blockers and extra details are tucked away, not deleted.".into()) }
        "show all details" => { page.simple = false; Ok("All your details are visible again.".into()) }
        "use cards instead" | "use cards" => { page.layout = Layout::Cards; Ok("Switched to cards. Your checklist is unchanged.".into()) }
        "use a table" | "use table" => { page.layout = Layout::Table; Ok("Switched to a table.".into()) }
        "add one more column" => { page.extra_column.get_or_insert("Details".into()); page.simple = false; Ok("Added a Details column. You can fill it in on each item.".into()) }
        _ => Err(invalid("I can change this tracker with the suggestions below, or you can edit its fields directly. I haven’t changed anything.")),
    }
}

pub async fn change(
    State(s): State<AppState>,
    AuthUser(user, _): AuthUser,
    Path(id): Path<String>,
    Json(body): Json<Change>,
) -> Result<Json<Task>, Error> {
    let task = owned(&s, &user, &id).await?;
    if task.kind != "tracker" || task.template.is_some() {
        return Err(invalid("Open a launch tracker to change its page."));
    }
    if matches!(&body.action, Action::Steer {text} if text.chars().count() > 2000) {
        return Err(invalid("Keep your change request under 2,000 characters."));
    }
    if body.version != task.version {
        return Err((StatusCode::CONFLICT, "This page changed elsewhere. Your request wasn't applied. Try again with the latest page.".into()));
    }
    let old: ResultPage = serde_json::from_str(&task.result).map_err(internal)?;
    let mut page = old.page.clone();
    let instruction;
    let reply;
    let mut tx = s.db.begin().await.map_err(internal)?;
    // Acquire the write lock and reject stale edits before modifying undo history.
    let locked = sqlx::query(
        "UPDATE burrow_tasks SET version=version WHERE id=? AND user_id=? AND version=?",
    )
    .bind(&id)
    .bind(&user)
    .bind(body.version)
    .execute(&mut *tx)
    .await
    .map_err(internal)?
    .rows_affected();
    if locked == 0 {
        return Err((
            StatusCode::CONFLICT,
            "This page changed elsewhere. Please try again.".into(),
        ));
    }
    let is_undo = matches!(&body.action, Action::Undo)
        || matches!(&body.action, Action::Steer{text} if matches!(text.trim().trim_end_matches(['.', '!']).to_lowercase().as_str(), "undo" | "undo that"));
    let is_fork = matches!(&body.action, Action::Fork)
        || matches!(&body.action, Action::Steer{text} if text.trim().trim_end_matches(['.', '!']).eq_ignore_ascii_case("make a second version"));
    if is_fork {
        page.title = format!(
            "{} · another version",
            page.title.chars().take(60).collect::<String>()
        );
        validate(&page)?;
        let result = ResultPage {
            proof: proof(Some(&old.page), &page),
            page,
            reply: "Here’s a separate copy. Changes here won’t touch the original.".into(),
            instruction: "Make a second version".into(),
            can_undo: false,
        };
        let next_id = new_id();
        let now = now_unix();
        let inserted = sqlx::query("INSERT INTO burrow_tasks (id,user_id,request,kind,state,result,created_at,updated_at) SELECT ?,?,?,'tracker','draft_ready',?,?,? WHERE (SELECT count(*) FROM burrow_tasks WHERE user_id=?) < 200")
            .bind(&next_id).bind(&user).bind(&result.page.title).bind(serde_json::to_string(&result).map_err(internal)?).bind(now).bind(now).bind(&user).execute(&mut *tx).await.map_err(internal)?.rows_affected();
        if inserted == 0 {
            return Err((
                StatusCode::CONFLICT,
                "Your workspace has reached its 200-task limit.".into(),
            ));
        }
        tx.commit().await.map_err(internal)?;
        return owned(&s, &user, &next_id).await.map(Json);
    }
    if is_undo {
        let entry: Option<(i64, String)> = sqlx::query_as(
            "SELECT id,result FROM burrow_tracker_history WHERE task_id=? ORDER BY id DESC LIMIT 1",
        )
        .bind(&id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(internal)?;
        let (history_id, previous) = entry.ok_or(invalid("There’s nothing to undo yet."))?;
        page = serde_json::from_str::<ResultPage>(&previous)
            .map_err(internal)?
            .page;
        sqlx::query("DELETE FROM burrow_tracker_history WHERE id=?")
            .bind(history_id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        instruction = "Undo that".into();
        reply = "Undid the last saved change.".into();
    } else {
        match body.action {
            Action::Steer { text } => {
                reply = steer(&mut page, &text)?;
                instruction = text;
            }
            Action::Edit { page: next } => {
                if old.page.stopped {
                    return Err(invalid("Changes are stopped. Say ‘continue’ first."));
                }
                if next.stopped != old.page.stopped {
                    return Err(invalid("Use Stop or Continue to change editing status."));
                }
                page = next;
                instruction = "Edited the page".into();
                reply = "Saved your changes.".into();
            }
            _ => unreachable!(),
        }
        sqlx::query("INSERT INTO burrow_tracker_history (task_id,result) VALUES (?,?)")
            .bind(&id)
            .bind(&task.result)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        // Undo is intentionally bounded, independent of how long a page stays alive.
        sqlx::query("DELETE FROM burrow_tracker_history WHERE task_id=? AND id NOT IN (SELECT id FROM burrow_tracker_history WHERE task_id=? ORDER BY id DESC LIMIT 30)").bind(&id).bind(&id).execute(&mut *tx).await.map_err(internal)?;
    }
    validate(&page)?;
    let (history_count,): (i64,) =
        sqlx::query_as("SELECT count(*) FROM burrow_tracker_history WHERE task_id=?")
            .bind(&id)
            .fetch_one(&mut *tx)
            .await
            .map_err(internal)?;
    let result = ResultPage {
        proof: proof(Some(&old.page), &page),
        page,
        reply,
        instruction,
        can_undo: history_count > 0,
    };
    sqlx::query("UPDATE burrow_tasks SET result=?,version=version+1,updated_at=? WHERE id=? AND user_id=? AND version=?")
        .bind(serde_json::to_string(&result).map_err(internal)?).bind(now_unix()).bind(&id).bind(&user).bind(body.version).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    owned(&s, &user, &id).await.map(Json)
}
