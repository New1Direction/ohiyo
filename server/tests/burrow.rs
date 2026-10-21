//! Exercise the real authenticated API with a local writing-service fixture, never a paid model.
mod common;

use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::Burrow;
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

type Inbox = Arc<Mutex<Vec<Value>>>;

async fn fixture(State(inbox): State<Inbox>, Json(body): Json<Value>) -> (StatusCode, Json<Value>) {
    inbox.lock().unwrap().push(body.clone());
    tokio::time::sleep(Duration::from_millis(100)).await;
    let request = body["messages"][1]["content"].as_str().unwrap();
    if let Ok(input) = serde_json::from_str::<Value>(request) {
        if body["max_tokens"] == 128 {
            if input["request"] == "stop during selection" {
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
            let skill = if input["request"] == "invalid skill" {
                "../../private"
            } else {
                "teaching-from-material"
            };
            return (
                StatusCode::OK,
                Json(
                    json!({"choices":[{"finish_reason":"stop","message":{"content":json!({"skill":skill}).to_string()}}]}),
                ),
            );
        }
        let mut answer: Value =
            serde_json::from_str(include_str!("../src/api/burrow/examples/quiz.json")).unwrap();
        match input["request"].as_str().unwrap() {
            "make it forest" => answer["page"]["theme"] = json!("forest"),
            "late response" => tokio::time::sleep(Duration::from_millis(300)).await,
            "unsafe script" => {
                answer["page"]["spec"]["elements"]["intro"]["type"] = json!("script")
            }
            "unsafe event" => {
                answer["page"]["spec"]["elements"]["intro"]["on"] =
                    json!({"press":{"action":"fetch"}})
            }
            "bad answer" => {
                answer["page"]["spec"]["elements"]["quiz"]["props"]["questions"][0]["answer"] =
                    json!(3)
            }
            "bad layout" => {
                answer["page"]["spec"]["elements"]["root"]["children"] = json!(["root"])
            }
            _ => (),
        }
        return (
            StatusCode::OK,
            Json(
                json!({"choices":[{"finish_reason":"stop","message":{"content":answer.to_string()}}]}),
            ),
        );
    }
    if request == "service failure" {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error":"private upstream detail"})),
        );
    }
    let (reason, content) = if request == "truncated" {
        ("length", "unfinished")
    } else if request == "empty" {
        ("stop", "   ")
    } else if request == "launch plan" {
        (
            "stop",
            "Launch plan\nWeek 1: interview five customers.\nWeek 2: test pricing.",
        )
    } else {
        (
            "stop",
            "Event checklist\nChoose a venue.\nConfirm accessibility.",
        )
    };
    (
        StatusCode::OK,
        Json(json!({"choices":[{"finish_reason":reason,"message":{"content":content}}]})),
    )
}

async fn configured() -> (TestServer, String, String, Inbox) {
    let inbox = Inbox::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/completions", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/completions", post(fixture))
        .with_state(inbox.clone());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let srv = TestServer::start_with(|s| {
        s.burrow = Some(Burrow {
            endpoint,
            model: "fixture".into(),
            api_key: "fixture-only".into(),
            users: HashSet::from(["pilot".into()]),
            client: reqwest::Client::new(),
        });
    })
    .await;
    for id in ["pilot", "outsider"] {
        sqlx::query("INSERT INTO users (id,username,display_name,password_hash,created_at) VALUES (?,?,?,'unused',0)")
            .bind(id).bind(id).bind(id).execute(&srv.state.db).await.unwrap();
    }
    let secret = server::auth::jwt_secret();
    let pilot = server::auth::create_token("pilot", 0, &secret).unwrap();
    let outsider = server::auth::create_token("outsider", 0, &secret).unwrap();
    (srv, pilot, outsider, inbox)
}

async fn create(s: &TestServer, token: &str, request: &str) -> Value {
    let r = s
        .post_json_auth("/api/v1/burrow/tasks", token, json!({"request": request}))
        .await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}

async fn workspace(s: &TestServer, token: &str) -> Value {
    s.get_auth("/api/v1/burrow", token)
        .await
        .json()
        .await
        .unwrap()
}

