//! S-M5: one-time prekeys can't be drained. Bundle fetches are throttled to 120 a minute
//! per caller; past 60 a minute for one target user, bundles still come back but without
//! a one-time prekey, so nobody can block new sessions with that user. Each one-time
//! prekey is handed out at most once even under concurrent fetches, and a user can
//! register at most 10 devices.

mod common;

use std::collections::HashSet;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

fn publish_body(device_id: i64, one_time_prekeys: usize) -> Value {
    json!({
        "device_id": device_id,
        "identity_key": format!("IDENTITY_{device_id}"),
        "registration_id": 1000 + device_id,
        "signed_prekey": { "key_id": 1, "public_key": "SPK_PUB", "signature": "SPK_SIG" },
        "one_time_prekeys": (0..one_time_prekeys)
            .map(|k| json!({ "key_id": k, "public_key": format!("OTK_{k}") }))
            .collect::<Vec<_>>(),
    })
}

async fn publish(srv: &TestServer, user: &AuthOk, device_id: i64, otks: usize) -> u16 {
    srv.post_json_auth(
        "/api/v1/signal/keys",
        &user.token,
        publish_body(device_id, otks),
    )
    .await
    .status()
    .as_u16()
}

async fn fetch(srv: &TestServer, caller: &AuthOk, target: &AuthOk) -> reqwest::Response {
    srv.get_auth(
        &format!("/api/v1/users/{}/prekey-bundles", target.id),
        &caller.token,
    )
    .await
}

#[tokio::test]
async fn bundle_fetches_are_limited_per_caller() {
    let srv = TestServer::start().await;
    let caller = srv.register("bundlecaller", "password123").await;

    // 120 a minute: enough for a first message to a full 20-member group many times
    // over. Split across two targets, each within its own 60-a-minute limit.
    for name in ["targetone", "targettwo"] {
        let target = srv.register(name, "password123").await;
        assert_eq!(publish(&srv, &target, 1, 0).await, 204);
        for _ in 0..60 {
            assert_eq!(fetch(&srv, &caller, &target).await.status(), 200);
        }
    }
    let third = srv.register("targetthree", "password123").await;
    assert_eq!(publish(&srv, &third, 1, 0).await, 204);
    assert_eq!(
        fetch(&srv, &caller, &third).await.status(),
        429,
        "a 121st fetch by one caller is throttled"
    );
}

#[tokio::test]
async fn past_the_target_budget_bundles_still_come_back_without_a_one_time_prekey() {
    let srv = TestServer::start().await;
    let target = srv.register("bundletarget", "password123").await;
    assert_eq!(publish(&srv, &target, 1, 100).await, 204);

    // Two callers spend the target's 60-a-minute budget, popping 60 one-time prekeys.
    for name in ["callerone", "callertwo"] {
        let caller = srv.register(name, "password123").await;
        for _ in 0..30 {
            assert_eq!(fetch(&srv, &caller, &target).await.status(), 200);
        }
    }
    assert_eq!(remaining_one_time_prekeys(&srv, &target).await, 40);

    // Anyone else can still start a session: the bundle comes back, minus the
    // one-time prekey, and the target's stock is left alone.
    let third = srv.register("callerthree", "password123").await;
    let res = fetch(&srv, &third, &target).await;
    assert_eq!(res.status(), 200, "the target's bundles stay reachable");
    let bundles: Value = res.json().await.unwrap();
    assert_eq!(bundles[0]["identity_key"], "IDENTITY_1");
    assert!(
        bundles[0]["one_time_prekey"].is_null(),
        "no one-time prekey past the budget: {bundles}"
    );
    assert_eq!(remaining_one_time_prekeys(&srv, &target).await, 40);
}

async fn remaining_one_time_prekeys(srv: &TestServer, user: &AuthOk) -> i64 {
    let count: Value = srv
        .get_auth("/api/v1/signal/keys/count?device_id=1", &user.token)
        .await
        .json()
        .await
        .unwrap();
    count["count"].as_i64().unwrap()
}

#[tokio::test]
async fn concurrent_fetches_never_hand_out_a_one_time_prekey_twice() {
    let srv = TestServer::start().await;
    let target = srv.register("bundletarget", "password123").await;
    assert_eq!(publish(&srv, &target, 1, 20).await, 204);
    let caller = srv.register("bundlecaller", "password123").await;

    let fetches = (0..20).map(|_| fetch(&srv, &caller, &target));
    let responses = futures_util::future::join_all(fetches).await;
    let mut handed_out = Vec::new();
    for res in responses {
        assert_eq!(res.status(), 200);
        let bundles: Value = res.json().await.unwrap();
        if let Some(key_id) = bundles[0]["one_time_prekey"]["key_id"].as_i64() {
            handed_out.push(key_id);
        }
    }
    let distinct: HashSet<i64> = handed_out.iter().copied().collect();
    assert_eq!(distinct.len(), handed_out.len(), "a key went out twice");
    assert_eq!(handed_out.len(), 20, "every fetch got one of the 20 keys");
}

#[tokio::test]
async fn a_user_can_register_at_most_10_devices() {
    let srv = TestServer::start().await;
    let alice = srv.register("manydevices", "password123").await;
    for device_id in 1..=10 {
        assert_eq!(publish(&srv, &alice, device_id, 1).await, 204);
    }
    assert_eq!(publish(&srv, &alice, 11, 1).await, 403, "an 11th device");
    assert_eq!(
        publish(&srv, &alice, 5, 1).await,
        204,
        "an existing device still refreshes its keys"
    );
}
