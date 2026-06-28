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
    // machine_id/volume_id are intentionally NOT serialized in the API response (internal
    // Fly infra ids — see #[serde(skip_serializing)] on HostedInstance). The "healthy"
    // status above already proves a machine was provisioned; assert the ids are absent so
    // this test stays a guard against re-leaking them.
    assert!(
        inst["machine_id"].is_null(),
        "machine_id must not be exposed to clients"
    );
    assert!(
        inst["volume_id"].is_null(),
        "volume_id must not be exposed to clients"
    );

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
async fn owner_can_sleep_wake_export_graduate_and_open_billing() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;

    let res = srv
        .post_json_auth(
            "/api/v1/instances",
            &alice.token,
            json!({ "name": "Always Mine" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let inst: Value = res.json().await.unwrap();
    let id = inst["id"].as_str().unwrap();

    let slept = srv
        .post_json_auth(
            &format!("/api/v1/instances/{id}/sleep"),
            &alice.token,
            json!({}),
        )
        .await;
    assert_eq!(slept.status(), 200);
    let slept_body: Value = slept.json().await.unwrap();
    assert_eq!(slept_body["status"], "sleeping");

    let woke = srv
        .post_json_auth(
            &format!("/api/v1/instances/{id}/wake"),
            &alice.token,
            json!({}),
        )
        .await;
    assert_eq!(woke.status(), 200);
    let woke_body: Value = woke.json().await.unwrap();
    assert_eq!(woke_body["status"], "healthy");

    let tier = srv
        .patch_json_auth(
            &format!("/api/v1/instances/{id}/tier"),
            &alice.token,
            json!({ "tier": "paid" }),
        )
        .await;
    assert_eq!(tier.status(), 200);
    let tier_body: Value = tier.json().await.unwrap();
    assert_eq!(tier_body["tier"], "paid");

    let export: Value = srv
        .get_auth(&format!("/api/v1/instances/{id}/export"), &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(export["version"], 2);
    assert_eq!(export["instance"]["id"], id);
    assert!(export["self_host"]["raw_data_export_url"]
        .as_str()
        .unwrap()
        .ends_with("/api/v1/server-pack/export"));
    assert!(export["self_host"]["one_liner"]
        .as_str()
        .unwrap()
        .contains("docker run"));

    let graduate: Value = srv
        .get_auth(&format!("/api/v1/instances/{id}/graduate"), &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(graduate["steps"].as_array().unwrap().len() >= 4);

    let billing: Value = srv
        .get_auth(&format!("/api/v1/instances/{id}/billing"), &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(
        billing["checkout_url"]
            .as_str()
            .unwrap()
            .starts_with("mailto:")
            || billing["checkout_url"]
                .as_str()
                .unwrap()
                .starts_with("http")
    );
}

#[tokio::test]
async fn owner_can_delete_instance() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;

    let res = srv
        .post_json_auth(
            "/api/v1/instances",
            &alice.token,
            json!({ "name": "Temporary" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let inst: Value = res.json().await.unwrap();
    let id = inst["id"].as_str().unwrap();

    let deleted = srv
        .delete_auth(&format!("/api/v1/instances/{id}"), &alice.token)
        .await;
    assert_eq!(deleted.status(), 204);

    let got = srv
        .get_auth(&format!("/api/v1/instances/{id}"), &alice.token)
        .await;
    assert_eq!(got.status(), 404);

    let list: Value = srv
        .get_auth("/api/v1/instances", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn other_user_cannot_delete_my_instance() {
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
        .delete_auth(&format!("/api/v1/instances/{id}"), &bob.token)
        .await;
    assert_eq!(res.status(), 404);

    let still_there = srv
        .get_auth(&format!("/api/v1/instances/{id}"), &alice.token)
        .await;
    assert_eq!(still_there.status(), 200);
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
