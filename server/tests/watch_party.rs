//! Watch party: a channel-synced video. The server holds the session (url, paused,
//! position, when that position was true) and only the member who started it may drive
//! or end it. Clients work out the live position from the session, so every session the
//! server sends carries the server's own clock (`server_time`) next to `updated_at`:
//! a device whose clock is wrong can then still land on the right second.

mod common;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};

/// A public address by IP literal, so the URL check needs no DNS lookup.
const VIDEO: &str = "https://1.1.1.1/video.mp4";

async fn text_channel_with_guest(srv: &TestServer, host: &AuthOk, guest: &AuthOk) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &host.token, json!({ "name": "Cinema" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &host.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    assert!(
        srv.post_json_auth(&format!("/api/v1/invites/{code}"), &guest.token, json!({}))
            .await
            .status()
            .is_success(),
        "guest joins the server"
    );
    server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "text")
        .expect("seeded text channel")["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn watch(channel_id: &str, action: &str, extra: Value) -> Value {
    let mut d = json!({ "channel_id": channel_id, "action": action });
    for (k, v) in extra.as_object().unwrap() {
        d[k] = v.clone();
    }
    json!({ "t": "WatchControl", "d": d })
}

fn server_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

#[tokio::test]
async fn a_watch_session_carries_the_servers_clock() {
    let srv = TestServer::start().await;
    let host = srv.register("watchhost", "password123").await;
    let guest = srv.register("watchguest", "password123").await;
    let channel_id = text_channel_with_guest(&srv, &host, &guest).await;

    let mut host_ws = Gateway::connect(&srv, &host.token).await;
    host_ws.wait_for(|e| e["t"] == "Ready").await;
    let mut guest_ws = Gateway::connect(&srv, &guest.token).await;
    guest_ws.wait_for(|e| e["t"] == "Ready").await;

    let before = server_now();
    host_ws
        .send(&watch(&channel_id, "set", json!({ "url": VIDEO })))
        .await;
    let update = guest_ws.wait_for(|e| e["t"] == "WatchUpdate").await;
    let after = server_now();

    let session = &update["d"]["session"];
    let server_time = session["server_time"]
        .as_f64()
        .expect("the session says what time the server thinks it is");
    assert!(
        (before - 1.0..=after + 1.0).contains(&server_time),
        "server_time {server_time} is the server's clock when it sent the session"
    );
    let updated_at = session["updated_at"].as_f64().unwrap();
    assert!(
        (before - 1.0..=server_time).contains(&updated_at),
        "updated_at {updated_at} is on the same clock, not after server_time {server_time}"
    );

    // The snapshot a client fetches when it opens the channel carries the clock too, read
    // at the time of the request.
    let snapshot: Value = srv
        .get_auth(
            &format!("/api/v1/channels/{channel_id}/watch"),
            &guest.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let snapshot_time = snapshot["server_time"]
        .as_f64()
        .expect("snapshot has server_time");
    assert!(
        snapshot_time >= server_time,
        "the snapshot's clock is read when it is served"
    );
    assert_eq!(snapshot["updated_at"].as_f64().unwrap(), updated_at);
}

#[tokio::test]
async fn play_keeps_sub_second_time_so_guests_do_not_start_up_to_a_second_off() {
    let srv = TestServer::start().await;
    let host = srv.register("precisehost", "password123").await;
    let guest = srv.register("preciseguest", "password123").await;
    let channel_id = text_channel_with_guest(&srv, &host, &guest).await;

    let mut host_ws = Gateway::connect(&srv, &host.token).await;
    host_ws.wait_for(|e| e["t"] == "Ready").await;

    // Several updates in a row: with whole-second timestamps every one would be integral.
    host_ws
        .send(&watch(&channel_id, "set", json!({ "url": VIDEO })))
        .await;
    let mut stamps = vec![
        host_ws.wait_for(|e| e["t"] == "WatchUpdate").await["d"]["session"]["updated_at"]
            .as_f64()
            .unwrap(),
    ];
    for position in [1.0, 2.0, 3.0, 4.0] {
        host_ws
            .send(&watch(&channel_id, "seek", json!({ "position": position })))
            .await;
        let e = host_ws
            .wait_for(|e| e["t"] == "WatchUpdate" && e["d"]["session"]["position"] == position)
            .await;
        stamps.push(e["d"]["session"]["updated_at"].as_f64().unwrap());
        tokio::time::sleep(std::time::Duration::from_millis(37)).await;
    }
    assert!(
        stamps.iter().any(|t| t.fract() != 0.0),
        "timestamps keep fractions of a second: {stamps:?}"
    );
    assert!(
        stamps.windows(2).all(|w| w[1] >= w[0]),
        "and never go backwards: {stamps:?}"
    );
}

#[tokio::test]
async fn only_the_host_drives_or_ends_the_party() {
    // Two gateways and many reads (each holds a 64 KiB buffer) make this test's future too
    // big for the test thread's stack in an unoptimised build, so it runs boxed.
    Box::pin(host_only_scenario()).await;
}

async fn host_only_scenario() {
    let srv = TestServer::start().await;
    let host = srv.register("drivinghost", "password123").await;
    let guest = srv.register("backseatguest", "password123").await;
    let channel_id = text_channel_with_guest(&srv, &host, &guest).await;

    let mut host_ws = Gateway::connect(&srv, &host.token).await;
    host_ws.wait_for(|e| e["t"] == "Ready").await;
    let mut guest_ws = Gateway::connect(&srv, &guest.token).await;
    guest_ws.wait_for(|e| e["t"] == "Ready").await;

    host_ws
        .send(&watch(&channel_id, "set", json!({ "url": VIDEO })))
        .await;
    host_ws.wait_for(|e| e["t"] == "WatchUpdate").await;
    host_ws
        .send(&watch(&channel_id, "play", json!({ "position": 5.0 })))
        .await;
    host_ws
        .wait_for(|e| e["t"] == "WatchUpdate" && e["d"]["session"]["paused"] == false)
        .await;

    // The guest tries to pause, seek and end it; then the host seeks. If the server had
    // obeyed the guest, the first update the host sees would be the guest's (paused, at
    // 99 s, or no session), not its own seek.
    guest_ws
        .send(&watch(&channel_id, "pause", json!({ "position": 99.0 })))
        .await;
    guest_ws
        .send(&watch(&channel_id, "seek", json!({ "position": 99.0 })))
        .await;
    guest_ws.send(&watch(&channel_id, "stop", json!({}))).await;
    // The server handles one connection's frames in order, so once it has answered this
    // heartbeat it has already dealt with the guest's three attempts above.
    guest_ws.send(&json!({ "t": "Heartbeat" })).await;
    guest_ws.wait_for(|e| e["t"] == "HeartbeatAck").await;
    host_ws
        .send(&watch(&channel_id, "seek", json!({ "position": 7.0 })))
        .await;
    let after = host_ws.wait_for(|e| e["t"] == "WatchUpdate").await;
    assert_eq!(
        after["d"]["session"]["position"], 7.0,
        "the next update is the host's seek, not anything the guest sent"
    );
    assert_eq!(
        after["d"]["session"]["paused"], false,
        "the guest's pause was ignored"
    );
    assert_eq!(after["d"]["session"]["host_id"], host.id);

    host_ws.send(&watch(&channel_id, "stop", json!({}))).await;
    let ended = guest_ws
        .wait_for(|e| e["t"] == "WatchUpdate" && e["d"]["session"].is_null())
        .await;
    assert!(
        ended["d"]["session"].is_null(),
        "the host ends it for everyone"
    );
}
