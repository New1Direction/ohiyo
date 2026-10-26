//! Real authenticated API + file-backed SQLite. No inference or shared state.
mod common;
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::{
    agent::{self, Kikka, Pi},
    specs,
};

async fn task(s: &TestServer, token: &str, project: &str) -> String {
    let r = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            token,
            json!({"request":"Review project intent","project":project}),
        )
        .await;
    assert_eq!(r.status(), 200);
    r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn read(s: &TestServer, token: &str, id: &str) -> Value {
    let r = s
        .get_auth(&format!("/api/v1/burrow/tasks/{id}/specs"), token)
        .await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}
async fn proposal(
    s: &TestServer,
    token: &str,
    id: &str,
    kind: &str,
    base: i64,
    content: &str,
) -> String {
    let r = s
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/proposals"),
            token,
            json!({"kind":kind,"base_revision":base,"content":content}),
        )
        .await;
    assert_eq!(r.status(), 200, "{}", r.text().await.unwrap_or_default());
    r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn decide(s: &TestServer, token: &str, id: &str, p: &str, action: &str) -> reqwest::Response {
    s.post_json_auth(
        &format!("/api/v1/burrow/tasks/{id}/proposals/{p}"),
        token,
        json!({"action":action}),
    )
    .await
}
fn status<'a>(v: &'a Value, id: &str) -> &'a str {
    v["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .unwrap()["status"]
        .as_str()
        .unwrap()
}

