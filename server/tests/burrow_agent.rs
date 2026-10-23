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
            user: if pi.is_some() { "*" } else { "pilot" }.into(),
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
    let task: Value = r.json().await.unwrap();
    assert_eq!(task["coding"], false);
    task["id"].as_str().unwrap().to_owned()
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
async fn saved_coding_intent_survives_reload_without_granting_or_downgrading_approval() {
    let (s, owner, other, _home) = configured_runtime(Some(agent::Pi {
        endpoint: "http://127.0.0.1:1/command".into(),
        token: "f".repeat(32),
    }))
    .await;
    let draft =
        json!({"request":"Fix the repository tests when I approve a computer.","coding":true});
    for (field, value) in [
        ("kind", json!("tracker")),
        ("format", json!("creation")),
        ("template", json!("checklist")),
        ("comparison", json!(true)),
        ("travel", json!(true)),
        ("routine_id", json!("routine")),
    ] {
        let mut invalid = draft.clone();
        invalid[field] = value;
        assert_eq!(
            s.post_json_auth("/api/v1/burrow/tasks", &owner, invalid)
                .await
                .status(),
            400,
            "{field}"
        );
    }
    let response = s
        .post_json_auth("/api/v1/burrow/tasks", &owner, draft)
        .await;
    assert_eq!(response.status(), 200);
    let task: Value = response.json().await.unwrap();
    let id = task["id"].as_str().unwrap();
    assert_eq!(task["coding"], true);
    assert_eq!(task["kind"], "writing");
    assert_eq!(task["format"], "document");
    assert_eq!(task["state"], "waiting");
    assert_eq!(task["comparison"], false);
    assert_eq!(task["travel"], false);
    assert_eq!(s.get_auth(&route(id), &owner).await.status(), 404);

    // A fresh pool and HTTP app retain intent, but recovery/tick find no approval.
    let mut reopened = server::build_state(server::db::connect(s.db_url()).await.unwrap());
    reopened.kikka = s.state.kikka.clone();
    burrow::recover(&reopened.db).await.unwrap();
    agent::recover(&reopened.db).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = server::build_app(reopened);
    let process = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    for (token, tasks) in [(&owner, json!([task])), (&other, json!([]))] {
        let response = s
            .client
            .get(format!("{base}/api/v1/burrow"))
            .bearer_auth(token)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let listed: Value = response.json().await.unwrap();
        assert_eq!(listed["tasks"], tasks);
        assert_eq!(listed["agent_task_ids"], json!([]));
    }
    let workspace: Value = s
        .post_json_auth(
            "/api/v1/burrow/computer-workspaces",
            &owner,
            json!({"name":"Repository"}),
        )
        .await
        .json()
        .await
        .unwrap();
    let mut approval = json!({"version":0,"allow_agent":true,"max_cost_cents":37,"computer_workspace":workspace["id"]});
    // Both omitted and explicit false must fail before any run/attempt is recorded.
    for coding in [None, Some(false)] {
        if let Some(coding) = coding {
            approval["coding"] = json!(coding);
        }
        let response = s
            .client
            .post(format!("{base}{}", route(id)))
            .bearer_auth(&owner)
            .json(&approval)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 409);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_agent_runs")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_attempts")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
    approval["coding"] = json!(true);
    approval["allow_agent"] = json!(false);
    assert_eq!(
        s.post_json_auth(&route(id), &owner, approval.clone())
            .await
            .status(),
        400
    );
    approval["allow_agent"] = json!(true);
    let response = s.post_json_auth(&route(id), &owner, approval).await;
    assert_eq!(response.status(), 200);
    let run: Value = response.json().await.unwrap();
    assert_eq!(run["coding"], true);
    assert_eq!(run["phase"], "queued");
    assert_eq!(run["runtime_id"], Value::Null);
    assert_eq!(view(&s, &owner, id).await["task"]["coding"], true);
    process.abort();
}

