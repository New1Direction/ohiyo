//! Some client events go out to everyone who can see the sender: presence, activity,
//! voice state, watch-party controls. People change these at human speed, so each is
//! limited per account; a client flooding them could otherwise fill every co-member's
//! queue and push real messages out. The same goes for relaying group sender keys.

mod common;

use std::time::Duration;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};

#[tokio::test]
async fn a_client_flooding_activity_changes_is_slowed_down() {
    let srv = TestServer::start().await;
    let alice = srv.register("floodalice", "supersecret123").await;
    // Presence goes to the people who share a space with you, alice included.
    let res = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Flood" }))
        .await;
    assert_eq!(res.status(), 200);
    let mut gw = Gateway::connect(&srv, &alice.token).await;
    gw.wait_for(|ev| ev["t"] == "Ready").await;

    for i in 0..50 {
        gw.send(&json!({
            "t": "SetActivity",
            "d": { "activity": { "kind": "playing", "name": format!("flood-{i}"), "details": null } }
        }))
        .await;
    }
    // Count the changes that went out (each comes back to alice too) until it's quiet.
    let mut went_out = 0;
    while let Ok(ev) = tokio::time::timeout(Duration::from_millis(1500), gw.next_event()).await {
        let name = ev["d"]["activity"]["name"].as_str().unwrap_or_default();
        if ev["t"] == "PresenceUpdate" && name.starts_with("flood-") {
            went_out += 1;
        }
    }
    assert!(went_out > 0, "a change still goes out");
    assert!(went_out <= 10, "{went_out} of 50 changes went out");
}

#[tokio::test]
async fn relaying_sender_keys_in_a_loop_is_slowed_down() {
    let srv = TestServer::start().await;
    let alice = srv.register("keyfloodalice", "supersecret123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Flood" }))
        .await
        .json()
        .await
        .unwrap();
    let channel = server["channels"][0]["id"].as_str().unwrap().to_owned();
    let path = format!("/api/v1/channels/{channel}/sender-key");

    let mut statuses = Vec::new();
    for _ in 0..140 {
        statuses.push(
            srv.post_json_auth(&path, &alice.token, json!({ "envelopes": {} }))
                .await
                .status(),
        );
    }
    assert_ne!(statuses[0], reqwest::StatusCode::TOO_MANY_REQUESTS);
    assert!(
        statuses.contains(&reqwest::StatusCode::TOO_MANY_REQUESTS),
        "140 relays in a row must hit the limit"
    );
}
