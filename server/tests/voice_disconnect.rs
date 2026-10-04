//! S-H5: a user can be connected from several devices, and only one of them is in a
//! call. When a connection closes (idle, network loss or a normal close), the user leaves
//! a voice room only if that connection is the one that joined it, so a second device
//! going to sleep never drops the call running on the first.

mod common;

use std::time::Duration;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};

async fn voice_channel(srv: &TestServer, owner: &AuthOk) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Calls" }))
        .await
        .json()
        .await
        .unwrap();
    server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "voice")
        .expect("seeded voice channel")["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn in_voice(srv: &TestServer, channel_id: &str, user: &AuthOk) -> bool {
    srv.state
        .voice
        .read()
        .unwrap()
        .get(channel_id)
        .is_some_and(|room| room.contains_key(&user.id))
}

/// Wait until the user holds `n` live connections. A closing socket leaves voice before
/// it unregisters, so once the count drops that socket's voice cleanup has finished.
async fn wait_for_connections(srv: &TestServer, user: &AuthOk, n: usize) {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let live = srv
                .state
                .sessions
                .read()
                .unwrap()
                .get(&user.id)
                .map_or(0, |conns| conns.len());
            if live == n {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the closed socket was never unregistered");
}

#[tokio::test]
async fn only_the_connection_that_joined_a_call_takes_the_user_out_when_it_closes() {
    let srv = TestServer::start().await;
    let alice = srv.register("twodevices", "password123").await;
    let channel_id = voice_channel(&srv, &alice).await;

    let mut in_call = Gateway::connect(&srv, &alice.token).await;
    in_call.wait_for(|e| e["t"] == "Ready").await;
    let mut other_device = Gateway::connect(&srv, &alice.token).await;
    other_device.wait_for(|e| e["t"] == "Ready").await;

    in_call
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": channel_id } }))
        .await;
    in_call.wait_for(|e| e["t"] == "VoiceRoster").await;
    assert!(in_voice(&srv, &channel_id, &alice));

    drop(other_device);
    wait_for_connections(&srv, &alice, 1).await;
    assert!(
        in_voice(&srv, &channel_id, &alice),
        "another device closing leaves the call alone"
    );

    drop(in_call);
    wait_for_connections(&srv, &alice, 0).await;
    assert!(
        !in_voice(&srv, &channel_id, &alice),
        "the joining connection closing takes the user out of the call"
    );
}

/// Reconnecting during a call: the new connection joins the room the user already sits
/// in. The latest join holds the seat, so the old connection closing later (say after
/// the idle limit) leaves the call alone, and nobody else is told about a second join.
#[tokio::test]
async fn a_join_from_another_connection_moves_the_seat_without_a_second_announcement() {
    // Three gateways and many reads (each holds a 64 KiB buffer) make this test's future
    // too big for the test thread's stack in an unoptimised build, so it runs boxed.
    Box::pin(rejoin_scenario()).await;
}

async fn rejoin_scenario() {
    let srv = TestServer::start().await;
    let alice = srv.register("rejoiner", "password123").await;
    let watcher = srv.register("watcher", "password123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Rejoin" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let channel_id = server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "voice")
        .expect("seeded voice channel")["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &alice.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    assert_eq!(
        srv.post_json_auth(
            &format!("/api/v1/invites/{code}"),
            &watcher.token,
            json!({})
        )
        .await
        .status(),
        200
    );

    let mut old = Gateway::connect(&srv, &alice.token).await;
    old.wait_for(|e| e["t"] == "Ready").await;
    let mut new = Gateway::connect(&srv, &alice.token).await;
    new.wait_for(|e| e["t"] == "Ready").await;
    let mut watching = Gateway::connect(&srv, &watcher.token).await;
    watching.wait_for(|e| e["t"] == "Ready").await;

    let join = json!({ "t": "JoinVoice", "d": { "channel_id": channel_id } });
    old.send(&join).await;
    old.wait_for(|e| e["t"] == "VoiceRoster").await;
    watching
        .wait_for(|e| e["t"] == "VoiceState" && e["d"]["user_id"] == alice.id.as_str())
        .await;

    new.send(&join).await;
    // Events reach a connection in order, so a second announcement of the join would
    // arrive before the echo of this later activity change.
    new.send(&json!({
        "t": "SetActivity",
        "d": { "activity": { "kind": "playing", "name": "rejoined", "details": null } }
    }))
    .await;
    loop {
        let event = watching.next_event().await;
        assert!(
            !(event["t"] == "VoiceState" && event["d"]["user_id"] == alice.id.as_str()),
            "the move is not announced: {event}"
        );
        if event["t"] == "PresenceUpdate" && event["d"]["activity"]["name"] == "rejoined" {
            break;
        }
    }

    drop(old);
    wait_for_connections(&srv, &alice, 1).await;
    assert!(
        in_voice(&srv, &channel_id, &alice),
        "the old connection closing leaves the rejoined call alone"
    );

    drop(new);
    wait_for_connections(&srv, &alice, 0).await;
    assert!(
        !in_voice(&srv, &channel_id, &alice),
        "the connection holding the seat closing takes the user out"
    );
}