async fn settled(s: &TestServer, token: &str, id: &str) -> Value {
    for _ in 0..100 {
        let w = workspace(s, token).await;
        let task = w["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == id)
            .unwrap();
        if task["state"] != "working" {
            return task.clone();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("task did not settle");
}

#[tokio::test]
async fn independent_tasks_require_permission_and_keep_owner_scoped_editable_results() {
    let (s, pilot, outsider, inbox) = configured().await;
    assert_eq!(
        s.client
            .get(s.url("/api/v1/burrow"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let a = create(&s, &pilot, "launch plan").await;
    let b = create(&s, &pilot, "event checklist").await;
    let a_id = a["id"].as_str().unwrap();
    let b_id = b["id"].as_str().unwrap();
    assert_eq!(a["state"], "waiting");
    assert_eq!(
        workspace(&s, &pilot).await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert!(
        inbox.lock().unwrap().is_empty(),
        "saving must not disclose a request"
    );
    let run_a = format!("/api/v1/burrow/tasks/{a_id}/run");
    assert_eq!(
        s.post_json_auth(&run_a, &pilot, json!({"allow_generation":false}))
            .await
            .status(),
        400
    );
    assert_eq!(
        s.post_json_auth(&run_a, &outsider, json!({"allow_generation":true}))
            .await
            .status(),
        404
    );
    let started: Value = s
        .post_json_auth(&run_a, &pilot, json!({"allow_generation":true}))
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(started["state"], "working");
    assert_eq!(
        s.post_json_auth(&run_a, &pilot, json!({"allow_generation":true}))
            .await
            .status(),
        409
    );
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{b_id}/run"),
            &pilot,
            json!({"allow_generation":true})
        )
        .await
        .status(),
        200
    );
    let a = settled(&s, &pilot, a_id).await;
    let b = settled(&s, &pilot, b_id).await;
    assert_eq!(a["state"], "draft_ready");
    assert_eq!(
        a["result"],
        "Launch plan\nWeek 1: interview five customers.\nWeek 2: test pricing."
    );
    assert_eq!(
        b["result"],
        "Event checklist\nChoose a venue.\nConfirm accessibility."
    );
    for body in inbox.lock().unwrap().iter() {
        assert_eq!(
            body["messages"].as_array().unwrap().len(),
            2,
            "no cross-task conversation context"
        );
        assert_eq!(body["max_tokens"], 2048);
    }
    let foreign = workspace(&s, &outsider).await;
    assert_eq!(foreign["tasks"], json!([]));
    assert_eq!(foreign["can_run"], false);
    let path = format!("/api/v1/burrow/tasks/{a_id}/result");
    let edit = json!({"result":"Revised plan: interview seven customers.","version":a["version"]});
    assert_eq!(
        s.client
            .patch(s.url(&path))
            .bearer_auth(&outsider)
            .json(&edit)
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        s.client
            .patch(s.url(&path))
            .bearer_auth(&pilot)
            .json(&edit)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        s.client
            .patch(s.url(&path))
            .bearer_auth(&pilot)
            .json(&edit)
            .send()
            .await
            .unwrap()
            .status(),
        409,
        "stale editor must not overwrite"
    );
    let persisted = workspace(&s, &pilot).await;
    let result = persisted["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == a_id)
        .unwrap();
    assert_eq!(result["result"], "Revised plan: interview seven customers.");
    assert_eq!(
        inbox.lock().unwrap().len(),
        2,
        "edits and duplicate approvals cannot spend again"
    );
}

#[tokio::test]
async fn failures_and_restart_are_honest_and_never_automatically_retry() {
    let (s, pilot, outsider, inbox) = configured().await;
    for request in ["service failure", "truncated", "empty"] {
        let task = create(&s, &pilot, request).await;
        let id = task["id"].as_str().unwrap();
        assert_eq!(
            s.post_json_auth(
                &format!("/api/v1/burrow/tasks/{id}/run"),
                &pilot,
                json!({"allow_generation":true})
            )
            .await
            .status(),
            200
        );
        let failed = settled(&s, &pilot, id).await;
        assert_eq!(failed["state"], "failed");
        assert_eq!(failed["result"], "");
        assert!(!failed["error"]
            .as_str()
            .unwrap()
            .contains("private upstream detail"));
    }
    let task = create(&s, &pilot, "interrupted request").await;
    sqlx::query("UPDATE burrow_tasks SET state='working' WHERE id=?")
        .bind(task["id"].as_str().unwrap())
        .execute(&s.state.db)
        .await
        .unwrap();
    server::api::burrow::recover(&s.state.db).await.unwrap();
    let failed = settled(&s, &pilot, task["id"].as_str().unwrap()).await;
    assert_eq!(failed["state"], "failed");
    assert!(failed["error"]
        .as_str()
        .unwrap()
        .contains("previous attempt may have incurred a charge"));
    assert_eq!(inbox.lock().unwrap().len(), 3);
    let unapproved = create(&s, &outsider, "not on allowlist").await;
    assert_eq!(
        s.post_json_auth(
            &format!(
                "/api/v1/burrow/tasks/{}/run",
                unapproved["id"].as_str().unwrap()
            ),
            &outsider,
            json!({"allow_generation":true})
        )
        .await
        .status(),
        503
    );
}

#[tokio::test]
async fn daily_admission_limit_uses_persisted_attempts_and_counts_failures() {
    let (s, pilot, _, inbox) = configured().await;
    let task = create(&s, &pilot, "service failure").await;
    let id = task["id"].as_str().unwrap();
    let path = format!("/api/v1/burrow/tasks/{id}/run");
    // Nine prior attempts, including an uncertain one, leave exactly one admission.
    for _ in 0..9 {
        sqlx::query("INSERT INTO burrow_attempts (task_id,started_at) VALUES (?,?)")
            .bind(id)
            .bind(server::types::now_unix())
            .execute(&s.state.db)
            .await
            .unwrap();
    }
    assert_eq!(
        s.post_json_auth(&path, &pilot, json!({"allow_generation":true}))
            .await
            .status(),
        200
    );
    assert_eq!(settled(&s, &pilot, id).await["state"], "failed");
    assert_eq!(
        s.post_json_auth(&path, &pilot, json!({"allow_generation":true}))
            .await
            .status(),
        409
    );
    assert_eq!(inbox.lock().unwrap().len(), 1);
    assert_eq!(
        s.post_json_auth("/api/v1/burrow/tasks", &pilot, json!({"request":" "}))
            .await
            .status(),
        400
    );
    assert_eq!(
        s.post_json_auth(
            "/api/v1/burrow/tasks",
            &pilot,
            json!({"request":"é".repeat(8001)})
        )
        .await
        .status(),
        400
    );
}

async fn change_tracker(s: &TestServer, token: &str, task: &Value, action: Value) -> Value {
    let response = s
        .post_json_auth(
            &format!(
                "/api/v1/burrow/tasks/{}/tracker",
                task["id"].as_str().unwrap()
            ),
            token,
            json!({"version":task["version"],"action":action}),
        )
        .await;
    assert_eq!(response.status(), 200, "{}", response.text().await.unwrap());
    response.json().await.unwrap()
}

fn tracker_result(task: &Value) -> Value {
    serde_json::from_str(task["result"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn launch_tracker_is_live_saved_undoable_and_independent_without_a_model() {
    let (s, _, owner, inbox) = configured().await;
    let response = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            &owner,
            json!({"request":"Make me a launch tracker for Burrow.","kind":"tracker"}),
        )
        .await;
    assert_eq!(response.status(), 200);
    let initial: Value = response.json().await.unwrap();
    assert_eq!(initial["kind"], "tracker");
    assert_eq!(
        tracker_result(&initial)["page"]["title"],
        "Burrow launch tracker"
    );
    assert_eq!(tracker_result(&initial)["page"]["items"][0]["owner"], "");
    let sections = change_tracker(
        &s,
        &owner,
        &initial,
        json!({"type":"steer","text":"Add supplier costs and a risk section."}),
    )
    .await;
    assert_eq!(
        tracker_result(&sections)["proof"]["changed"],
        json!(["Supplier costs", "Risks"])
    );
    let mut page = tracker_result(&sections)["page"].clone();
    page["costs"][0]["cents"] = json!(12345);
    page["costs"][1]["cents"] = json!(6789);
    page["costs"][1]["period"] = json!("monthly");
    page["costs"]
        .as_array_mut()
        .unwrap()
        .push(json!({"title":"Unknown shipping","cents":null,"period":"monthly"}));
    page["items"][1]["done"] = json!(true);
    page["items"][1]["owner"] = json!("Maya");
    page["items"][1]["date"] = json!("2026-11-07");
    page["notes"] = json!("Keep the launch small.");
    let edited = change_tracker(&s, &owner, &sections, json!({"type":"edit","page":page})).await;
    assert_eq!(tracker_result(&edited)["proof"]["monthly_cents"], 6789);
    assert_eq!(tracker_result(&edited)["proof"]["once_cents"], 12345);
    let monthly = change_tracker(
        &s,
        &owner,
        &edited,
        json!({"type":"steer","text":"Actually make the costs monthly."}),
    )
    .await;
    assert_eq!(tracker_result(&monthly)["proof"]["monthly_cents"], 19134);
    assert_eq!(tracker_result(&monthly)["proof"]["once_cents"], 0);
    assert_eq!(
        tracker_result(&monthly)["page"]["costs"][2]["cents"],
        Value::Null
    );
    assert!(tracker_result(&monthly)["proof"]["needs"]
        .as_array()
        .unwrap()
        .iter()
        .any(|s| s.as_str().unwrap().starts_with("1 cost amounts")));
    let undone = change_tracker(
        &s,
        &owner,
        &monthly,
        json!({"type":"steer","text":"undo that"}),
    )
    .await;
    assert_eq!(tracker_result(&undone)["page"], page);
    assert!(undone["version"].as_i64().unwrap() > monthly["version"].as_i64().unwrap());
    let copy = change_tracker(
        &s,
        &owner,
        &undone,
        json!({"type":"steer","text":"make a second version"}),
    )
    .await;
    assert_ne!(copy["id"], undone["id"]);
    let cards = change_tracker(
        &s,
        &owner,
        &copy,
        json!({"type":"steer","text":"use cards instead"}),
    )
    .await;
    let simple = change_tracker(
        &s,
        &owner,
        &cards,
        json!({"type":"steer","text":"make it simpler"}),
    )
    .await;
    assert_eq!(tracker_result(&simple)["page"]["simple"], true);
    assert_eq!(tracker_result(&simple)["page"]["items"], page["items"]);
    let stopped = change_tracker(&s, &owner, &simple, json!({"type":"steer","text":"stop"})).await;
    let blocked = s.post_json_auth(&format!("/api/v1/burrow/tasks/{}/tracker", stopped["id"].as_str().unwrap()), &owner,
        json!({"version":stopped["version"],"action":{"type":"steer","text":"add one more column"}})).await;
    assert_eq!(blocked.status(), 400);
    let resumed = change_tracker(
        &s,
        &owner,
        &stopped,
        json!({"type":"steer","text":"continue"}),
    )
    .await;
    let column = change_tracker(
        &s,
        &owner,
        &resumed,
        json!({"type":"steer","text":"add one more column"}),
    )
    .await;
    assert_eq!(tracker_result(&column)["page"]["extra_column"], "Details");
    assert_eq!(tracker_result(&column)["page"]["simple"], false);
    let saved = workspace(&s, &owner).await;
    let original = saved["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == initial["id"])
        .unwrap();
    assert_eq!(
        tracker_result(original)["page"],
        page,
        "editing the copy must not touch the original"
    );
    assert_eq!(
        saved["can_run"], false,
        "trackers work even when writing is disabled"
    );
    assert!(
        inbox.lock().unwrap().is_empty(),
        "no model calls for local tracker operations"
    );
}

#[tokio::test]
async fn tracker_rejects_foreign_stale_invalid_and_unsupported_changes_without_losing_history() {
    let (s, owner, foreign, inbox) = configured().await;
    let task: Value = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            &owner,
            json!({"request":"Launch tracker", "kind":"tracker"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let path = format!(
        "/api/v1/burrow/tasks/{}/tracker",
        task["id"].as_str().unwrap()
    );
    let edit =
        json!({"version":task["version"], "action":{"type":"steer","text":"use cards instead"}});
    assert_eq!(
        s.post_json_auth(&path, &foreign, edit.clone())
            .await
            .status(),
        404
    );
    let (first, second) = tokio::join!(
        s.post_json_auth(&path, &owner, edit.clone()),
        s.post_json_auth(&path, &owner, edit)
    );
    let mut statuses = [first.status().as_u16(), second.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let current = workspace(&s, &owner).await["tasks"][0].clone();
    for text in [
        "contact all suppliers",
        "make it simpler and delete the checklist",
    ] {
        assert_eq!(
            s.post_json_auth(
                &path,
                &owner,
                json!({"version":current["version"],"action":{"type":"steer","text":text}})
            )
            .await
            .status(),
            400
        );
    }
    for bad in [json!("2026-02-30"), json!("not a date")] {
        let mut page = tracker_result(&current)["page"].clone();
        page["items"][0]["date"] = bad;
        assert_eq!(
            s.post_json_auth(
                &path,
                &owner,
                json!({"version":current["version"],"action":{"type":"edit","page":page}})
            )
            .await
            .status(),
            400
        );
    }
    let mut page = tracker_result(&current)["page"].clone();
    page["costs"] = json!([{"title":"Invalid","cents":-1,"period":"monthly"}]);
    assert_eq!(
        s.post_json_auth(
            &path,
            &owner,
            json!({"version":current["version"],"action":{"type":"edit","page":page}})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{}/run", task["id"].as_str().unwrap()),
            &owner,
            json!({"allow_generation":true})
        )
        .await
        .status(),
        400
    );
    let undone = change_tracker(&s, &owner, &current, json!({"type":"undo"})).await;
    assert_eq!(
        tracker_result(&undone)["page"],
        tracker_result(&task)["page"],
        "rejected changes cannot pollute undo history"
    );
    assert_eq!(tracker_result(&undone)["can_undo"], false);
    assert!(inbox.lock().unwrap().is_empty());
}

async fn everyday_page(s: &TestServer, token: &str, template: &str) -> Value {
    let response = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            token,
            json!({"kind":"tracker","template":template,"request":format!("My {template}")}),
        )
        .await;
    assert_eq!(response.status(), 200);
    response.json().await.unwrap()
}

async fn save_everyday(
    s: &TestServer,
    token: &str,
    task: &Value,
    page: &Value,
) -> reqwest::Response {
    s.patch_json_auth(
        &format!(
            "/api/v1/burrow/tasks/{}/result",
            task["id"].as_str().unwrap()
        ),
        token,
        json!({"version":task["version"],"result":page.to_string()}),
    )
    .await
}

#[tokio::test]
async fn shared_bills_settle_exact_cents_and_only_the_selected_people_without_moving_money() {
    let (s, owner, other, inbox) = configured().await;
    let task = everyday_page(&s, &owner, "bill").await;
    assert_eq!(task["template"], "bill");
    let page = json!({"type":"bill","title":"Friday with friends","currency":"USD",
    "people":[{"id":"a","name":"Alex"},{"id":"b","name":"Maya"},{"id":"c","name":"Sam"}],
    "expenses":[
        {"id":"dinner","title":"Dinner","amount":"100.01","paid_by":"a","shared_by":["a","b","c"]},
        {"id":"taxi","title":"Taxi","amount":"19.99","paid_by":"b","shared_by":["b","c"]},
        {"id":"coffee","title":"Coffee","amount":"5.03","paid_by":"c","shared_by":["c","a"]}
    ]});
    assert_eq!(save_everyday(&s, &other, &task, &page).await.status(), 404);
    let response = save_everyday(&s, &owner, &task, &page).await;
    assert_eq!(response.status(), 200);
    let saved: Value = response.json().await.unwrap();
    let result = tracker_result(&saved);
    assert_eq!(result["summary"]["total_cents"], 12503);
    assert_eq!(
        result["summary"]["people"],
        json!([
            {"id":"a","paid_cents":10001,"share_cents":3586},
            {"id":"b","paid_cents":1999,"share_cents":4334},
            {"id":"c","paid_cents":503,"share_cents":4583}
        ])
    );
    assert_eq!(
        result["summary"]["payments"],
        json!([
            {"from":"b","to":"a","cents":2335},{"from":"c","to":"a","cents":4080}
        ])
    );
    assert_eq!(save_everyday(&s, &owner, &task, &page).await.status(), 409);
    for amount in ["-1", "0", "1.001", "1e3", "NaN", "1000000.01", ""] {
        let mut bad = page.clone();
        bad["expenses"][0]["amount"] = json!(amount);
        assert_eq!(
            save_everyday(&s, &owner, &saved, &bad).await.status(),
            400,
            "{amount}"
        );
    }
    for sharers in [json!([]), json!(["a", "a"]), json!(["not-here"])] {
        let mut bad = page.clone();
        bad["expenses"][0]["shared_by"] = sharers;
        assert_eq!(save_everyday(&s, &owner, &saved, &bad).await.status(), 400);
    }
    let mut bad = page.clone();
    bad["people"][1]["id"] = json!("a");
    assert_eq!(save_everyday(&s, &owner, &saved, &bad).await.status(), 400);
    let mut bad = page.clone();
    bad["expenses"][0]["paid_by"] = json!("not-here");
    assert_eq!(save_everyday(&s, &owner, &saved, &bad).await.status(), 400);
    let mut even = page.clone();
    even["expenses"] = json!([
        {"id":"one","title":"One","amount":"1","paid_by":"a","shared_by":["a","b","c"]},
        {"id":"two","title":"Two","amount":"2","paid_by":"b","shared_by":["a","b","c"]}
    ]);
    let (left, right) = tokio::join!(
        save_everyday(&s, &owner, &saved, &even),
        save_everyday(&s, &owner, &saved, &even)
    );
    let mut statuses = [left.status().as_u16(), right.status().as_u16()];
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let w = workspace(&s, &owner).await;
    let current = &w["tasks"][0];
    assert_eq!(current["request"], "Friday with friends");
    assert_eq!(
        tracker_result(current)["summary"]["payments"],
        // Shares are 1.01, 1.00, and 0.99; the first payer is one cent short.
        json!([{"from":"a","to":"b","cents":1},{"from":"c","to":"b","cents":99}])
    );
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{}/run", task["id"].as_str().unwrap()),
            &owner,
            json!({"allow_generation":true})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        s.post_json_auth(
            &format!(
                "/api/v1/burrow/tasks/{}/tracker",
                task["id"].as_str().unwrap()
            ),
            &owner,
            json!({"version":current["version"],"action":{"type":"fork"}})
        )
        .await
        .status(),
        400
    );
    assert!(inbox.lock().unwrap().is_empty());
}

#[tokio::test]
async fn packing_lists_follow_the_trip_preserve_personal_items_and_recheck_changed_quantities() {
    let (s, owner, other, inbox) = configured().await;
    let task = everyday_page(&s, &owner, "packing").await;
    let mut page = tracker_result(&task)["page"].clone();
    assert_eq!(page["nights"], 3);
    for item in page["items"].as_array_mut().unwrap() {
        item["packed"] = json!(true);
    }
    page["items"]
        .as_array_mut()
        .unwrap()
        .push(json!({"id":"my-book","title":"My book","quantity":1,"packed":true,"custom":true}));
    page["title"] = json!("Lisbon weekend");
    page["nights"] = json!(1);
    page["weather"] = json!("warm");
    page["activities"] = json!(["swimming", "abroad"]);
    assert_eq!(save_everyday(&s, &other, &task, &page).await.status(), 404);
    let response = save_everyday(&s, &owner, &task, &page).await;
    assert_eq!(response.status(), 200);
    let saved: Value = response.json().await.unwrap();
    let result = tracker_result(&saved);
    let items = result["page"]["items"].as_array().unwrap();
    let item = |id: &str| items.iter().find(|i| i["id"] == id).unwrap();
    assert_eq!(item("underwear")["quantity"], 2);
    assert_eq!(
        item("underwear")["packed"],
        false,
        "a packed count for four must not imply two were checked"
    );
    assert_eq!(item("id")["packed"], true);
    assert_eq!(item("my-book")["packed"], true);
    assert_eq!(item("passport")["packed"], false);
    assert_eq!(item("swim")["quantity"], 1);
    assert!(!items.iter().any(|i| i["id"] == "rain" || i["id"] == "coat"));
    for (key, value) in [
        ("nights", json!(0)),
        ("nights", json!(31)),
        ("weather", json!("forecast")),
        ("activities", json!(["swimming", "swimming"])),
    ] {
        let mut bad = result["page"].clone();
        bad[key] = value;
        assert_eq!(save_everyday(&s, &owner, &saved, &bad).await.status(), 400);
    }
    let mut long_trip = result["page"].clone();
    long_trip["nights"] = json!(30);
    long_trip["weather"] = json!("cold");
    let response = save_everyday(&s, &owner, &saved, &long_trip).await;
    assert_eq!(response.status(), 200);
    let later: Value = response.json().await.unwrap();
    let later_items = tracker_result(&later)["page"]["items"]
        .as_array()
        .unwrap()
        .clone();
    assert!(later_items
        .iter()
        .any(|i| i["id"] == "underwear" && i["quantity"] == 7));
    assert!(later_items.iter().any(|i| i["id"] == "coat"));
    assert!(!later_items.iter().any(|i| i["id"] == "sun"));
    assert_eq!(save_everyday(&s, &owner, &saved, &page).await.status(), 409);
    let bill = tracker_result(&everyday_page(&s, &owner, "bill").await)["page"].clone();
    assert_eq!(save_everyday(&s, &owner, &later, &bill).await.status(), 400);
    assert!(workspace(&s, &other).await["tasks"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(inbox.lock().unwrap().is_empty());
}

#[tokio::test]
async fn creations_require_consent_preserve_revisions_and_reject_stopped_completions() {
    let (s, owner, other, inbox) = configured().await;
    let task: Value = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            &owner,
            json!({"format":"creation","request":"Turn my notes into a quiz"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let id = task["id"].as_str().unwrap();
    let run = format!("/api/v1/burrow/tasks/{id}/run");
    let change = format!("/api/v1/burrow/tasks/{id}/creation");
    assert_eq!(task["state"], "waiting");
    assert_eq!(tracker_result(&task)["page"], Value::Null);
    assert!(inbox.lock().unwrap().is_empty());
    for (token, body, status) in [
        (
            &owner,
            json!({"version":task["version"],"allow_generation":false}),
            400,
        ),
        (
            &other,
            json!({"version":task["version"],"allow_generation":true}),
            404,
        ),
        (&owner, json!({"allow_generation":true}), 409),
    ] {
        assert_eq!(s.post_json_auth(&run, token, body).await.status(), status);
    }
    assert_eq!(
        s.post_json_auth(
            &run,
            &owner,
            json!({"version":task["version"],"allow_generation":true})
        )
        .await
        .status(),
        200
    );
    let first = settled(&s, &owner, id).await;
    assert_eq!(first["state"], "draft_ready");
    assert_eq!(tracker_result(&first)["page"]["theme"], "violet");
    assert_eq!(tracker_result(&first)["can_undo"], false);
    assert_eq!(s.post_json_auth(&run, &owner, json!({"version":task["version"],"allow_generation":true,"instruction":"make it forest"})).await.status(), 409);
    assert_eq!(s.post_json_auth(&run, &owner, json!({"version":first["version"],"allow_generation":true,"instruction":"make it forest"})).await.status(), 200);
    let second = settled(&s, &owner, id).await;
    assert_eq!(second["state"], "draft_ready");
    assert_eq!(tracker_result(&second)["page"]["theme"], "forest");
    assert_eq!(tracker_result(&second)["can_undo"], true);
    assert_eq!(
        s.post_json_auth(
            &change,
            &other,
            json!({"version":second["version"],"action":"undo"})
        )
        .await
        .status(),
        404
    );
    let undone: Value = s
        .post_json_auth(
            &change,
            &owner,
            json!({"version":second["version"],"action":"undo"}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        tracker_result(&undone)["page"],
        tracker_result(&first)["page"]
    );
    assert!(undone["version"].as_i64().unwrap() > second["version"].as_i64().unwrap());
    assert_eq!(tracker_result(&undone)["can_undo"], false);
    assert_eq!(
        s.post_json_auth(
            &change,
            &owner,
            json!({"version":second["version"],"action":"undo"})
        )
        .await
        .status(),
        409
    );
    assert_eq!(
        s.patch_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/result"),
            &owner,
            json!({"version":undone["version"],"result":"bypass"})
        )
        .await
        .status(),
        400
    );
    let working: Value = s.post_json_auth(&run, &owner, json!({"version":undone["version"],"allow_generation":true,"instruction":"late response"})).await.json().await.unwrap();
    assert_eq!(working["state"], "working");
    assert_eq!(
        tracker_result(&working)["page"],
        tracker_result(&first)["page"]
    );
    // Wait until the generation request has actually begun before testing late completion.
    let mut generating = false;
    for _ in 0..100 {
        generating = inbox
            .lock()
            .unwrap()
            .iter()
            .filter(|body| body["max_tokens"] == 4096)
            .count()
            == 3;
        if generating {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(generating);
    let stopped: Value = s
        .post_json_auth(
            &change,
            &owner,
            json!({"version":working["version"],"action":"stop"}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(stopped["state"], "failed");
    tokio::time::sleep(Duration::from_millis(550)).await;
    let after = settled(&s, &owner, id).await;
    assert_eq!(
        after["version"], stopped["version"],
        "a late completion must not overwrite Stop"
    );
    assert_eq!(
        tracker_result(&after)["page"],
        tracker_result(&first)["page"]
    );
    let selecting: Value = s.post_json_auth(&run, &owner, json!({"version":after["version"],"allow_generation":true,"instruction":"stop during selection"})).await.json().await.unwrap();
    assert_eq!(selecting["state"], "working");
    let mut selection_started = false;
    for _ in 0..100 {
        selection_started = inbox.lock().unwrap().len() == 7;
        if selection_started {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(selection_started);
    let stopped_selection: Value = s
        .post_json_auth(
            &change,
            &owner,
            json!({"version":selecting["version"],"action":"stop"}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(stopped_selection["state"], "failed");
    tokio::time::sleep(Duration::from_millis(550)).await;
    assert_eq!(
        settled(&s, &owner, id).await["version"],
        stopped_selection["version"]
    );
    let bodies = inbox.lock().unwrap();
    assert_eq!(
        bodies.len(),
        7,
        "three generation attempts and one stopped selection; Stop prevents the next call"
    );
    for body in bodies.iter() {
        assert!(body["max_tokens"] == 128 || body["max_tokens"] == 4096);
    }
    let context: Value =
        serde_json::from_str(bodies[3]["messages"][1]["content"].as_str().unwrap()).unwrap();
    assert_eq!(context["current_page"], tracker_result(&first)["page"]);
    assert_eq!(context["request"], "make it forest");
    assert_eq!(
        context.as_object().unwrap().len(),
        3,
        "only this request and page are shared"
    );
}

#[tokio::test]
async fn malformed_generated_pages_keep_the_last_safe_page_and_examples_need_no_service() {
    let (s, owner, offline, inbox) = configured().await;
    for example in ["quiz", "story", "page"] {
        let response = s
            .post_json_auth(
                "/api/v1/burrow/tasks",
                &offline,
                json!({"format":"creation","request":"Try an example","example":example}),
            )
            .await;
        assert_eq!(response.status(), 200);
        let task: Value = response.json().await.unwrap();
        assert_eq!(task["state"], "draft_ready");
        assert_eq!(tracker_result(&task)["example"], true);
    }
    assert!(inbox.lock().unwrap().is_empty());
    let mut task: Value = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            &owner,
            json!({"format":"creation","request":"Study page","example":"quiz"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let safe = tracker_result(&task)["page"].clone();
    let id = task["id"].as_str().unwrap().to_owned();
    for instruction in [
        "unsafe script",
        "unsafe event",
        "bad answer",
        "bad layout",
        "invalid skill",
    ] {
        assert_eq!(
            s.post_json_auth(
                &format!("/api/v1/burrow/tasks/{id}/run"),
                &owner,
                json!({"version":task["version"],"allow_generation":true,"instruction":instruction})
            )
            .await
            .status(),
            200
        );
        task = settled(&s, &owner, &id).await;
        assert_eq!(task["state"], "failed", "{instruction}");
        assert_eq!(tracker_result(&task)["page"], safe);
        assert_eq!(tracker_result(&task)["can_undo"], false);
    }
    assert_eq!(
        inbox.lock().unwrap().len(),
        9,
        "invalid skill cannot start generation or load an arbitrary file"
    );
}
