//! A connection whose queue overflows (1024 events: a phone tab in the background, a
//! slow network) used to drop what it missed and carry on, so that person never saw
//! those messages until they reloaded. It is now sent a fresh Ready, which the app treats
//! like a reconnect: it refreshes its lists and catches the open chat up. The socket
//! stays open, so a call in progress isn't dropped.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::json;
use server::types::GatewayEvent;

#[tokio::test]
async fn a_connection_that_falls_behind_is_sent_a_fresh_ready() {
    let srv = TestServer::start().await;
    let alice = srv.register("lagalice", "supersecret123").await;
    let mut gw = Gateway::connect(&srv, &alice.token).await;
    gw.wait_for(|ev| ev["t"] == "Ready").await;

    // More events than the connection's queue holds, sent without yielding, so the
    // connection can't keep up.
    let senders: Vec<_> = srv
        .state
        .sessions
        .read()
        .unwrap()
        .get(&alice.id)
        .expect("alice is connected")
        .values()
        .cloned()
        .collect();
    for i in 0..1500 {
        for tx in &senders {
            let _ = tx.send(GatewayEvent::MessageDelete {
                id: format!("gone-{i}"),
                channel_id: "somewhere".into(),
            });
        }
    }

    let ready = gw.wait_for(|ev| ev["t"] == "Ready").await;
    assert_eq!(ready["d"]["user"]["id"], json!(alice.id));
}
