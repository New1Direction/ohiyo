//! Real HTTP/auth/SQLite tests. No model requests or provider credential checks.
mod common;
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::{
    agent::{Kikka, Pi},
    routing::{Config, Routing, ROLES},
};
use std::{collections::BTreeMap, path::PathBuf};

fn routing() -> Routing {
    let roles: BTreeMap<_, _> = ROLES
        .iter()
        .map(|r| (r.to_string(), "openai/test".to_owned()))
        .collect();
    let mut config:Config=serde_json::from_value(json!({"catalog":[{"id":"openai/test","providerModelId":"test","contextWindow":10000,"maxOutputTokens":1000,"inputUsdPerMillion":1,"outputUsdPerMillion":2},{"id":"openai/other","providerModelId":"other","contextWindow":10000,"maxOutputTokens":1000,"inputUsdPerMillion":1,"outputUsdPerMillion":2}],"connections":[{"id":"shared","name":"Ohiyo","endpoint":"https://api.openai.com/v1/chat/completions","modelMapping":"*/*","active":true,"priority":0,"keyEnv":"EXPLICIT_TEST_KEY"}],"roles":roles})).unwrap();
    for provider in ["alias", "first"] {
        config.catalog.push(
            serde_json::from_value(json!({
                "id":format!("openai/{provider}"),"providerModelId":provider,
                "contextWindow":20000,"maxOutputTokens":1000,
                "inputUsdPerMillion":3,"outputUsdPerMillion":4
            }))
            .unwrap(),
        );
    }
    Routing::new(
        config,
        Some(server::auth::two_factor::SecretBox::new(
            b"dedicated-test-key-0123456789012345",
        )),
        BTreeMap::from([("shared".into(), "operator-test-secret".into())]),
    )
    .unwrap()
}
async fn server() -> TestServer {
    TestServer::start_with(|s| {
        s.kikka = Some(Kikka {
            binary: PathBuf::new(),
            home: PathBuf::new(),
            user: "*".into(),
            orb: "pi".into(),
            model: "legacy".into(),
            verify: String::new(),
            lock: Default::default(),
            pi: Some(Pi {
                endpoint: "http://127.0.0.1:1/command".into(),
                token: "private-worker-token-0123456789012345".into(),
            }),
            routing: Some(routing()),
        })
    })
    .await
}
const SETTINGS: &str = "/api/v1/burrow/model-routing";
fn connection(name: &str, key: &str) -> Value {
    json!({"name":name,"templateId":"shared","modelMapping":"*/*\n-openai/*\nopenai/test -> alias # comment","active":true,"priority":0,"key":key})
}
async fn settings(s: &TestServer, t: &str) -> Value {
    s.get_auth(SETTINGS, t).await.json().await.unwrap()
}
async fn task(s: &TestServer, t: &str) -> String {
    s.post_json_auth(
        "/api/v1/burrow/tasks",
        t,
        json!({"request":"Compare public official plans"}),
    )
    .await
    .json::<Value>()
    .await
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn approve(s: &TestServer, t: &str, id: &str) -> Value {
    let routing = settings(s, t).await["preview"].clone();
    let r = s
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/agent"),
            t,
            json!({"version":0,"allow_agent":true,"max_cost_cents":10,"role":"review","routing":routing}),
        )
        .await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}
fn access_body(owner: &str, task: &str, run: &Value, connection: &str) -> Value {
    json!({"owner":owner,"task":task,"root_goal":format!("burrow-{}",run["id"].as_str().unwrap()),"role":"review","connectionId":connection})
}
async fn access(s: &TestServer, body: Value, token: &str) -> reqwest::Response {
    s.post_json_auth("/api/v1/burrow/internal/model-access", token, body)
        .await
}

