//! Locks in the Signal identity-key boundary (PR #15):
//!  - a device's identity key is PINNED on first publish — it can never be silently
//!    swapped (the anti-impersonation guarantee behind safety numbers);
//!  - removing a device leaves a TOMBSTONE so the slot can't be re-seized with a
//!    different identity (prevents delete-then-republish key substitution);
//!  - benign rotations (same identity, new signed prekey) still succeed.

mod common;

use common::TestServer;
use serde_json::{json, Value};

fn publish_body(device_id: i64, identity_key: &str, spk_id: i64) -> Value {
    json!({
        "device_id": device_id,
        "identity_key": identity_key,
        "registration_id": 1000 + device_id,
        "signed_prekey": {
            "key_id": spk_id,
            "public_key": format!("SPK_PUB_{spk_id}"),
            "signature": format!("SPK_SIG_{spk_id}"),
        },
        "one_time_prekeys": [],
    })
}

/// Pull the stored identity key for `device_id` out of a `/identity-keys` array.
fn identity_for(list: &Value, device_id: i64) -> Option<String> {
    list.as_array()?.iter().find_map(|e| {
        (e["device_id"].as_i64() == Some(device_id))
            .then(|| e["identity_key"].as_str().unwrap_or_default().to_owned())
    })
}

#[tokio::test]
async fn identity_key_is_pinned_after_first_publish() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    // First publish establishes the pin.
    let res = srv
        .post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(1, "IDENTITY_A1", 1),
        )
        .await;
    assert_eq!(res.status(), 204, "initial publish should succeed");

    let list: Value = srv
        .get_auth(
            &format!("/api/v1/users/{}/identity-keys", alice.id),
            &alice.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(identity_for(&list, 1).as_deref(), Some("IDENTITY_A1"));

    // Attempting to swap the identity key for the SAME device must be rejected.
    let res = srv
        .post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(1, "IDENTITY_A2", 9),
        )
        .await;
    assert_eq!(
        res.status(),
        409,
        "identity-key swap must be pinned/rejected"
    );

    // ...and the swap must not have taken effect.
    let list: Value = srv
        .get_auth(
            &format!("/api/v1/users/{}/identity-keys", alice.id),
            &alice.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        identity_for(&list, 1).as_deref(),
        Some("IDENTITY_A1"),
        "pinned identity must be unchanged after a rejected swap"
    );
}

#[tokio::test]
async fn same_identity_rotation_is_allowed() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    let res = srv
        .post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(1, "IDENTITY_A1", 1),
        )
        .await;
    assert_eq!(res.status(), 204);

    // Same identity key, NEW signed prekey — a legitimate prekey rotation.
    let res = srv
        .post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(1, "IDENTITY_A1", 2),
        )
        .await;
    assert_eq!(
        res.status(),
        204,
        "rotating the signed prekey must be allowed"
    );
}

#[tokio::test]
async fn removed_device_is_tombstoned_against_identity_substitution() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    // Publish, then remove device 5.
    assert_eq!(
        srv.post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(5, "K5a", 1)
        )
        .await
        .status(),
        204
    );
    assert_eq!(
        srv.delete_auth("/api/v1/users/@me/devices/5", &alice.token)
            .await
            .status(),
        204,
        "device removal should succeed"
    );

    // The device is gone from the directory...
    let list: Value = srv
        .get_auth(
            &format!("/api/v1/users/{}/identity-keys", alice.id),
            &alice.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        identity_for(&list, 5),
        None,
        "removed device should not be listed"
    );

    // ...but re-seizing slot 5 with a DIFFERENT identity is blocked by the tombstone.
    let res = srv
        .post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(5, "K5b_DIFFERENT", 1),
        )
        .await;
    assert_eq!(
        res.status(),
        409,
        "tombstone must block identity substitution"
    );

    // Re-registering slot 5 with the ORIGINAL identity is fine (legitimate re-add).
    let res = srv
        .post_json_auth(
            "/api/v1/signal/keys",
            &alice.token,
            publish_body(5, "K5a", 1),
        )
        .await;
    assert_eq!(
        res.status(),
        204,
        "re-adding with the original identity should succeed"
    );
}
