//! A half-open gateway socket must not hold its session forever: a live session entry
//! keeps the dead-man's switch from firing (S-H5), so a connection that sends no frame
//! for the idle limit is closed, and the normal disconnect cleanup runs. The tests run
//! the production timings scaled down 200 times instead of waiting them out.

mod common;

use std::time::Duration;

use common::{ws::Gateway, TestServer};
use serde_json::json;

/// The 150 s production idle limit, scaled down.
const SHORT_IDLE: Duration = Duration::from_millis(750);

/// A long-hidden browser tab's heartbeat, about once a minute, scaled down the same way.
const THROTTLED_HEARTBEAT: Duration = Duration::from_millis(300);

async fn start() -> TestServer {
    TestServer::start_with(|state| state.gateway_idle_timeout = SHORT_IDLE).await
}

#[tokio::test]
async fn a_silent_socket_is_closed_and_its_session_cleaned_up() {
    let srv = start().await;
    let alice = srv.register("silent", "password123").await;
    let mut gw = Gateway::connect(&srv, &alice.token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;

    gw.wait_closed().await;

    assert!(
        !srv.state.sessions.read().unwrap().contains_key(&alice.id),
        "the session entry is gone, so the dead-man's switch can fire again"
    );
}

#[tokio::test]
async fn throttled_background_heartbeats_keep_a_socket_open() {
    let srv = start().await;
    let alice = srv.register("chatty", "password123").await;
    let mut gw = Gateway::connect(&srv, &alice.token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;

    // Over three idle periods, heartbeating only as often as a throttled tab does.
    for _ in 0..8 {
        gw.send(&json!({ "t": "Heartbeat" })).await;
        tokio::time::sleep(THROTTLED_HEARTBEAT).await;
    }

    assert!(
        srv.state.sessions.read().unwrap().contains_key(&alice.id),
        "a socket that keeps sending stays open"
    );
}

/// The client treats 40 s without any inbound frame as a dead socket, so a quiet but
/// healthy connection needs a reply to its heartbeat. The ack goes to the heartbeating
/// connection only, not to the user's other devices.
#[tokio::test]
async fn each_heartbeat_is_acknowledged_on_its_own_connection() {
    let srv = TestServer::start().await;
    let alice = srv.register("acked", "password123").await;
    // Presence echoes go to people sharing a server, so Alice needs one.
    srv.post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Acks" }))
        .await;
    let mut heartbeating = Gateway::connect(&srv, &alice.token).await;
    heartbeating.wait_for(|e| e["t"] == "Ready").await;
    let mut other = Gateway::connect(&srv, &alice.token).await;
    other.wait_for(|e| e["t"] == "Ready").await;

    heartbeating.send(&json!({ "t": "Heartbeat" })).await;
    heartbeating.wait_for(|e| e["t"] == "HeartbeatAck").await;

    // Events reach a connection in order, so an ack sent to `other` would arrive before
    // the echo of this later activity change.
    other
        .send(&json!({
            "t": "SetActivity",
            "d": { "activity": { "kind": "playing", "name": "marker", "details": null } }
        }))
        .await;
    loop {
        let event = other.next_event().await;
        assert_ne!(event["t"], "HeartbeatAck", "the ack went to another device");
        if event["t"] == "PresenceUpdate" && event["d"]["activity"]["name"] == "marker" {
            break;
        }
    }
}