#[tokio::test]
async fn project_specs_persist_isolate_permissions_reject_stale_writes_and_rollback_atomically() {
    let s = TestServer::start().await;
    let owner = s.register("spec_owner", "test-password").await;
    let other = s.register("spec_other", "test-password").await;
    let a = task(&s, &owner.token, "Launch").await;
    let sibling = task(&s, &owner.token, "Launch").await;
    let b = task(&s, &owner.token, "Trip").await;
    let foreign = task(&s, &other.token, "Launch").await;
    assert_eq!(read(&s, &owner.token, &a).await["spec"]["revision"], 0);
    let p = proposal(
        &s,
        &owner.token,
        &a,
        "spec",
        0,
        "Private, optional AI. No automatic installs.",
    )
    .await;
    assert_eq!(
        read(&s, &owner.token, &sibling).await["spec"]["content"],
        ""
    );
    assert_eq!(
        s.get_auth(&format!("/api/v1/burrow/tasks/{a}/specs"), &other.token)
            .await
            .status(),
        404
    );
    assert_eq!(
        decide(&s, &other.token, &a, &p, "approve").await.status(),
        404
    );
    assert_eq!(
        decide(&s, &other.token, &foreign, &p, "approve")
            .await
            .status(),
        409
    );
    assert_eq!(
        decide(&s, &owner.token, &b, &p, "approve").await.status(),
        409
    );
    assert_eq!(
        decide(&s, &owner.token, &a, &p, "approve").await.status(),
        200
    );
    let q = proposal(
        &s,
        &owner.token,
        &a,
        "spec",
        1,
        "Retain Pi Durable; explicit approvals.",
    )
    .await;
    let stale = proposal(&s, &owner.token, &a, "spec", 1, "Stale replacement").await;
    assert_eq!(
        decide(&s, &owner.token, &a, &q, "approve").await.status(),
        200
    );
    assert_eq!(
        decide(&s, &owner.token, &a, &stale, "approve")
            .await
            .status(),
        409
    );
    assert_eq!(
        decide(&s, &owner.token, &a, &p, "rollback").await.status(),
        409,
        "cannot overwrite later work"
    );
    assert_eq!(
        decide(&s, &owner.token, &a, &q, "rollback").await.status(),
        200
    );
    let saved = read(&s, &owner.token, &sibling).await;
    assert_eq!(saved["spec"]["revision"], 3);
    assert_eq!(
        saved["spec"]["content"],
        "Private, optional AI. No automatic installs."
    );
    assert_eq!(saved["history"].as_array().unwrap().len(), 3);
    assert_eq!(read(&s, &owner.token, &b).await["spec"]["content"], "");
    assert_eq!(
        read(&s, &other.token, &foreign).await["proposals"],
        json!([])
    );
    // Fresh DB pool and app reconstruct the exact review surface, not a process cache.
    let state = server::build_state(server::db::connect(s.db_url()).await.unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = server::build_app(state.clone());
    let process = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let reloaded: Value = s
        .client
        .get(format!("{base}/api/v1/burrow/tasks/{a}/specs"))
        .bearer_auth(&owner.token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(reloaded, saved);
    let task: server::api::burrow::Task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=?")
        .bind(&a)
        .fetch_one(&state.db)
        .await
        .unwrap();
    let packet = server::api::burrow::context::prompt(&state, &owner.id, &task)
        .await
        .unwrap();
    assert!(packet.contains("Private, optional AI."));
    assert!(
        !packet.contains("Retain Pi Durable"),
        "rolled back text is not current context"
    );
    process.abort();
    assert_eq!(
        decide(
            &s,
            &owner.token,
            &b,
            &proposal(&s, &owner.token, &b, "spec", 0, "First").await,
            "approve"
        )
        .await
        .status(),
        200
    );
    let first = read(&s, &owner.token, &b).await["proposals"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        decide(&s, &owner.token, &b, &first, "rollback")
            .await
            .status(),
        200
    );
    assert_eq!(
        read(&s, &owner.token, &b).await["spec"],
        json!({"project":"Trip","revision":2,"content":""})
    );
}

#[tokio::test]
async fn skill_candidates_require_human_approval_never_install_or_retry_and_can_be_revoked() {
    let s = TestServer::start().await;
    let owner = s.register("skill_owner", "test-password").await;
    let a = task(&s, &owner.token, "Skills").await;
    let content=json!({"name":"Ground claims","description":"Cite evidence","instructions":"Report unknown facts honestly."}).to_string();
    let p = proposal(&s, &owner.token, &a, "skill", 0, &content).await;
    assert_eq!(decide(&s, &owner.token, &a, &p, "test").await.status(), 409);
    assert_eq!(
        decide(&s, &owner.token, &a, &p, "install").await.status(),
        409
    );
    assert_eq!(
        decide(&s, &owner.token, &a, &p, "approve").await.status(),
        200
    );
    assert_eq!(status(&read(&s, &owner.token, &a).await, &p), "approved");
    // Missing sandbox fails closed; no model, tool changes, or retry.
    assert_eq!(decide(&s, &owner.token, &a, &p, "test").await.status(), 200);
    assert_eq!(status(&read(&s, &owner.token, &a).await, &p), "test_failed");
    assert_eq!(decide(&s, &owner.token, &a, &p, "test").await.status(), 409);
    assert_eq!(
        decide(&s, &owner.token, &a, &p, "rollback").await.status(),
        200
    );
    assert_eq!(status(&read(&s, &owner.token, &a).await, &p), "rolled_back");
    assert_eq!(
        decide(&s, &owner.token, &a, &p, "approve").await.status(),
        409
    );
    let rejected = proposal(&s, &owner.token, &a, "skill", 0, &content).await;
    assert_eq!(
        decide(&s, &owner.token, &a, &rejected, "reject")
            .await
            .status(),
        200
    );
    assert_eq!(
        decide(&s, &owner.token, &a, &rejected, "test")
            .await
            .status(),
        409
    );
    for forbidden in [
        json!({"tools":["shell"]}),
        json!({"scripts":["evil.js"]}),
        json!({"install":"package"}),
    ] {
        let mut skill: Value = serde_json::from_str(&content).unwrap();
        skill
            .as_object_mut()
            .unwrap()
            .extend(forbidden.as_object().unwrap().clone());
        assert_eq!(
            s.post_json_auth(
                &format!("/api/v1/burrow/tasks/{a}/proposals"),
                &owner.token,
                json!({"kind":"skill","base_revision":0,"content":skill.to_string()})
            )
            .await
            .status(),
            400
        );
    }
    assert_eq!(read(&s, &owner.token, &a).await["spec"]["revision"], 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_agent_runs")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn agent_proposal_admission_is_explicit_immutable_and_event_replay_never_approves() {
    let s = TestServer::start_with(|state| {
        state.kikka = Some(Kikka {
            binary: Default::default(),
            home: Default::default(),
            user: "*".into(),
            orb: "pi".into(),
            model: "fixture".into(),
            verify: String::new(),
            lock: Default::default(),
            routing: None,
            pi: Some(Pi {
                endpoint: "http://127.0.0.1:1/command".into(),
                token: "f".repeat(32),
            }),
        })
    })
    .await;
    let owner = s.register("proposal_owner", "test-password").await;
    let a = task(&s, &owner.token, "Intent").await;
    let start =
        json!({"version":0,"allow_agent":true,"max_cost_cents":10,"allow_project_knowledge":true});
    let r = s
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{a}/agent"),
            &owner.token,
            start.clone(),
        )
        .await;
    assert_eq!(r.status(), 200);
    let admitted: Value = r.json().await.unwrap();
    assert_eq!(admitted["project_knowledge"], true);
    let mut changed = start;
    changed["allow_project_knowledge"] = json!(false);
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{a}/agent"),
            &owner.token,
            changed
        )
        .await
        .status(),
        409
    );
    let task = sqlx::query_as("SELECT * FROM burrow_tasks WHERE id=?")
        .bind(&a)
        .fetch_one(&s.state.db)
        .await
        .unwrap();
    let event = json!({"id":"a".repeat(64),"proposal":{"kind":"spec","base_revision":0,"content":"Agent suggestion"}});
    for _ in 0..2 {
        let mut tx = s.state.db.begin().await.unwrap();
        specs::ingest(&mut tx, &owner.id, &task, "run-fixture", &event)
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    let mut altered = event.clone();
    altered["proposal"]["content"] = json!("Changed payload under the same identity");
    let mut tx = s.state.db.begin().await.unwrap();
    assert!(
        specs::ingest(&mut tx, &owner.id, &task, "run-fixture", &altered)
            .await
            .is_err()
    );
    tx.rollback().await.unwrap();
    let state = read(&s, &owner.token, &a).await;
    assert_eq!(state["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(state["proposals"][0]["status"], "pending");
    assert_eq!(state["spec"]["revision"], 0);
    agent::recover(&s.state.db).await.unwrap();
    assert_eq!(read(&s, &owner.token, &a).await, state);
}

#[tokio::test]
async fn real_pi_worker_proposals_reconcile_then_human_approves_one_sandbox_test() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let directory =
        std::env::temp_dir().join(format!("burrow-project-e2e-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).unwrap();
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../worker/test/fixtures/project-worker.mjs");
    let mut child = tokio::process::Command::new("node")
        .arg(fixture)
        .arg(&directory)
        .env_remove("OPENAI_API_KEY")
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let startup = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        BufReader::new(child.stdout.take().unwrap())
            .lines()
            .next_line(),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    let startup: Value = serde_json::from_str(&startup).unwrap();
    let port = startup["port"].as_u64().unwrap();
    let s = TestServer::start_with(|state| {
        state.kikka = Some(Kikka {
            binary: Default::default(),
            home: Default::default(),
            user: "*".into(),
            orb: "pi".into(),
            model: "fixture".into(),
            verify: String::new(),
            lock: Default::default(),
            routing: None,
            pi: Some(Pi {
                endpoint: format!("http://127.0.0.1:{port}/command"),
                token: "fixture-token-not-a-secret-000000000".into(),
            }),
        })
    })
    .await;
    let owner = s.register("real_specs", "test-password").await;
    let a = task(&s, &owner.token, "Real pipeline").await;
    let r=s.post_json_auth(&format!("/api/v1/burrow/tasks/{a}/agent"),&owner.token,json!({"version":0,"allow_agent":true,"max_cost_cents":40,"allow_project_knowledge":true})).await;
    assert_eq!(r.status(), 200);
    let mut ready = false;
    for _ in 0..100 {
        agent::tick(&s.state).await.unwrap();
        let state = read(&s, &owner.token, &a).await;
        if state["proposals"].as_array().unwrap().len() == 2 {
            ready = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    assert!(
        ready,
        "real Pi tools should reach the server review surface"
    );
    let state = read(&s, &owner.token, &a).await;
    assert_eq!(state["spec"]["revision"], 0);
    let skill = state["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["kind"] == "skill")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert_eq!(
        decide(&s, &owner.token, &a, skill, "test").await.status(),
        409
    );
    assert_eq!(
        decide(&s, &owner.token, &a, skill, "approve")
            .await
            .status(),
        200
    );
    let response = decide(&s, &owner.token, &a, skill, "test").await;
    assert_eq!(response.status(), 200);
    let tested: Value = response.json().await.unwrap();
    assert_eq!(
        status(&tested, skill),
        if startup["sandbox"] == true {
            "tested"
        } else {
            "test_failed"
        }
    );
    assert!(tested["proposals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == skill)
        .unwrap()["test_report"]
        .as_str()
        .unwrap()
        .contains(if startup["sandbox"] == true {
            "NOT verified"
        } else {
            "No automatic retry"
        }));
    assert_eq!(
        decide(&s, &owner.token, &a, skill, "test").await.status(),
        409
    );
    assert_eq!(
        decide(&s, &owner.token, &a, skill, "rollback")
            .await
            .status(),
        200
    );
    agent::tick(&s.state).await.unwrap();
    assert_eq!(
        status(&read(&s, &owner.token, &a).await, skill),
        "rolled_back",
        "late event replay must not resurrect approval"
    );
    child.kill().await.unwrap();
    std::fs::remove_dir_all(directory).unwrap();
}
