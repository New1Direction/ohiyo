mod common;

use common::TestServer;
use serde_json::{json, Value};
use server::provision::MAX_FREE_INSTANCES;

#[tokio::test]
async fn create_then_list_and_get_instance() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;

    let res = srv
        .post_json_auth(
            "/api/v1/instances",
            &alice.token,
            json!({ "name": "The Roost" }),
        )
        .await;
    assert_eq!(res.status(), 200, "create should succeed");
    let inst: Value = res.json().await.unwrap();
    assert_eq!(inst["status"], "healthy");
    assert_eq!(inst["tier"], "free");
    assert!(inst["public_url"].as_str().unwrap().ends_with(".ohiyo.gg"));
    assert!(inst["machine_id"]
        .as_str()
        .unwrap()
        .starts_with("fake-machine-"));

    let id = inst["id"].as_str().unwrap().to_owned();

    let list: Value = srv
        .get_auth("/api/v1/instances", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);

    let got = srv
        .get_auth(&format!("/api/v1/instances/{id}"), &alice.token)
        .await;
    assert_eq!(got.status(), 200);
    let got_body: Value = got.json().await.unwrap();
    assert_eq!(got_body["id"], id);
}

#[tokio::test]
async fn instances_require_auth() {
    let srv = TestServer::start().await;
    let res = srv
        .post_json("/api/v1/instances", json!({ "name": "x" }))
        .await;
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn free_tier_cap_is_enforced() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;
    for i in 0..MAX_FREE_INSTANCES {
        let res = srv
            .post_json_auth(
                "/api/v1/instances",
                &alice.token,
                json!({ "name": format!("s{i}") }),
            )
            .await;
        assert_eq!(res.status(), 200, "instance {i} should provision");
    }
    let over = srv
        .post_json_auth("/api/v1/instances", &alice.token, json!({ "name": "over" }))
        .await;
    assert_eq!(
        over.status(),
        409,
        "fourth instance should hit the free cap"
    );
}

#[tokio::test]
async fn other_user_cannot_read_my_instance() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;
    let bob = srv.register("bob", "supersecret123").await;

    let res = srv
        .post_json_auth(
            "/api/v1/instances",
            &alice.token,
            json!({ "name": "Alice HQ" }),
        )
        .await;
    let inst: Value = res.json().await.unwrap();
    let id = inst["id"].as_str().unwrap();

    let res = srv
        .get_auth(&format!("/api/v1/instances/{id}"), &bob.token)
        .await;
    assert_eq!(
        res.status(),
        404,
        "owner-scoping must hide other users' instances"
    );

    // ...and Bob's list must come back empty even though Alice has an instance —
    // proves the list query is owner-scoped, not global.
    let bob_list: Value = srv
        .get_auth("/api/v1/instances", &bob.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        bob_list.as_array().unwrap().len(),
        0,
        "list endpoint must be owner-scoped"
    );
}
