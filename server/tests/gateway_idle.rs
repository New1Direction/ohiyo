//! A half-open gateway socket must not hold its session forever: a live session entry
//! keeps the dead-man's switch from firing (S-H5), so a connection that sends no frame
//! for three client heartbeats is closed, and the normal disconnect cleanup runs. The
//! tests shorten the timeout instead of waiting out the production one.

mod common;

use std::time::Duration;

use common::{ws::Gateway, TestServer};
use serde_json::json;

const SHORT_IDLE: Duration = Duration::from_millis(400);

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
async fn heartbeats_keep_a_socket_open() {
    let srv = start().await;
    let alice = srv.register("chatty", "password123").await;
    let mut gw = Gateway::connect(&srv, &alice.token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;

    // Four idle periods' worth of time, never silent for more than a quarter of one.
    for _ in 0..16 {
        gw.send(&json!({ "t": "Heartbeat" })).await;
        tokio::time::sleep(SHORT_IDLE / 4).await;
    }

    assert!(
        srv.state.sessions.read().unwrap().contains_key(&alice.id),
        "a socket that keeps sending stays open"
    );
}