#[tokio::test]
async fn coding_admission_is_explicit_owned_immutable_and_forwarded_after_recovery() {
    use axum::{extract::State, http::HeaderMap, routing::post, Json, Router};
    let journal = Arc::new(tokio::sync::Mutex::new(
        json!({"starts":0,"commands":[],"state":"Running"}),
    ));
    async fn worker(
        State(journal): State<Arc<tokio::sync::Mutex<Value>>>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        assert_eq!(
            headers["authorization"],
            format!("Bearer {}", "f".repeat(32))
        );
        let mut j = journal.lock().await;
        Json(match body["operation"].as_str().unwrap() {
            "start" => {
                j["admission"] = body["admission"].clone();
                j["starts"] = json!(j["starts"].as_i64().unwrap() + 1);
                json!("run-coding-fixture")
            }
            "status" => {
                json!({"run":"run-coding-fixture","root_goal_id":j["admission"]["root_goal"],"orb":"pi","state":j["state"]})
            }
            "watch" => json!([]),
            "control" => {
                assert_eq!(body["run"], "run-coding-fixture");
                assert_eq!(body["command"]["action"], "stop");
                j["commands"]
                    .as_array_mut()
                    .unwrap()
                    .push(body["command"].clone());
                j["state"] = json!("Cancelled");
                json!({"acknowledged":true})
            }
            _ => panic!("unsupported coding operation"),
        })
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/command", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/command", post(worker))
        .with_state(journal.clone());
    let process = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let (s, owner, other, _home) = configured_runtime(Some(agent::Pi {
        endpoint,
        token: "f".repeat(32),
    }))
    .await;
    let mut workspaces = Vec::new();
    let scopes_path = "/api/v1/burrow/computer-workspaces";
    assert_eq!(s.get(scopes_path).await.status(), 401);
    assert_eq!(
        s.get_auth(scopes_path, &owner)
            .await
            .json::<Value>()
            .await
            .unwrap(),
        json!([])
    );
    for (token, name) in [
        (&owner, "Zeta repository"),
        (&owner, "Alpha repository"),
        (&other, "Private repository"),
    ] {
        let response = s
            .post_json_auth(scopes_path, token, json!({"name":name}))
            .await;
        assert_eq!(response.status(), 200);
        workspaces.push(response.json::<Value>().await.unwrap()["id"].clone());
    }
    // Only names and IDs: a saved scope is not a provisioning/readiness claim.
    for _ in 0..2 {
        let response = s.get_auth(scopes_path, &owner).await;
        assert_eq!(response.status(), 200);
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!([
                {"id":workspaces[1],"name":"Alpha repository"},
                {"id":workspaces[0],"name":"Zeta repository"}
            ])
        );
    }
    assert_eq!(
        s.get_auth(scopes_path, &other)
            .await
            .json::<Value>()
            .await
            .unwrap(),
        json!([
            {"id":workspaces[2],"name":"Private repository"}
        ])
    );
    let goal = "Fix the failing test in the operator-provisioned repository.";
    let id = create(&s, &owner, goal).await;
    let approval = json!({"version":0,"allow_agent":true,"max_cost_cents":37,"coding":true,"computer_workspace":workspaces[0]});
    assert_eq!(
        s.post_json_auth(&route(&id), &other, approval.clone())
            .await
            .status(),
        404
    );
    for (field, value, status) in [
        ("computer_workspace", Value::Null, 400),
        ("computer_workspace", json!("missing-workspace"), 404),
        ("computer_workspace", workspaces[2].clone(), 404),
        ("allow_agent", json!(false), 400),
        ("max_cost_cents", json!(-1), 400),
        ("max_cost_cents", json!(0), 400),
        ("max_cost_cents", json!(51), 400),
        ("coding", json!("true"), 422),
        (
            "requirements",
            json!({"revision":1,"text":"Research instead"}),
            422,
        ),
        (
            "repository_url",
            json!("https://example.com/repository.git"),
            422,
        ),
    ] {
        let mut invalid = approval.clone();
        invalid[field] = value;
        assert_eq!(
            s.post_json_auth(&route(&id), &owner, invalid)
                .await
                .status(),
            status,
            "{field}"
        );
    }
    assert_eq!(s.get_auth(&route(&id), &owner).await.status(), 404);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_attempts")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
    let response = s
        .post_json_auth(&route(&id), &owner, approval.clone())
        .await;
    assert_eq!(response.status(), 200);
    let run: Value = response.json().await.unwrap();
    assert_eq!(run["coding"], true);
    assert_eq!(run["role"], "general");
    assert_eq!(run["requirements"], Value::Null);
    assert_eq!(run["computer_workspace"], workspaces[0]);
    assert_eq!(run["phase"], "queued");
    assert_eq!(
        journal.lock().await["starts"],
        0,
        "admission only queues work"
    );
    let retry: Value = s
        .post_json_auth(&route(&id), &owner, approval.clone())
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(retry, run);
    for (field, value) in [
        ("coding", json!(false)),
        ("computer_workspace", workspaces[1].clone()),
        ("role", json!("research")),
        ("max_cost_cents", json!(38)),
    ] {
        let mut changed = approval.clone();
        // Hold the role constant so changing coding alone tests its approval term.
        changed["role"] = json!("general");
        changed[field] = value;
        assert_eq!(
            s.post_json_auth(&route(&id), &owner, changed)
                .await
                .status(),
            409,
            "{field}"
        );
    }
    let mut omitted = approval.clone();
    omitted.as_object_mut().unwrap().remove("coding");
    omitted["role"] = json!("general");
    assert_eq!(
        s.post_json_auth(&route(&id), &owner, omitted)
            .await
            .status(),
        409
    );

    // A later task edit must not widen the saved approval goal on dispatch.
    sqlx::query("UPDATE burrow_tasks SET request='Changed after approval' WHERE id=?")
        .bind(&id)
        .execute(&s.state.db)
        .await
        .unwrap();
    let mut reopened = server::build_state(server::db::connect(s.db_url()).await.unwrap());
    reopened.kikka = s.state.kikka.clone();
    burrow::recover(&reopened.db).await.unwrap();
    agent::recover(&reopened.db).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    {
        let j = journal.lock().await;
        let admission = &j["admission"];
        assert_eq!(admission["coding"], true);
        assert_eq!(admission["role"], "general");
        assert_eq!(admission["owner"], "pilot");
        assert_eq!(admission["task"], id);
        assert_eq!(
            admission["root_goal"],
            format!("burrow-{}", run["id"].as_str().unwrap())
        );
        assert_eq!(admission["goal"], goal);
        assert_eq!(admission["max_cost_cents"], 37);
        assert_eq!(admission["computer_workspace"], workspaces[0]);
        assert_eq!(admission["comparison"], false);
        for key in ["requirements", "routine", "travel", "repository_url"] {
            assert!(admission.get(key).is_none(), "unexpected {key}");
        }
    }
    agent::recover(&reopened.db).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    let attached = view(&s, &owner, &id).await;
    assert_eq!(attached["agent"]["coding"], true);
    assert_eq!(attached["agent"]["runtime_id"], "run-coding-fixture");
    assert_eq!(s.post_json_auth(&format!("{}/control", route(&id)), &owner, json!({"version":attached["task"]["version"],"request_id":"coding-stop","action":"stop"})).await.status(), 200);
    agent::tick(&reopened).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    let stopped = view(&s, &owner, &id).await;
    assert_eq!(stopped["agent"]["phase"], "finished");
    assert_eq!(stopped["commands"][0][3], "sent");
    assert_eq!(
        journal.lock().await["commands"].as_array().unwrap().len(),
        1
    );
    assert_eq!(journal.lock().await["starts"], 1);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_attempts")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        1
    );

    // Workspace selection alone retains research mode; it never opts into coding.
    let research = create(&s, &owner, "Read the supplied notes.").await;
    let legacy = json!({"version":0,"allow_agent":true,"max_cost_cents":37,"computer_workspace":workspaces[0]});
    let response = s
        .post_json_auth(&route(&research), &owner, legacy.clone())
        .await;
    assert_eq!(response.status(), 200);
    let legacy_run: Value = response.json().await.unwrap();
    assert_eq!(legacy_run["coding"], false);
    assert_eq!(legacy_run["role"], "research");
    let mut changed = legacy;
    changed["coding"] = json!(true);
    changed["role"] = json!("research");
    assert_eq!(
        s.post_json_auth(&route(&research), &owner, changed)
            .await
            .status(),
        409
    );
    process.abort();
}

