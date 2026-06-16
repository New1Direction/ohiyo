mod common;

use common::TestServer;
use serde_json::{json, Value};

#[tokio::test]
async fn normal_host_passes_through_router() {
    let srv = TestServer::start().await;
    // Default Host is 127.0.0.1:<port> — not an ohiyo.gg subdomain — so it passes through
    // to the normal app and the DB-aware health check answers.
    let res = srv
        .client
        .get(format!("{}/healthz", srv.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(res.text().await.unwrap(), "ok");
}

#[tokio::test]
async fn unknown_community_subdomain_returns_router_404() {
    let srv = TestServer::start().await;
    let res = srv
        .client
        .get(format!("{}/", srv.base))
        .header(reqwest::header::HOST, "nope.ohiyo.gg")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    let body = res.text().await.unwrap();
    assert!(
        body.contains("no Ohiyo server"),
        "expected the router's 404, got: {body}"
    );
}

#[tokio::test]
async fn provisioned_subdomain_replays_to_its_machine() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;

    let inst: Value = srv
        .post_json_auth(
            "/api/v1/instances",
            &alice.token,
            json!({ "name": "Routed" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let sub = inst["subdomain"].as_str().unwrap();
    let machine = inst["machine_id"].as_str().unwrap();

    let res = srv
        .client
        .get(format!("{}/", srv.base))
        .header(reqwest::header::HOST, format!("{sub}.ohiyo.gg"))
        .send()
        .await
        .unwrap();

    let replay = res
        .headers()
        .get("fly-replay")
        .map(|v| v.to_str().unwrap().to_string());
    assert!(
        replay.is_some(),
        "expected a fly-replay header for a live subdomain"
    );
    let replay = replay.unwrap();
    assert!(
        replay.contains(&format!("instance={machine}")),
        "got {replay}"
    );
    assert!(replay.contains("app=ohiyo-instances"), "got {replay}");
}
