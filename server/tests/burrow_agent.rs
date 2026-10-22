//! Public API + durable worker tests with a scripted CLI, not live ImOrb qualification.
mod common;
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::{
    self,
    agent::{self, Kikka},
};
use std::{path::PathBuf, sync::Arc, time::Duration};

struct Home(PathBuf);
impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn configured() -> (TestServer, String, String, Home) {
    configured_runtime(None).await
}

async fn configured_runtime(pi: Option<agent::Pi>) -> (TestServer, String, String, Home) {
    let home = Home(std::env::temp_dir().join(format!("kikka-agent-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&home.0).unwrap();
    let s = TestServer::start_with(|state| {
        state.kikka = Some(Kikka {
            binary: PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/imorb-cli.py"),
            home: home.0.clone(),
            user: "pilot".into(),
            orb: if pi.is_some() { "pi" } else { "kikka-work" }.into(),
            model: "fixture".into(),
            verify: "test-command".into(),
            lock: Arc::default(),
            pi,
            routing: None,
        });
    })
    .await;
    let hash = server::auth::hash_password("test-password").unwrap();
    for id in ["pilot", "outsider"] {
        sqlx::query("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,0)")
            .bind(id).bind(id).bind(id).bind(&hash).execute(&s.state.db).await.unwrap();
    }
    let secret = server::auth::jwt_secret();
    let owner = server::auth::create_token("pilot", 0, &secret).unwrap();
    let other = server::auth::create_token("outsider", 0, &secret).unwrap();
    (s, owner, other, home)
}

async fn create(s: &TestServer, token: &str, request: &str) -> String {
    let r = s
        .post_json_auth("/api/v1/burrow/tasks", token, json!({"request":request}))
        .await;
    assert_eq!(r.status(), 200);
    r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn route(id: &str) -> String {
    format!("/api/v1/burrow/tasks/{id}/agent")
}
async fn view(s: &TestServer, token: &str, id: &str) -> Value {
    let r = s.get_auth(&route(id), token).await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}

async fn start(s: &TestServer, token: &str, id: &str) -> Value {
    let r = s
        .post_json_auth(
            &route(id),
            token,
            json!({"version":0,"allow_agent":true,"max_cost_cents":37}),
        )
        .await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}

fn runtime(home: &Home) -> Value {
    serde_json::from_slice(&std::fs::read(home.0.join("runtime.json")).unwrap()).unwrap()
}

#[tokio::test]
async fn pi_transport_reconciles_owner_scoped_results_history_evidence_and_stop_acknowledgement() {
    use axum::{
        extract::State, http::HeaderMap, response::IntoResponse, routing::post, Json, Router,
    };
    let journal = Arc::new(tokio::sync::Mutex::new(
        json!({"starts":0,"state":"Running","answer":"Monthly fixture","seq":2}),
    ));
    async fn worker(
        State(journal): State<Arc<tokio::sync::Mutex<Value>>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> axum::response::Response {
        assert_eq!(
            headers["authorization"],
            format!("Bearer {}", "f".repeat(32))
        );
        let mut j = journal.lock().await;
        match body["operation"].as_str().unwrap() {
            "start" => {
                assert_eq!(body["admission"]["owner"], "pilot");
                assert_eq!(body["admission"]["max_cost_cents"], 37);
                j["admission"] = body["admission"].clone();
                j["starts"] = json!(j["starts"].as_i64().unwrap()+1);
                Json(json!("run-pi-fixture")).into_response()
            },
            "status" => Json(json!({"run":"run-pi-fixture","root_goal_id":j["admission"]["root_goal"],"orb":"pi","state":j["state"],"usage":[{"role":"research","inputTokens":12,"outputTokens":3}],"activity":if j["state"]=="Cancelled" {"Stopped. Acknowledged."} else {"Reading an approved public page…"}})).into_response(),
            "watch" => {
                let mut events = vec![json!({"seq":1,"type":"evidence","data":{"id":format!("e-{}","a".repeat(64)),"url":"https://example.com/","capturedAt":"2026-10-20T00:00:00Z"}})];
                if j["state"]=="Completed" { events.push(json!({"seq":j["seq"],"type":"final_message","data":{"content":j["answer"]}})); }
                Json(json!(events)).into_response()
            },
            "control" => {
                j["state"] = json!(if body["command"]["action"]=="stop" {"Stopping"} else {"Running"});
                Json(json!({"acknowledged":true})).into_response()
            },
            "evidence" => ([("Content-Type","image/png")], b"fixture-png".to_vec()).into_response(),
            "computer" => {
                assert_eq!(body["owner"], "pilot");
                assert_eq!(body["run"], "run-pi-fixture");
                if body["action"] == "browser_control" {
                    return Json(json!({"phase":"human","session_id":"private-session","generation":1,"png":"private-frame-fixture"})).into_response();
                }
                Json(json!({"state":"ready","computer_id":"fixture-computer"})).into_response()
            },
            _ => panic!("unsupported operation"),
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/command", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/command", post(worker))
        .with_state(journal.clone());
    let process = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (s, owner, other, _home) = configured_runtime(Some(agent::Pi {
        endpoint,
        token: "f".repeat(32),
    }))
    .await;
    let id = create(&s, &owner, "Compare official public subscription plans.").await;
    let workspace: Value = s
        .post_json_auth(
            "/api/v1/burrow/computer-workspaces",
            &owner,
            json!({"name":"Research"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let workspace_id = workspace["id"].as_str().unwrap();
    let outsider_workspace: Value = s
        .post_json_auth(
            "/api/v1/burrow/computer-workspaces",
            &other,
            json!({"name":"Private"}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(s.post_json_auth(&route(&id), &owner, json!({"version":0,"allow_agent":true,"max_cost_cents":37,"computer_workspace":outsider_workspace["id"]})).await.status(), 404);
    let attached = json!({"version":0,"allow_agent":true,"max_cost_cents":37,"computer_workspace":workspace_id});
    assert_eq!(
        s.post_json_auth(&route(&id), &owner, attached.clone())
            .await
            .status(),
        200
    );
    assert_eq!(
        s.post_json_auth(&route(&id), &owner, attached)
            .await
            .status(),
        200
    );
    assert_eq!(
        s.post_json_auth(
            &route(&id),
            &owner,
            json!({"version":0,"allow_agent":true,"max_cost_cents":37})
        )
        .await
        .status(),
        409
    );
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        journal.lock().await["admission"]["computer_workspace"],
        workspace_id
    );
    let computer = format!("/api/v1/burrow/tasks/{id}/computer");
    assert_eq!(
        s.post_json_auth(
            &computer,
            &other,
            json!({"action":"status","request_id":"steal"})
        )
        .await
        .status(),
        404
    );
    let status = s
        .post_json_auth(
            &computer,
            &owner,
            json!({"action":"status","request_id":"inspect"}),
        )
        .await;
    assert_eq!(status.status(), 200);
    assert_eq!(status.json::<Value>().await.unwrap()["state"], "ready");
    let private = json!({"action":"browser_control","request_id":"frame-one","browser":{"action":"frame","session_id":"private-session"}});
    assert_eq!(
        s.post_json_auth(&computer, &other, private.clone())
            .await
            .status(),
        404
    );
    let frame = s.post_json_auth(&computer, &owner, private).await;
    assert_eq!(frame.status(), 200);
    assert_eq!(frame.headers()["cache-control"], "no-store");
    assert_eq!(
        frame.json::<Value>().await.unwrap()["png"],
        "private-frame-fixture"
    );
    assert_eq!(s.post_json_auth(&computer, &owner, json!({"action":"browser_control","request_id":"bad","browser":{"action":"arbitrary_eval"}})).await.status(), 400);
    let before = view(&s, &owner, &id).await;
    assert!(!before.to_string().contains("private-frame-fixture"));
    assert_eq!(before["task"]["state"], "working");
    assert_eq!(
        before["agent"]["usage"],
        json!([{"role":"research","inputTokens":12,"outputTokens":3}])
    );
    assert_eq!(
        create(&s, &owner, "An independent request.").await.len(),
        36
    );
    burrow::recover(&s.state.db).await.unwrap();
    agent::tick(&s.state).await.unwrap();
    assert_eq!(journal.lock().await["starts"], 1);
    let evidence = format!("{}/evidence/e-{}", route(&id), "a".repeat(64));
    assert_eq!(
        s.get_auth(&evidence, &owner)
            .await
            .bytes()
            .await
            .unwrap()
            .as_ref(),
        b"fixture-png"
    );
    assert_eq!(s.get_auth(&evidence, &other).await.status(), 404);
    assert_eq!(s.get_auth(&route(&id), &other).await.status(), 404);
    let controls = format!("{}/control", route(&id));
    assert_eq!(
        s.post_json_auth(
            &controls,
            &other,
            json!({"version":1,"request_id":"steal","action":"stop"})
        )
        .await
        .status(),
        404
    );
    let workspace: Value = s
        .get_auth("/api/v1/burrow", &other)
        .await
        .json()
        .await
        .unwrap();
    assert!(workspace["agent_task_ids"].as_array().unwrap().is_empty());
    journal.lock().await["state"] = json!("Completed");
    agent::tick(&s.state).await.unwrap();
    let first = view(&s, &owner, &id).await;
    assert_eq!(first["task"]["result"], "Monthly fixture");
    assert_eq!(s.post_json_auth(&controls,&owner,json!({"version":first["task"]["version"],"request_id":"revise","action":"continue","message":"Annual instead","allow_spending":true})).await.status(),200);
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        view(&s, &owner, &id).await["task"]["result"],
        "Monthly fixture"
    );
    {
        let mut j = journal.lock().await;
        j["state"] = json!("Completed");
        j["answer"] = json!("Annual fixture");
        j["seq"] = json!(3);
    }
    agent::tick(&s.state).await.unwrap();
    let revised = view(&s, &owner, &id).await;
    assert_eq!(revised["task"]["result"], "Annual fixture");
    assert_eq!(revised["history"][0][1], "Monthly fixture");
    let edited = s
        .client
        .patch(format!("{}/api/v1/burrow/tasks/{id}/result", s.base))
        .bearer_auth(&owner)
        .json(
            &json!({"version":revised["task"]["version"],"result":"My manually edited comparison"}),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(edited.status(), 200);
    let edited: Value = edited.json().await.unwrap();
    assert_eq!(s.post_json_auth(&controls,&owner,json!({"version":edited["version"],"request_id":"protect-edits","action":"continue","message":"Add order quantities","allow_spending":true})).await.status(),200);
    agent::tick(&s.state).await.unwrap();
    {
        let mut j = journal.lock().await;
        j["state"] = json!("Completed");
        j["answer"] = json!("Comparison with order quantities");
        j["seq"] = json!(4);
    }
    agent::tick(&s.state).await.unwrap();
    let proposed = view(&s, &owner, &id).await;
    assert_eq!(proposed["task"]["result"], "My manually edited comparison");
    assert_eq!(
        proposed["task"]["proposed_result"],
        "Comparison with order quantities"
    );
    let accepted = s
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/accept-revision"),
            &owner,
            json!({"version":proposed["task"]["version"]}),
        )
        .await;
    assert_eq!(accepted.status(), 200);
    let accepted: Value = accepted.json().await.unwrap();
    assert_eq!(accepted["result"], "Comparison with order quantities");
    assert_eq!(
        view(&s, &owner, &id).await["history"][0][1],
        "My manually edited comparison"
    );
    assert_eq!(s.post_json_auth(&controls,&owner,json!({"version":accepted["version"],"request_id":"more","action":"continue","message":"Check caveats","allow_spending":true})).await.status(),200);
    agent::tick(&s.state).await.unwrap();
    let working = view(&s, &owner, &id).await;
    assert_eq!(
        s.post_json_auth(
            &controls,
            &owner,
            json!({"version":working["task"]["version"],"request_id":"stop","action":"stop"})
        )
        .await
        .status(),
        200
    );
    agent::tick(&s.state).await.unwrap();
    agent::tick(&s.state).await.unwrap();
    assert_eq!(view(&s, &owner, &id).await["task"]["state"], "working");
    journal.lock().await["state"] = json!("Cancelled");
    agent::tick(&s.state).await.unwrap();
    let stopped = view(&s, &owner, &id).await;
    assert_eq!(stopped["agent"]["phase"], "finished");
    assert_eq!(
        stopped["task"]["result"],
        "Comparison with order quantities"
    );
    process.abort();
}

#[tokio::test]
async fn known_work_reattaches_after_restart_and_continues_the_same_result() {
    let (s, owner, other, home) = configured().await;
    let id = create(&s, &owner, "Compare supplied subscription quotes.").await;
    let denied = s
        .post_json_auth(
            &route(&id),
            &owner,
            json!({"version":0,"allow_agent":false,"max_cost_cents":37}),
        )
        .await;
    assert_eq!(denied.status(), 400);
    assert_eq!(
        s.post_json_auth(
            &route(&id),
            &other,
            json!({"version":0,"allow_agent":true,"max_cost_cents":37})
        )
        .await
        .status(),
        404
    );
    let first = start(&s, &owner, &id).await;
    let (a, b) = tokio::join!(start(&s, &owner, &id), start(&s, &owner, &id));
    assert_eq!(a["id"], first["id"]);
    assert_eq!(b["id"], first["id"]);
    agent::tick(&s.state).await.unwrap();
    let before = view(&s, &owner, &id).await;
    assert_eq!(before["task"]["state"], "working");
    assert_eq!(before["events"].as_array().unwrap().len(), 2);
    assert_eq!(s.get_auth(&route(&id), &other).await.status(), 404);
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/run"),
            &owner,
            json!({"allow_generation":true})
        )
        .await
        .status(),
        409
    );

    // Reopen the real SQLite file with fresh host state, as service startup does.
    let mut reopened = server::build_state(server::db::connect(s.db_url()).await.unwrap());
    reopened.kikka = s.state.kikka.clone();
    reopened.kikka.as_mut().unwrap().lock = Arc::default();
    burrow::recover(&reopened.db).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    let after = view(&s, &owner, &id).await;
    assert_eq!(after["agent"]["id"], before["agent"]["id"]);
    assert_eq!(after["agent"]["runtime_id"], before["agent"]["runtime_id"]);
    assert_eq!(
        after["events"], before["events"],
        "replayed journal entries are not duplicated"
    );
    assert_eq!(runtime(&home)["starts"], 1);

    let control = format!("{}/control", route(&id));
    let instruction = json!({"version":after["task"]["version"],"request_id":"annual-1","action":"steer","message":"annual"});
    assert_eq!(
        s.post_json_auth(&control, &owner, instruction.clone())
            .await
            .status(),
        200
    );
    assert_eq!(
        s.post_json_auth(&control, &owner, instruction)
            .await
            .status(),
        200
    );
    agent::tick(&reopened).await.unwrap();
    std::fs::write(home.0.join("finish"), "").unwrap();
    agent::tick(&reopened).await.unwrap();
    let finished = view(&s, &owner, &id).await;
    assert_eq!(finished["task"]["state"], "draft_ready");
    assert_eq!(
        finished["task"]["result"],
        "Annual comparison (fixture, not live prices)."
    );
    assert_eq!(finished["commands"].as_array().unwrap().len(), 1);
    assert_eq!(finished["commands"][0][3], "sent");
    let version = finished["task"]["version"].clone();
    assert_eq!(s.post_json_auth(&control,&owner,json!({"version":version,"request_id":"continue-1","action":"continue","message":"monthly"})).await.status(),409);
    assert_eq!(s.post_json_auth(&control,&owner,json!({"version":version,"request_id":"continue-1","action":"continue","message":"monthly","allow_spending":true})).await.status(),200);
    agent::tick(&reopened).await.unwrap();
    let continuing = view(&s, &owner, &id).await;
    assert_eq!(
        continuing["task"]["result"], finished["task"]["result"],
        "previous result stays usable while changing it"
    );
    std::fs::write(home.0.join("finish"), "").unwrap();
    agent::tick(&reopened).await.unwrap();
    let final_view = view(&s, &owner, &id).await;
    assert_eq!(
        final_view["task"]["result"],
        "Monthly comparison (fixture, not live prices)."
    );
    assert_eq!(
        final_view["agent"]["runtime_id"],
        before["agent"]["runtime_id"]
    );
    let data = runtime(&home);
    assert_eq!(data["starts"], 1);
    let r = data["runs"].as_object().unwrap().values().next().unwrap();
    assert_eq!(
        r["model_calls"], 2,
        "one original attempt and one approved continuation, no replay spending"
    );
    assert_eq!(
        r["limit"], "0.37",
        "continuation does not reset or increase the cumulative cap"
    );

    std::fs::remove_file(home.0.join("finish")).unwrap();
    let next = create(&s, &owner, "Another task.").await;
    start(&s, &owner, &next).await;
    agent::tick(&reopened).await.unwrap();
    for (request_id, action, message) in [
        ("change-next", "steer", "annual"),
        ("stop-next", "stop", ""),
    ] {
        let current = view(&s, &owner, &next).await;
        assert_eq!(s.post_json_auth(&format!("{}/control",route(&next)),&owner,json!({"version":current["task"]["version"],"request_id":request_id,"action":action,"message":message})).await.status(),200);
    }
    agent::tick(&reopened).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    let stopped = view(&s, &owner, &next).await;
    assert_eq!(stopped["agent"]["phase"], "finished");
    assert_eq!(stopped["task"]["state"], "failed");
    assert_eq!(
        stopped["commands"][0][3], "discarded",
        "Stop discards an instruction that hasn't been sent"
    );
    assert_eq!(stopped["commands"][1][3], "sent");
}

#[tokio::test]
async fn uncertain_admission_and_interrupted_control_are_not_replayed() {
    let (s, owner, _, home) = configured().await;
    let id = create(&s, &owner, "ambiguous-start").await;
    start(&s, &owner, &id).await;
    agent::tick(&s.state).await.unwrap();
    let uncertain = view(&s, &owner, &id).await;
    assert_eq!(uncertain["agent"]["phase"], "review");
    assert_eq!(uncertain["task"]["state"], "waiting");
    start(&s, &owner, &id).await;
    burrow::recover(&s.state.db).await.unwrap();
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        runtime(&home)["starts"],
        1,
        "unknown admission is never repeated"
    );
    assert_eq!(
        s.post_json_auth(
            &route(&id),
            &owner,
            json!({"version":uncertain["task"]["version"],"allow_agent":true,"max_cost_cents":37})
        )
        .await
        .status(),
        409
    );

    // A separate fixture host isolates the command-recovery case from the unknown run.
    let (s, owner, _, home) = configured().await;
    let id = create(&s, &owner, "ordinary request").await;
    start(&s, &owner, &id).await;
    agent::tick(&s.state).await.unwrap();
    let before = view(&s, &owner, &id).await;
    assert_eq!(s.post_json_auth(&format!("{}/control",route(&id)),&owner,json!({"version":before["task"]["version"],"request_id":"uncertain-1","action":"steer","message":"uncertain-instruction"})).await.status(),200);
    agent::tick(&s.state).await.unwrap();
    let lost = view(&s, &owner, &id).await;
    assert_eq!(lost["agent"]["phase"], "review");
    assert_eq!(lost["commands"][0][3], "review");
    burrow::recover(&s.state.db).await.unwrap();
    agent::tick(&s.state).await.unwrap();
    let data = runtime(&home);
    let r = data["runs"].as_object().unwrap().values().next().unwrap();
    assert_eq!(
        r["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["type"] == "steering_queued")
            .count(),
        1
    );
    assert_eq!(r["model_calls"], 1);
}

#[tokio::test]
async fn crash_during_submission_preserves_uncertainty_and_queued_tasks_can_stop() {
    let (s, owner, _, home) = configured().await;
    let id = create(&s, &owner, "crash-start").await;
    start(&s, &owner, &id).await;
    let state = s.state.clone();
    let worker = tokio::spawn(async move { agent::tick(&state).await });
    for _ in 0..200 {
        if home.0.join("start-entered").exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(home.0.join("start-entered").exists());
    worker.abort();
    assert!(worker.await.unwrap_err().is_cancelled());
    burrow::recover(&s.state.db).await.unwrap();
    agent::tick(&s.state).await.unwrap();
    let interrupted = view(&s, &owner, &id).await;
    assert_eq!(interrupted["agent"]["phase"], "review");
    assert_eq!(interrupted["task"]["state"], "waiting");
    assert_eq!(runtime(&home)["starts"], 1);
    let second = create(&s, &owner, "Another independent request.").await;
    start(&s, &owner, &second).await;
    agent::tick(&s.state).await.unwrap();
    let queued = view(&s, &owner, &second).await;
    assert_eq!(
        queued["agent"]["phase"], "queued",
        "one workspace is never shared by concurrent runs"
    );
    assert_eq!(
        s.post_json_auth(
            &format!("{}/control", route(&second)),
            &owner,
            json!({"version":queued["task"]["version"],"request_id":"stop-queued","action":"stop"})
        )
        .await
        .status(),
        200
    );
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        view(&s, &owner, &second).await["agent"]["phase"],
        "finished"
    );
    assert_eq!(runtime(&home)["starts"], 1);
    let deletion = s
        .client
        .delete(s.url("/api/v1/users/@me"))
        .bearer_auth(&owner)
        .json(&json!({"username":"pilot","password":"test-password"}))
        .send()
        .await
        .unwrap();
    assert_eq!(
        deletion.status(),
        409,
        "uncertain live work cannot be orphaned by account deletion"
    );
}

#[tokio::test]
async fn uncertain_model_call_requires_review_not_automatic_resume() {
    let (s, owner, _, home) = configured().await;
    let id = create(&s, &owner, "ordinary request").await;
    start(&s, &owner, &id).await;
    agent::tick(&s.state).await.unwrap();
    std::fs::write(home.0.join("lost-model"), "").unwrap();
    burrow::recover(&s.state.db).await.unwrap();
    agent::tick(&s.state).await.unwrap();
    let paused = view(&s, &owner, &id).await;
    assert_eq!(paused["task"]["state"], "waiting");
    agent::tick(&s.state).await.unwrap();
    assert_eq!(view(&s, &owner, &id).await["events"], paused["events"]);
    let response = s
        .post_json_auth(
            &format!("{}/control", route(&id)),
            &owner,
            json!({"version":paused["task"]["version"],"request_id":"resume-1","action":"resume"}),
        )
        .await;
    assert_eq!(response.status(), 200);
    agent::tick(&s.state).await.unwrap();
    assert_eq!(view(&s, &owner, &id).await["agent"]["phase"], "review");
    let data = runtime(&home);
    assert_eq!(data["starts"], 1);
    assert_eq!(
        data["runs"].as_object().unwrap().values().next().unwrap()["model_calls"],
        1
    );
}