#[tokio::test]
async fn coding_rejects_cli_and_incompatible_task_modes_without_admission() {
    let (cli, owner, _, home) = configured().await;
    let id = create(&cli, &owner, "Edit the repository.").await;
    let workspace: Value = cli
        .post_json_auth(
            "/api/v1/burrow/computer-workspaces",
            &owner,
            json!({"name":"Repository"}),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(cli.post_json_auth(&route(&id), &owner, json!({"version":0,"allow_agent":true,"max_cost_cents":37,"coding":true,"computer_workspace":workspace["id"]})).await.status(), 400);
    agent::tick(&cli.state).await.unwrap();
    assert!(!home.0.join("runtime.json").exists());
    assert_eq!(cli.get_auth(&route(&id), &owner).await.status(), 404);

    let (s, owner, _, _home) = configured_runtime(Some(agent::Pi {
        endpoint: "http://127.0.0.1:1/command".into(),
        token: "f".repeat(32),
    }))
    .await;
    let workspace: Value = s
        .post_json_auth(
            "/api/v1/burrow/computer-workspaces",
            &owner,
            json!({"name":"Repository"}),
        )
        .await
        .json()
        .await
        .unwrap();
    for mode in [
        "comparison",
        "travel",
        "routine_id",
        "routine_version",
        "creation",
        "tracker",
    ] {
        let mut task = json!({"request":"A separate request"});
        match mode {
            "comparison" => task["comparison"] = json!(true),
            "creation" => task["format"] = json!("creation"),
            "tracker" => task["kind"] = json!("tracker"),
            _ => {}
        }
        let response = s.post_json_auth("/api/v1/burrow/tasks", &owner, task).await;
        assert_eq!(response.status(), 200);
        let task: Value = response.json().await.unwrap();
        let id = task["id"].as_str().unwrap();
        // Seed independent legacy flags to prove none rely on comparison=true.
        match mode {
            "travel" => {
                sqlx::query("UPDATE burrow_tasks SET travel=1 WHERE id=?")
                    .bind(id)
                    .execute(&s.state.db)
                    .await
                    .unwrap();
            }
            "routine_id" => {
                sqlx::query("UPDATE burrow_tasks SET routine_id='legacy-routine' WHERE id=?")
                    .bind(id)
                    .execute(&s.state.db)
                    .await
                    .unwrap();
            }
            "routine_version" => {
                sqlx::query("UPDATE burrow_tasks SET routine_version=1 WHERE id=?")
                    .bind(id)
                    .execute(&s.state.db)
                    .await
                    .unwrap();
            }
            _ => {}
        }
        if mode == "comparison" {
            assert_eq!(s.post_json_auth(&format!("/api/v1/burrow/tasks/{id}/research"), &owner, json!({"version":0,"action":"brief","text":"Saved research requirements","purchase_budget":"GBP 900"})).await.status(), 200);
        }
        let response = s.post_json_auth(&route(id), &owner, json!({"version":0,"allow_agent":true,"max_cost_cents":37,"coding":true,"computer_workspace":workspace["id"]})).await;
        assert_eq!(response.status(), 400, "{mode}");
        assert_eq!(s.get_auth(&route(id), &owner).await.status(), 404);
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_attempts")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_agent_runs")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
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

#[tokio::test]
async fn research_workspace_public_api_preserves_revisions_identity_decisions_and_owner_scope() {
    use axum::{extract::State, routing::post, Json, Router};
    let journal = Arc::new(tokio::sync::Mutex::new(
        json!({"starts":0,"commands":[],"state":"Running","events":[]}),
    ));
    async fn worker(
        State(journal): State<Arc<tokio::sync::Mutex<Value>>>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        let mut j = journal.lock().await;
        Json(match body["operation"].as_str().unwrap() {
            "start" => {
                j["starts"] = json!(j["starts"].as_i64().unwrap() + 1);
                j["admission"] = body["admission"].clone();
                json!("run-research")
            }
            "status" => {
                json!({"run":"run-research","root_goal_id":j["admission"]["root_goal"],"orb":"pi","state":j["state"]})
            }
            "watch" => j["events"].clone(),
            "control" => {
                j["commands"]
                    .as_array_mut()
                    .unwrap()
                    .push(body["command"].clone());
                j["state"] = json!("Running");
                json!({"acknowledged":true})
            }
            _ => panic!("No model, research or purchasing calls allowed"),
        })
    }
    async fn read(s: &TestServer, owner: &str, path: &str) -> Value {
        let response = s.get_auth(path, owner).await;
        assert_eq!(response.status(), 200);
        response.json().await.unwrap()
    }
    async fn save(s: &TestServer, owner: &str, path: &str, w: &Value, mut action: Value) -> Value {
        action["version"] = w["version"].clone();
        let response = s.post_json_auth(path, owner, action).await;
        let status = response.status();
        let text = response.text().await.unwrap();
        assert_eq!(status, 200, "{text}");
        serde_json::from_str(&text).unwrap()
    }
    fn option(name: &str) -> Value {
        json!({"name":name,"sources":[{"url":format!("https://example.com/{name}"),"evidence_id":"e-fixture","captured_at":"2026-10-23T00:00:00Z","limitations":[]}],"unknowns":["Battery life"],"attributes":[{"label":"Display","value":"14","quote":"14 inches","source_url":format!("https://example.com/{name}"),"evidence_id":"e-fixture","captured_at":"2026-10-23T00:00:00Z"}],"price":null,"annualized_monthly":null})
    }
    fn event(seq: i64, revision: Option<i64>, names: &[&str], text: &str) -> Value {
        json!({"seq":seq,"type":"final_message","data":{"requirements_revision":revision,"content":text,"comparison":{"title":text,"requirements":["Laptop"],"options":names.iter().map(|n| option(n)).collect::<Vec<_>>()}}})
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
    let created: Value = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            &owner,
            json!({"request":"Laptop for light gaming", "comparison":true}),
        )
        .await
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    let path = format!("/api/v1/burrow/tasks/{id}/research");
    let controls = format!("{}/control", route(id));
    let mut w = read(&s, &owner, &path).await;
    assert_eq!(w["version"], 0);
    assert_eq!(w["brief"]["revision"], 1);
    assert_eq!(journal.lock().await["starts"], 0);
    assert_eq!(s.get_auth(&route(id), &owner).await.status(), 404);
    assert_eq!(s.get_auth(&path, &other).await.status(), 404);
    let brief = json!({"action":"brief","text":"Laptop, light gaming","purchase_budget":"GBP 900"});
    assert_eq!(
        s.post_json_auth(
            &path,
            &other,
            json!({"version":0,"action":"brief","text":"Steal","purchase_budget":""})
        )
        .await
        .status(),
        404
    );
    w = save(&s, &owner, &path, &w, brief).await;
    assert_eq!(
        s.post_json_auth(
            &path,
            &owner,
            json!({"version":0,"action":"brief","text":"Stale tab","purchase_budget":""})
        )
        .await
        .status(),
        409
    );
    assert_eq!(s.post_json_auth(&path, &owner, json!({"version":w["version"],"action":"brief","text":"x".repeat(6001),"purchase_budget":""})).await.status(), 400);
    start(&s, &owner, id).await;
    w = save(
        &s,
        &owner,
        &path,
        &w,
        json!({"action":"brief","text":"Battery life matters most","purchase_budget":"GBP 900"}),
    )
    .await;
    assert_eq!(w["brief"]["revision"], 3);
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        journal.lock().await["admission"]["requirements"]["revision"],
        2
    );
    assert_eq!(
        journal.lock().await["admission"]["requirements"]["text"],
        "Laptop, light gaming"
    );
    assert_eq!(journal.lock().await["admission"]["max_cost_cents"], 37);
    let running = view(&s, &owner, id).await;
    assert_eq!(s.post_json_auth(&controls, &owner, json!({"version":running["task"]["version"],"request_id":"too-early","action":"continue","message":"Update","allow_spending":true,"requirements_revision":3})).await.status(), 409);
    assert!(journal.lock().await["commands"]
        .as_array()
        .unwrap()
        .is_empty());
    {
        let mut j = journal.lock().await;
        j["events"] = json!([event(1, Some(2), &["A", "B"], "Original")]);
        j["state"] = json!("Completed");
    }
    agent::tick(&s.state).await.unwrap();
    w = read(&s, &owner, &path).await;
    let original = w["comparisons"][0].clone();
    let a = original["comparison"]["options"][0]["id"].clone();
    let b = original["comparison"]["options"][1]["id"].clone();
    assert_eq!(original["requirements_revision"], 2);
    assert_eq!(
        original["comparison"]["options"][0]["attributes"],
        option("A")["attributes"]
    );
    w = save(
        &s,
        &owner,
        &path,
        &w,
        json!({"action":"candidate","candidate_id":a,"note":"My personal note","shortlisted":true}),
    )
    .await;
    w = save(&s, &owner, &path, &w, json!({"action":"candidate","candidate_id":b,"note":"Keep even if removed","shortlisted":true})).await;
    w = save(&s, &owner, &path, &w, json!({"action":"contribution","label":"Check weight","answer":"I can carry 1.5kg","done":true})).await;
    let contribution = w["contributions"][0].clone();
    assert!(contribution["id"].is_string());
    w = save(&s, &owner, &path, &w, json!({"action":"decision","candidate_id":a,"comparison_id":original["id"],"rationale":"Fits","tradeoffs":"Weight","uncertainties":"Battery life"})).await;
    let decision = w["decisions"][0].clone();
    assert_eq!(decision["requirements_revision"], 2);
    assert_eq!(s.post_json_auth(&path, &owner, json!({"version":w["version"],"action":"decision","candidate_id":"not-a-member","comparison_id":original["id"],"rationale":"","tradeoffs":"","uncertainties":""})).await.status(), 409);
    let first = view(&s, &owner, id).await;
    let command = json!({"version":first["task"]["version"],"request_id":"revision-three","action":"continue","message":"Update research","allow_spending":true,"requirements_revision":3});
    assert_eq!(
        s.post_json_auth(&controls, &other, command.clone())
            .await
            .status(),
        404
    );
    assert_eq!(
        s.post_json_auth(&controls, &owner, command.clone())
            .await
            .status(),
        200
    );
    w = save(
        &s,
        &owner,
        &path,
        &w,
        json!({"action":"brief","text":"Battery and portability","purchase_budget":"GBP 850"}),
    )
    .await;
    assert_eq!(w["brief"]["revision"], 4);
    // Retry is the same immutable command even after another brief was saved.
    assert_eq!(
        s.post_json_auth(&controls, &owner, command).await.status(),
        200
    );
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        journal.lock().await["commands"][0]["requirements"]["revision"],
        3
    );
    assert_eq!(
        journal.lock().await["commands"][0]["requirements"]["text"],
        "Battery life matters most"
    );
    journal.lock().await["events"]
        .as_array_mut()
        .unwrap()
        .push(event(2, Some(3), &["B", "A", "C"], "Newer"));
    agent::tick(&s.state).await.unwrap();
    {
        let mut j = journal.lock().await;
        j["events"]
            .as_array_mut()
            .unwrap()
            .push(event(3, Some(2), &["A", "B"], "Late old answer"));
        j["state"] = json!("Completed");
    }
    agent::tick(&s.state).await.unwrap();
    assert_eq!(view(&s, &owner, id).await["task"]["result"], "Newer");
    w = read(&s, &owner, &path).await;
    assert_eq!(w["comparisons"][1]["comparison"]["options"][0]["id"], b);
    assert_eq!(w["comparisons"][1]["comparison"]["options"][1]["id"], a);
    assert_eq!(w["candidates"].as_array().unwrap().len(), 3);
    assert_eq!(w["comparisons"][0], original);
    let next = view(&s, &owner, id).await;
    assert_eq!(s.post_json_auth(&controls, &owner, json!({"version":next["task"]["version"],"request_id":"revision-four","action":"continue","message":"Update","allow_spending":true,"requirements_revision":4})).await.status(), 200);
    agent::tick(&s.state).await.unwrap();
    {
        let mut j = journal.lock().await;
        j["events"].as_array_mut().unwrap().push(event(
            4,
            Some(4),
            &["A", "A", "C"],
            "Ambiguous names, removed B",
        ));
        // Later unattributed legacy output must not promote over revision four.
        let mut legacy = event(5, None, &["C"], "Legacy late answer");
        legacy["data"]
            .as_object_mut()
            .unwrap()
            .remove("requirements_revision");
        j["events"].as_array_mut().unwrap().push(legacy);
        j["events"].as_array_mut().unwrap().push(event(
            6,
            None,
            &["A"],
            "Previously ambiguous option",
        ));
        let mut changed_source = event(
            7,
            Some(999),
            &["C"],
            "Unadmitted revision with different source",
        );
        changed_source["data"]["comparison"]["options"][0]["sources"][0]["url"] =
            json!("https://example.com/different");
        j["events"].as_array_mut().unwrap().push(changed_source);
        for seq in 8..=110 {
            j["events"]
                .as_array_mut()
                .unwrap()
                .push(json!({"seq":seq,"type":"activity","data":{"content":"Progress"}}));
        }
        j["state"] = json!("Completed");
    }
    agent::tick(&s.state).await.unwrap();
    w = read(&s, &owner, &path).await;
    let ambiguous = &w["comparisons"][3]["comparison"]["options"];
    assert_ne!(ambiguous[0]["id"], a);
    assert_ne!(ambiguous[1]["id"], a);
    assert_ne!(ambiguous[0]["id"], ambiguous[1]["id"]);
    let after_ambiguity = &w["comparisons"][5]["comparison"]["options"][0]["id"];
    assert_ne!(after_ambiguity, &a);
    assert_ne!(after_ambiguity, &ambiguous[0]["id"]);
    assert_ne!(after_ambiguity, &ambiguous[1]["id"]);
    assert_ne!(
        w["comparisons"][6]["comparison"]["options"][0]["id"],
        w["comparisons"][1]["comparison"]["options"][2]["id"]
    );
    assert_eq!(w["comparisons"][6]["requirements_revision"], Value::Null);
    assert_eq!(w["comparisons"][4]["requirements_revision"], Value::Null);
    assert_eq!(w["comparisons"][0], original);
    assert_eq!(w["decisions"][0], decision);
    assert_eq!(w["contributions"][0], contribution);
    assert_eq!(w["candidates"][0]["note"], "My personal note");
    assert_eq!(w["candidates"][1]["shortlisted"], true);
    let final_view = view(&s, &owner, id).await;
    assert_eq!(final_view["task"]["result"], "Ambiguous names, removed B");
    assert_eq!(final_view["events"].as_array().unwrap().len(), 100);
    assert!(final_view["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|e| e["type"] != "final_message"));
    // Even disposing the event cache and editing the document cannot lose work.
    sqlx::query("DELETE FROM burrow_agent_events WHERE run_id=?")
        .bind(final_view["agent"]["id"].as_str())
        .execute(&s.state.db)
        .await
        .unwrap();
    assert_eq!(s.patch_json_auth(&format!("/api/v1/burrow/tasks/{id}/result"), &owner, json!({"version":final_view["task"]["version"],"result":"Independent presentation edit"})).await.status(), 200);
    assert_eq!(read(&s, &owner, &path).await, w);
    // Rebuild app state on a new pool, then use the production recovery path.
    let mut reopened = server::build_state(server::db::connect(s.db_url()).await.unwrap());
    reopened.kikka = s.state.kikka.clone();
    burrow::recover(&reopened.db).await.unwrap();
    agent::recover(&reopened.db).await.unwrap();
    agent::tick(&reopened).await.unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = server::build_app(reopened);
    let reopened_process = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let after: Value = s
        .client
        .get(format!("{base}{path}"))
        .bearer_auth(&owner)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(after, w);
    assert_eq!(read(&s, &owner, &path).await, w);
    assert_eq!(journal.lock().await["starts"], 1);
    assert_eq!(view(&s, &owner, id).await["agent"]["max_cost_cents"], 37);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_agent_runs WHERE task_id=?")
            .bind(id)
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        s.post_json_auth(
            &route(id),
            &owner,
            json!({"version":final_view["task"]["version"],"allow_agent":true,"max_cost_cents":37})
        )
        .await
        .status(),
        409
    );
    reopened_process.abort();
    process.abort();
}

#[tokio::test]
async fn legacy_research_import_is_unattributed_and_contributions_are_versioned_without_execution()
{
    let (s, owner, other, home) = configured().await;
    let id = create(&s, &owner, "Legacy laptop research").await;
    let run = start(&s, &owner, &id).await;
    // Fixture representing a pre-workspace completed run and its full journal.
    sqlx::query("UPDATE burrow_agent_runs SET phase='finished' WHERE id=?")
        .bind(run["id"].as_str())
        .execute(&s.state.db)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE burrow_tasks SET state='draft_ready',result='Unrelated presentation' WHERE id=?",
    )
    .bind(&id)
    .execute(&s.state.db)
    .await
    .unwrap();
    let comparison = json!({"title":"Legacy","requirements":[],"options":[{"name":"Old option","sources":[{"url":"https://example.com/old","captured_at":"2026-10-01T00:00:00Z","evidence_id":"e-fixture","limitations":[]}],"unknowns":["Price"],"attributes":[],"price":null,"annualized_monthly":null}]});
    for seq in 1..=105 {
        let event = if seq == 1 {
            json!({"seq":seq,"type":"final_message","data":{"content":"Old comparison","comparison":comparison}})
        } else {
            json!({"seq":seq,"type":"activity","data":{"content":"Progress"}})
        };
        sqlx::query("INSERT INTO burrow_agent_events(run_id,seq,event) VALUES(?,?,?)")
            .bind(run["id"].as_str())
            .bind(seq)
            .bind(event.to_string())
            .execute(&s.state.db)
            .await
            .unwrap();
    }
    let path = format!("/api/v1/burrow/tasks/{id}/research");
    assert_eq!(s.get_auth(&path, &other).await.status(), 404);
    let mut w: Value = s.get_auth(&path, &owner).await.json().await.unwrap();
    assert_eq!(w["comparisons"].as_array().unwrap().len(), 1);
    assert_eq!(w["comparisons"][0]["requirements_revision"], Value::Null);
    assert_eq!(
        w["comparisons"][0]["comparison"]["options"][0]["unknowns"],
        json!(["Price"])
    );
    assert_eq!(
        s.get_auth(&path, &owner)
            .await
            .json::<Value>()
            .await
            .unwrap(),
        w
    );
    let response = s.post_json_auth(&path, &owner, json!({"version":w["version"],"action":"contribution","label":"Ask family","answer":"Pending","done":false})).await;
    assert_eq!(response.status(), 200);
    w = response.json().await.unwrap();
    let contribution_id = w["contributions"][0]["id"].clone();
    assert_eq!(s.post_json_auth(&path, &owner, json!({"version":w["version"],"action":"contribution","id":"client-invented","label":"Bad","answer":"","done":false})).await.status(), 409);
    let response = s.post_json_auth(&path, &owner, json!({"version":w["version"],"action":"contribution","id":contribution_id,"label":"Ask family","answer":"They agree","done":true})).await;
    assert_eq!(response.status(), 200);
    w = response.json().await.unwrap();
    assert_eq!(w["contributions"].as_array().unwrap().len(), 1);
    assert_eq!(w["contributions"][0]["id"], contribution_id);
    assert_eq!(w["contributions"][0]["answer"], "They agree");
    assert_eq!(w["contributions"][0]["done"], true);
    let changes: i64 =
        sqlx::query_scalar("SELECT count(*) FROM burrow_research_changes WHERE task_id=?")
            .bind(&id)
            .fetch_one(&s.state.db)
            .await
            .unwrap();
    assert_eq!(changes, 3);
    assert!(
        !home.0.join("runtime.json").exists(),
        "GET and workspace edits never dispatch work"
    );
}
