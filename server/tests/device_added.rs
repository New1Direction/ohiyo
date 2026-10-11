//! A device registering on an account for the first time is announced to the account's
//! live sessions (`DeviceAdded`), so its other devices can warn at once. A stolen session
//! could otherwise add a device and read every later encrypted message unnoticed.
//! Refreshing an existing device's prekeys is not a new device and is not announced.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};

fn publish_body(device_id: i64, identity_key: &str) -> Value {
    json!({
        "device_id": device_id,
        "identity_key": identity_key,
        "registration_id": 1000 + device_id,
        "signed_prekey": { "key_id": device_id, "public_key": "SPK", "signature": "SIG" },
        "one_time_prekeys": [],
    })
}

fn device_added(event: &Value) -> Option<i64> {
    (event["t"] == "DeviceAdded").then(|| event["d"]["device_id"].as_i64().unwrap())
}

#[tokio::test]
async fn a_new_device_is_announced_to_the_accounts_sessions_and_a_refresh_is_not() {
    let srv = TestServer::start().await;
    let alice = srv.register("devicealice", "supersecret123").await;
    let bob = srv.register("devicebob", "supersecret123").await;

    let publish = |token: &str, device: i64, identity: &str| {
        let body = publish_body(device, identity);
        let token = token.to_owned();
        let srv = &srv;
        async move {
            srv.post_json_auth("/api/v1/signal/keys", &token, body)
                .await
                .status()
        }
    };
    assert_eq!(publish(&alice.token, 1, "ID_1").await, 204);

    let mut alice_ws = Gateway::connect(&srv, &alice.token).await;
    let mut bob_ws = Gateway::connect(&srv, &bob.token).await;

    // Device 1 refreshes its prekeys: not new. Then a second device registers.
    assert_eq!(publish(&alice.token, 1, "ID_1").await, 204);
    assert_eq!(publish(&alice.token, 2, "ID_2").await, 204);

    // The first DeviceAdded alice's session sees is device 2: the refresh sent nothing.
    let first = alice_ws.wait_for(|e| device_added(e).is_some()).await;
    assert_eq!(device_added(&first), Some(2));

    // Only alice's sessions hear about alice's devices. Bob's next DeviceAdded is his own.
    assert_eq!(publish(&bob.token, 7, "BOB_7").await, 204);
    let bobs = bob_ws.wait_for(|e| device_added(e).is_some()).await;
    assert_eq!(device_added(&bobs), Some(7));
}

#[tokio::test]
async fn a_removed_device_that_returns_with_its_own_key_is_announced_again() {
    let srv = TestServer::start().await;
    let alice = srv.register("returnalice", "supersecret123").await;
    let publish = |device: i64| {
        srv.post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(device, "ID_3"),
        )
    };
    assert_eq!(publish(3).await.status(), 204);
    assert_eq!(
        srv.delete_auth("/api/v1/users/@me/devices/3", &alice.token)
            .await
            .status(),
        204
    );

    let mut ws = Gateway::connect(&srv, &alice.token).await;
    // The tombstone lets the same identity come back; it is a device on the account again.
    assert_eq!(publish(3).await.status(), 204);
    let event = ws.wait_for(|e| device_added(e).is_some()).await;
    assert_eq!(device_added(&event), Some(3));
}