#[tokio::test]
async fn subscription_proxy_uses_authenticated_owner_and_never_changes_model_routes() {
    use axum::{routing::post, Json, Router};
    use std::sync::{Arc, Mutex};
    let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = calls.clone();
    let app = Router::new().route("/command", post(move |Json(body): Json<Value>| {
        let received = received.clone();
        async move {
            received.lock().unwrap().push(body.clone());
            Json(json!({"state":"disconnected", "email":format!("{}@fixture.test", body["owner"].as_str().unwrap()), "usableForResearch":false}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/command", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let s = TestServer::start_with(move |s| {
        s.kikka = Some(Kikka {
            binary: PathBuf::new(),
            home: PathBuf::new(),
            user: "*".into(),
            orb: "pi".into(),
            model: "legacy".into(),
            verify: String::new(),
            lock: Default::default(),
            pi: Some(Pi {
                endpoint,
                token: "private-subscription-fixture-token-0123456789".into(),
            }),
            routing: Some(routing()),
        })
    })
    .await;
    let a = s.register("subscriptionowner", "password-12345").await;
    let b = s.register("subscriptionother", "password-12345").await;
    let path = "/api/v1/burrow/subscriptions";
    assert_eq!(
        s.client
            .get(format!("{}{path}", s.base))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let before = settings(&s, &a.token).await;
    for owner in [&a, &b] {
        let response = s.get_auth(path, &owner.token).await;
        assert_eq!(response.headers()["cache-control"], "no-store");
        let value = response.json::<Value>().await.unwrap();
        assert_eq!(
            value["claude"]["email"],
            format!("{}@fixture.test", owner.id)
        );
        assert_eq!(
            value["chatgpt"]["email"],
            format!("{}@fixture.test", owner.id)
        );
    }
    assert_eq!(
        s.post_json_auth(&format!("{path}/claude"), &a.token, json!({"owner":b.id}))
            .await
            .status(),
        200
    );
    assert_eq!(
        calls.lock().unwrap().last().unwrap()["owner"],
        a.id,
        "body cannot choose a different account"
    );
    let valid_calls = calls.lock().unwrap().len();
    assert_eq!(
        s.post_json_auth(
            &format!("{path}/claude/code"),
            &a.token,
            json!({"attempt":"fixture", "code":"code", "owner":b.id})
        )
        .await
        .status(),
        422
    );
    assert_eq!(
        s.post_json_auth(
            &format!("{path}/claude/code"),
            &a.token,
            json!({"attempt":"fixture", "code":"line\ninjection"})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        s.post_json_auth(
            &format!("{path}/chatgpt/code"),
            &a.token,
            json!({"attempt":"fixture", "code":"code"})
        )
        .await
        .status(),
        404
    );
    assert_eq!(
        s.post_json_auth(&format!("{path}/unknown"), &a.token, json!({}))
            .await
            .status(),
        404
    );
    assert_eq!(
        calls.lock().unwrap().len(),
        valid_calls,
        "invalid completion never reaches the worker"
    );
    assert_eq!(
        settings(&s, &a.token).await,
        before,
        "sign-in cannot activate subscription inference or a fallback"
    );
    assert!(calls
        .lock()
        .unwrap()
        .iter()
        .all(|c| c["operation"] == "subscription"));
    worker.abort();
}

#[tokio::test]
async fn subscription_only_install_requires_explicit_choice_and_rechecks_owner_and_revision() {
    use axum::{http::StatusCode, routing::post, Json, Router};
    use std::sync::{Arc, Mutex};
    let accounts = Arc::new(Mutex::new(BTreeMap::<String, u32>::new()));
    let connected = accounts.clone();
    let model = "subscription/claude/claude-sonnet-5-5";
    let app = Router::new().route("/command", post(move |Json(body): Json<Value>| {
        let connected = connected.clone();
        async move {
            let owner = body["owner"].as_str().unwrap_or("");
            let revision = connected.lock().unwrap().get(owner).copied();
            if body["action"] == "route" {
                if body["model"] != model || revision.is_none() { return (StatusCode::CONFLICT, Json(json!({}))); }
                return (StatusCode::OK, Json(json!({"canonicalModel":model,"providerModelId":"claude-sonnet-5-5","connectionId":"subscription-claude","connectionRevision":revision.unwrap().to_string(),"endpoint":"https://api.anthropic.com/v1/messages","fundedBy":"you","contextWindow":1000000,"maxOutputTokens":4096,"inputUsdPerMillion":0,"outputUsdPerMillion":0})));
            }
            (StatusCode::OK, Json(json!({"state":if revision.is_some() { "connected" } else { "disconnected" },"usableForResearch":revision.is_some(),"models":[{"id":model,"providerModelId":"claude-sonnet-5-5"}]})))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/command", listener.local_addr().unwrap());
    let worker = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let worker_token = "subscription-only-worker-token-0123456789";
    let s = TestServer::start_with(move |s| {
        s.kikka = Some(Kikka {
            binary: PathBuf::new(),
            home: PathBuf::new(),
            user: "*".into(),
            orb: "pi".into(),
            model: "legacy".into(),
            verify: String::new(),
            lock: Default::default(),
            pi: Some(Pi {
                endpoint,
                token: worker_token.into(),
            }),
            routing: None,
        })
    })
    .await;
    let a = s.register("subscriptiononly", "password-12345").await;
    let b = s.register("subscriptionisolated", "password-12345").await;
    let roles = json!({"general":model,"research":model,"review":model,"summary":model});
    assert_eq!(settings(&s, &a.token).await["preview"], json!({}));
    assert_eq!(
        s.put_json_auth(&format!("{SETTINGS}/roles"), &a.token, roles.clone())
            .await
            .status(),
        409
    );
    accounts.lock().unwrap().insert(a.id.clone(), 1);
    assert_eq!(
        settings(&s, &a.token).await["preview"],
        json!({}),
        "sign-in alone never selects a model"
    );
    assert_eq!(
        s.put_json_auth(&format!("{SETTINGS}/roles"), &a.token, roles.clone())
            .await
            .status(),
        200
    );
    assert_eq!(
        s.put_json_auth(&format!("{SETTINGS}/roles"), &b.token, roles)
            .await
            .status(),
        409
    );
    assert_eq!(settings(&s, &b.token).await["preview"], json!({}));
    let id = task(&s, &a.token).await;
    let preview = settings(&s, &a.token).await["preview"].clone();
    let approval = s.post_json_auth(&format!("/api/v1/burrow/tasks/{id}/agent"), &a.token,
        json!({"version":0,"allow_agent":true,"max_cost_cents":0,"role":"review","routing":preview})).await;
    assert_eq!(approval.status(), 200);
    let run: Value = approval.json().await.unwrap();
    let request = access_body(&a.id, &id, &run, "subscription-claude");
    let allowed = access(&s, request.clone(), worker_token).await;
    assert_eq!(allowed.status(), 200);
    assert_eq!(
        allowed.json::<Value>().await.unwrap(),
        json!({"key":"subscription-authorized"})
    );
    assert_ne!(
        access(
            &s,
            access_body(&b.id, &id, &run, "subscription-claude"),
            worker_token
        )
        .await
        .status(),
        200
    );
    assert_eq!(access(&s, request.clone(), &a.token).await.status(), 401);
    accounts.lock().unwrap().insert(a.id.clone(), 2);
    assert_ne!(
        access(&s, request.clone(), worker_token).await.status(),
        200,
        "new sign-in cannot revive an old task approval"
    );
    accounts.lock().unwrap().remove(&a.id);
    assert_ne!(
        access(&s, request, worker_token).await.status(),
        200,
        "revocation blocks new requests"
    );
    worker.abort();
}

#[tokio::test]
async fn isolated_encrypted_settings_pinned_admission_and_revocation() {
    let s = server().await;
    let a = s.register("routeowner", "password-12345").await;
    let b = s.register("routeother", "password-12345").await;
    assert_eq!(s.get(SETTINGS).await.status(), 401);
    for token in [&a.token, &b.token] {
        let workspace: Value = s
            .get_auth("/api/v1/burrow", token)
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(workspace["can_research"], true);
    }
    let initial = settings(&s, &a.token).await;
    assert_eq!(initial["preview"]["review"]["fundedBy"], "ohiyo");
    let r = s
        .post_json_auth(
            &format!("{SETTINGS}/connections"),
            &a.token,
            connection("Mine", "personal-test-secret"),
        )
        .await;
    assert_eq!(r.status(), 200);
    let mine: Value = r.json().await.unwrap();
    let id = mine["connections"][0]["id"].as_str().unwrap();
    assert!(!mine.to_string().contains("personal-test-secret"));
    assert!(!mine.to_string().contains("ciphertext"));
    assert_eq!(mine["preview"]["review"]["providerModelId"], "alias");
    assert_eq!(mine["preview"]["review"]["fundedBy"], "you");
    // An alias is priced as the target, never the cheaper selected name.
    assert_eq!(mine["preview"]["review"]["contextWindow"], 20000);
    assert_eq!(mine["preview"]["review"]["inputUsdPerMillion"], 3.0);
    assert_eq!(mine["preview"]["review"]["outputUsdPerMillion"], 4.0);
    let blob: Vec<u8> = sqlx::query_scalar("SELECT ciphertext FROM kikka_connections WHERE id=?")
        .bind(id)
        .fetch_one(&s.state.db)
        .await
        .unwrap();
    assert!(!blob.windows(20).any(|w| w == b"personal-test-secret"));
    assert_eq!(
        settings(&s, &b.token).await["connections"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut foreign = connection("Theft", "changed");
    foreign["id"] = json!(id);
    assert_eq!(
        s.post_json_auth(&format!("{SETTINGS}/connections"), &b.token, foreign)
            .await
            .status(),
        400
    );
    assert_eq!(
        s.delete_auth(&format!("{SETTINGS}/connections/{id}"), &b.token)
            .await
            .status(),
        400
    );
    let task_id = task(&s, &a.token).await;
    let approval = format!("/api/v1/burrow/tasks/{task_id}/agent");
    // Even within the same approved cost cap, never change provider/payer after
    // the user reviewed a different preview. No attempt is consumed on conflict.
    for routing in [Value::Null, initial["preview"].clone()] {
        assert_eq!(s.post_json_auth(&approval, &a.token,
            json!({"version":0,"allow_agent":true,"max_cost_cents":10,"role":"review","routing":routing}))
            .await.status(), 409);
    }
    let run = approve(&s, &a.token, &task_id).await;
    assert_eq!(run["role"], "review");
    assert_eq!(run["routing"], mine["preview"]);
    for suffix in [
        "agent",
        "agent/evidence/e-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ] {
        assert_eq!(
            s.get_auth(
                &format!("/api/v1/burrow/tasks/{task_id}/{suffix}"),
                &b.token
            )
            .await
            .status(),
            404
        );
    }
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{task_id}/agent/control"),
            &b.token,
            json!({"version":1,"request_id":"foreign","action":"stop"})
        )
        .await
        .status(),
        404
    );
    let body = access_body(&a.id, &task_id, &run, id);
    assert_eq!(access(&s, body.clone(), &a.token).await.status(), 401);
    let token = "private-worker-token-0123456789012345";
    let ok = access(&s, body.clone(), token).await;
    assert_eq!(ok.status(), 200);
    assert_eq!(ok.headers()["cache-control"], "no-store");
    assert_eq!(
        ok.json::<Value>().await.unwrap(),
        json!({"key":"personal-test-secret"})
    );
    for field in ["owner", "task", "root_goal", "role", "connectionId"] {
        let mut wrong = body.clone();
        wrong[field] = json!("wrong");
        assert_eq!(access(&s, wrong, token).await.status(), 400);
    }
    let roles: BTreeMap<_, _> = ROLES
        .iter()
        .map(|r| (r.to_string(), "openai/other".to_string()))
        .collect();
    assert_eq!(
        s.put_json_auth(&format!("{SETTINGS}/roles"), &a.token, json!(roles))
            .await
            .status(),
        200
    );
    assert_eq!(
        settings(&s, &b.token).await["roles"]["review"],
        "openai/test"
    );
    let saved: Value = s
        .get_auth(&format!("/api/v1/burrow/tasks/{task_id}/agent"), &a.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(saved["agent"]["routing"], run["routing"]);
    assert_eq!(access(&s, body.clone(), token).await.status(), 200);
    let mut update = connection("Mine renamed", "");
    update["id"] = json!(id);
    assert_eq!(
        s.post_json_auth(&format!("{SETTINGS}/connections"), &a.token, update)
            .await
            .status(),
        200
    );
    assert_eq!(access(&s, body.clone(), token).await.status(), 400);
    // Blank updates retain encrypted key, but any edited connection revokes old admissions.
    let retained: Vec<u8> =
        sqlx::query_scalar("SELECT ciphertext FROM kikka_connections WHERE id=?")
            .bind(id)
            .fetch_one(&s.state.db)
            .await
            .unwrap();
    assert_eq!(blob, retained);
    assert_eq!(
        s.delete_auth(&format!("{SETTINGS}/connections/{id}"), &a.token)
            .await
            .status(),
        200
    );
    assert_eq!(access(&s, body, token).await.status(), 400);
}

#[tokio::test]
async fn mapping_order_priority_validation_restart_and_budget() {
    let mut s = server().await;
    let a = s.register("routepilot", "password-12345").await;
    for mapping in [
        "a*b",
        "openai/* -> alias",
        "-openai/test -> alias",
        "--openai/test",
        "openai/test ->",
        "**test",
        "openai/test -> a -> b",
        "openai/test -> unpriced-expensive-model",
    ] {
        let mut c = connection("Bad", "test-key");
        c["modelMapping"] = json!(mapping);
        assert_eq!(
            s.post_json_auth(&format!("{SETTINGS}/connections"), &a.token, c)
                .await
                .status(),
            400,
            "{mapping}"
        );
    }
    let mut unknown = connection("Bad", "secret");
    unknown["endpoint"] = json!("https://evil.example/chat/completions");
    assert_eq!(
        s.post_json_auth(&format!("{SETTINGS}/connections"), &a.token, unknown)
            .await
            .status(),
        422
    );
    assert_eq!(
        s.put_json_auth(
            &format!("{SETTINGS}/roles"),
            &a.token,
            json!({"review":"openai/test"})
        )
        .await
        .status(),
        422
    );
    let before = settings(&s, &a.token).await;
    let id = task(&s, &a.token).await;
    let run = approve(&s, &a.token, &id).await;
    // Reconstruct runtime state against the same SQLite DB, not process-local key versions.
    s.state.kikka.as_mut().unwrap().routing = Some(routing());
    assert_eq!(
        server::api::burrow::routing::snapshot(&s.state, &a.id)
            .await
            .unwrap(),
        before["preview"]
    );
    server::api::burrow::agent::recover(&s.state.db)
        .await
        .unwrap();
    let body = access_body(&a.id, &id, &run, "shared");
    assert_eq!(
        access(&s, body.clone(), "private-worker-token-0123456789012345")
            .await
            .status(),
        200
    );
    let mut rebuilt = s.state.clone();
    rebuilt
        .kikka
        .as_mut()
        .unwrap()
        .routing
        .as_mut()
        .unwrap()
        .config
        .connections[0]
        .active = false;
    assert!(server::api::burrow::routing::snapshot(&rebuilt, &a.id)
        .await
        .unwrap()
        .as_object()
        .unwrap()
        .is_empty());
    let task2 = task(&s, &a.token).await;
    for budget in [0, 51] {
        assert_eq!(
            s.post_json_auth(
                &format!("/api/v1/burrow/tasks/{task2}/agent"),
                &a.token,
                json!({"version":0,"allow_agent":true,"max_cost_cents":budget})
            )
            .await
            .status(),
            400
        );
    }
    let mut c = connection("first", "one");
    c["modelMapping"] = json!("*/*\n-openai/*\n*-test\nopenai/test -> first");
    let first: Value = s
        .post_json_auth(&format!("{SETTINGS}/connections"), &a.token, c)
        .await
        .json()
        .await
        .unwrap();
    let first_id = first["connections"][0]["id"].clone();
    let second: Value = s
        .post_json_auth(
            &format!("{SETTINGS}/connections"),
            &a.token,
            connection("second", "two"),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(second["connections"][0]["name"], "second");
    assert_eq!(second["connections"][1]["priority"], 1);
    let mut moved = connection("first", "");
    moved["id"] = first_id.clone();
    moved["modelMapping"] = json!("*/*\n-openai/*\nopenai/test -> first");
    let moved: Value = s
        .post_json_auth(&format!("{SETTINGS}/connections"), &a.token, moved)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(moved["preview"]["review"]["providerModelId"], "first");
    let mut excluded = connection("first", "");
    excluded["id"] = first_id;
    excluded["modelMapping"] = json!("*/*\n-openai/*");
    let excluded: Value = s
        .post_json_auth(&format!("{SETTINGS}/connections"), &a.token, excluded)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        excluded["preview"]["review"]["connectionId"],
        second["connections"][0]["id"]
    );
    let mut inherited = connection("first", "");
    inherited["id"] = excluded["connections"][0]["id"].clone();
    inherited["modelMapping"] = json!("# Default to the approved template\n");
    let inherited: Value = s
        .post_json_auth(&format!("{SETTINGS}/connections"), &a.token, inherited)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(inherited["preview"]["review"]["providerModelId"], "test");
    assert_eq!(
        inherited["preview"]["review"]["connectionId"],
        excluded["connections"][0]["id"]
    );
}

#[tokio::test]
async fn multi_account_pi_dispatches_only_snapshots_and_persists_usage() {
    use axum::{extract::State, routing::post, Json, Router};
    use std::sync::Arc;
    let journal = Arc::new(tokio::sync::Mutex::new(BTreeMap::<String, Value>::new()));
    async fn worker(
        State(j): State<Arc<tokio::sync::Mutex<BTreeMap<String, Value>>>>,
        Json(body): Json<Value>,
    ) -> Json<Value> {
        let mut j = j.lock().await;
        match body["operation"].as_str().unwrap() {
            "start" => {
                let a = body["admission"].clone();
                let id = format!("run-{}", a["task"].as_str().unwrap());
                assert_eq!(a["role"], "review");
                assert_eq!(a["routing"]["research"]["connectionId"], "shared");
                assert!(!a.to_string().contains("operator-test-secret"));
                j.insert(id.clone(), a);
                Json(json!(id))
            }
            "status" => {
                let id = body["run"].as_str().unwrap();
                let a = &j[id];
                Json(
                    json!({"run":id,"orb":"pi","root_goal_id":a["root_goal"],"state":"Running","usage":[{"role":"review","inputTokens":17,"outputTokens":4,"providerReportedCost":null}]}),
                )
            }
            "watch" => Json(json!([])),
            _ => panic!("unexpected operation"),
        }
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/command", listener.local_addr().unwrap());
    let app = Router::new()
        .route("/command", post(worker))
        .with_state(journal.clone());
    let worker = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut s = server().await;
    s.state
        .kikka
        .as_mut()
        .unwrap()
        .pi
        .as_mut()
        .unwrap()
        .endpoint = endpoint;
    // Run HTTP admission against a server carrying the same bridge configuration.
    let state = s.state.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = server::build_app(state);
    let app_server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap()
    });
    s.base = base;
    let a = s.register("dispatchone", "password-12345").await;
    let b = s.register("dispatchtwo", "password-12345").await;
    let ta = task(&s, &a.token).await;
    let tb = task(&s, &b.token).await;
    let ra = approve(&s, &a.token, &ta).await;
    approve(&s, &b.token, &tb).await;
    server::api::burrow::agent::tick(&s.state).await.unwrap();
    assert_eq!(journal.lock().await.len(), 2);
    let owners: Vec<_> = journal
        .lock()
        .await
        .values()
        .map(|a| a["owner"].as_str().unwrap().to_owned())
        .collect();
    assert!(owners.contains(&a.id) && owners.contains(&b.id));
    server::api::burrow::agent::recover(&s.state.db)
        .await
        .unwrap();
    server::api::burrow::agent::tick(&s.state).await.unwrap();
    assert_eq!(journal.lock().await.len(), 2);
    let saved: Value = s
        .get_auth(&format!("/api/v1/burrow/tasks/{ta}/agent"), &a.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        saved["agent"]["usage"],
        json!([{"role":"review","inputTokens":17,"outputTokens":4,"providerReportedCost":null}])
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        "authorization",
        "Bearer private-worker-token-0123456789012345"
            .parse()
            .unwrap(),
    );
    for change in ["inactive", "config", "key"] {
        let mut modified = s.state.clone();
        let mut config = modified
            .kikka
            .as_ref()
            .unwrap()
            .routing
            .as_ref()
            .unwrap()
            .config
            .clone();
        if change == "inactive" {
            config.connections[0].active = false;
        }
        if change == "config" {
            config.catalog[0].max_output_tokens = 900;
        }
        let key = if change == "key" {
            "rotated-operator-test-secret"
        } else {
            "operator-test-secret"
        };
        modified.kikka.as_mut().unwrap().routing = Some(
            Routing::new(
                config,
                None,
                BTreeMap::from([("shared".into(), key.into())]),
            )
            .unwrap(),
        );
        let body = serde_json::from_value(access_body(&a.id, &ta, &ra, "shared")).unwrap();
        assert!(
            server::api::burrow::routing::access(State(modified), headers.clone(), Json(body))
                .await
                .is_err(),
            "{change}"
        );
    }
    sqlx::query("DELETE FROM users WHERE id=?")
        .bind(&a.id)
        .execute(&s.state.db)
        .await
        .unwrap();
    assert_eq!(
        access(
            &s,
            access_body(&a.id, &ta, &ra, "shared"),
            "private-worker-token-0123456789012345"
        )
        .await
        .status(),
        400
    );
    worker.abort();
    app_server.abort();
}

#[tokio::test]
async fn disabled_settings_and_missing_credentials_fail_closed() {
    let s = TestServer::start_with(|s| s.kikka = None).await;
    let a = s.register("disabledroutes", "password-12345").await;
    let value = settings(&s, &a.token).await;
    assert_eq!(value["catalog"], json!([]));
    assert_eq!(value["roles"], json!({}));
    assert_eq!(value["connections"], json!([]));
    assert_eq!(value["preview"], json!({}));
    let configured = server().await;
    let mut state = configured.state.clone();
    let config = state
        .kikka
        .as_ref()
        .unwrap()
        .routing
        .as_ref()
        .unwrap()
        .config
        .clone();
    state.kikka.as_mut().unwrap().routing =
        Some(Routing::new(config, None, BTreeMap::new()).unwrap());
    assert!(
        server::api::burrow::routing::snapshot(&state, "nonexistent")
            .await
            .is_err()
    );
    // Invalid startup configuration must not look like the legacy single-model
    // mode to a client deciding whether it can approve work.
    state
        .kikka
        .as_mut()
        .unwrap()
        .routing
        .as_mut()
        .unwrap()
        .config
        .catalog
        .clear();
    let error = server::api::burrow::routing::get(
        axum::extract::State(state),
        server::auth::AuthUser(a.id, 0),
    )
    .await
    .unwrap_err();
    assert_eq!(error.0, axum::http::StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn zero_budget_requires_zero_price_routes_and_is_saved_without_increasing_it() {
    let paid = server().await;
    let owner = paid.register("zerobudgetpaid", "password-12345").await;
    let id = task(&paid, &owner.token).await;
    let preview = settings(&paid, &owner.token).await["preview"].clone();
    assert_eq!(
        paid.post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/agent"),
            &owner.token,
            json!({"version":0,"allow_agent":true,"max_cost_cents":0,"routing":preview})
        )
        .await
        .status(),
        400
    );
    let mut kikka = paid.state.kikka.clone().unwrap();
    for model in &mut kikka.routing.as_mut().unwrap().config.catalog {
        model.input_usd_per_million = 0.0;
        model.output_usd_per_million = 0.0;
    }
    let free = TestServer::start_with(move |s| s.kikka = Some(kikka)).await;
    let owner = free.register("zerobudgetfree", "password-12345").await;
    let id = task(&free, &owner.token).await;
    let mut preview = settings(&free, &owner.token).await["preview"].clone();
    // JSON.stringify in the real client emits integer zero for these prices.
    for route in preview.as_object_mut().unwrap().values_mut() {
        route["inputUsdPerMillion"] = json!(0);
        route["outputUsdPerMillion"] = json!(0);
    }
    let body = json!({"version":0,"allow_agent":true,"max_cost_cents":0,"routing":preview});
    let response = free
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/agent"),
            &owner.token,
            body.clone(),
        )
        .await;
    assert_eq!(response.status(), 200);
    let admitted = response.json::<Value>().await.unwrap();
    assert_eq!(admitted["max_cost_cents"], 0);
    let retry = free
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/agent"),
            &owner.token,
            body.clone(),
        )
        .await;
    assert_eq!(retry.status(), 200);
    assert_eq!(retry.json::<Value>().await.unwrap()["id"], admitted["id"]);
    for (field, value) in [
        ("inputUsdPerMillion", json!(0.01)),
        ("fundedBy", json!("you")),
        ("endpoint", json!("https://other.example/chat/completions")),
    ] {
        let mut changed = body.clone();
        changed["routing"]["general"][field] = value;
        assert_eq!(
            free.post_json_auth(
                &format!("/api/v1/burrow/tasks/{id}/agent"),
                &owner.token,
                changed,
            )
            .await
            .status(),
            409
        );
    }
}
