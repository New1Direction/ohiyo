//! Calls in DMs and group chats, like Discord: calling rings the other people on every
//! device they're signed in on, answering stops the ring, and the chat keeps a call log
//! ("Call ended · 12m 03s", "Missed call", "declined"). Only the chat's own people can
//! call or join, a blocked person can't ring you, and a group call has a seat limit.

mod common;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};

async fn open_dm(srv: &TestServer, a: &AuthOk, b: &AuthOk) -> String {
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &a.token,
            json!({ "recipient_id": b.id }),
        )
        .await;
    assert_eq!(res.status(), 200);
    res.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn open_group(srv: &TestServer, owner: &AuthOk, others: &[&AuthOk]) -> String {
    let ids: Vec<&str> = others.iter().map(|u| u.id.as_str()).collect();
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/group-dms",
            &owner.token,
            json!({ "recipient_ids": ids, "name": "call group" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    res.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn start_call(srv: &TestServer, who: &AuthOk, channel: &str) -> reqwest::Response {
    srv.post_json_auth(
        &format!("/api/v1/channels/{channel}/call"),
        &who.token,
        json!({ "video": false }),
    )
    .await
}

async fn ready(srv: &TestServer, who: &AuthOk) -> Gateway {
    let mut gw = Box::pin(Gateway::connect(srv, &who.token)).await;
    next(&mut gw, |e| e["t"] == "Ready").await;
    gw
}

fn ring_in(channel: &str) -> impl Fn(&Value) -> bool + '_ {
    move |e: &Value| e["t"] == "CallRing" && e["d"]["channel_id"] == channel
}

fn ring_stop_in<'a>(channel: &'a str, reason: &'a str) -> impl Fn(&Value) -> bool + 'a {
    move |e: &Value| {
        e["t"] == "CallRingStop" && e["d"]["channel_id"] == channel && e["d"]["reason"] == reason
    }
}

fn call_log_in<'a>(channel: &'a str, state: &'a str) -> impl Fn(&Value) -> bool + 'a {
    move |e: &Value| {
        (e["t"] == "MessageCreate" || e["t"] == "MessageUpdate")
            && e["d"]["channel_id"] == channel
            && e["d"]["call"]["state"] == state
    }
}

/// Reads the next matching event through a box. Each `wait_for` holds a 64 KiB buffer, and these
/// scenarios wait often enough that unboxed reads overflow the test thread's stack in a debug build.
async fn next(gw: &mut Gateway, pred: impl Fn(&Value) -> bool) -> Value {
    Box::pin(gw.wait_for(pred)).await
}

async fn join_voice(gw: &mut Gateway, channel: &str) {
    gw.send(&json!({ "t": "JoinVoice", "d": { "channel_id": channel } }))
        .await;
}

#[tokio::test]
async fn calling_rings_every_device_of_the_other_person() {
    Box::pin(rings_every_device()).await;
}

async fn rings_every_device() {
    let srv = TestServer::start().await;
    let alice = srv.register("ringalice", "password123").await;
    let bob = srv.register("ringbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;

    let mut bob_phone = ready(&srv, &bob).await;
    let mut bob_laptop = ready(&srv, &bob).await;
    let mut alice_gw = ready(&srv, &alice).await;

    let res = start_call(&srv, &alice, &dm).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["ringing"], json!([bob.id]), "{body}");

    for gw in [&mut bob_phone, &mut bob_laptop] {
        let ring = next(gw, ring_in(&dm)).await;
        assert_eq!(ring["d"]["caller"]["id"], alice.id.as_str(), "{ring}");
        assert_eq!(ring["d"]["video"], false, "{ring}");
        assert!(ring["d"]["message_id"].is_string(), "{ring}");
    }

    // The chat gets a call log message, written by the caller.
    let log = next(&mut alice_gw, call_log_in(&dm, "ringing")).await;
    assert_eq!(log["d"]["author"]["id"], alice.id.as_str(), "{log}");
}

#[tokio::test]
async fn answering_stops_the_ring_and_hanging_up_logs_how_long_it_lasted() {
    Box::pin(answer_and_hang_up()).await;
}

async fn answer_and_hang_up() {
    let srv = TestServer::start().await;
    let alice = srv.register("answeralice", "password123").await;
    let bob = srv.register("answerbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;

    let mut bob_phone = ready(&srv, &bob).await;
    let mut bob_laptop = ready(&srv, &bob).await;
    let mut alice_gw = ready(&srv, &alice).await;

    join_voice(&mut alice_gw, &dm).await;
    next(&mut alice_gw, |e| e["t"] == "VoiceRoster").await;
    assert_eq!(start_call(&srv, &alice, &dm).await.status(), 200);
    next(&mut bob_phone, ring_in(&dm)).await;
    next(&mut bob_laptop, ring_in(&dm)).await;

    // Bob answers on his phone; his laptop stops ringing.
    join_voice(&mut bob_phone, &dm).await;
    next(&mut bob_laptop, ring_stop_in(&dm, "answered")).await;
    next(&mut alice_gw, call_log_in(&dm, "ongoing")).await;

    // Both hang up: the log says the call ended and how long it lasted.
    bob_phone
        .send(&json!({ "t": "LeaveVoice", "d": { "channel_id": dm } }))
        .await;
    alice_gw
        .send(&json!({ "t": "LeaveVoice", "d": { "channel_id": dm } }))
        .await;
    let ended = next(&mut alice_gw, call_log_in(&dm, "ended")).await;
    assert!(
        ended["d"]["call"]["duration_secs"]
            .as_i64()
            .is_some_and(|s| s >= 0),
        "{ended}"
    );

    let history: Value = srv
        .get_auth(&format!("/api/v1/channels/{dm}/messages"), &bob.token)
        .await
        .json()
        .await
        .unwrap();
    let last = history.as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["call"]["state"], "ended", "{last}");
}

#[tokio::test]
async fn a_blocked_person_cannot_ring_you() {
    let srv = TestServer::start().await;
    let alice = srv.register("blockedcaller", "password123").await;
    let bob = srv.register("blockingcallee", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    assert_eq!(
        srv.post_empty_auth(&format!("/api/v1/users/{}/block", alice.id), &bob.token)
            .await
            .status(),
        204
    );

    assert_eq!(start_call(&srv, &alice, &dm).await.status(), 403);
    let history: Value = srv
        .get_auth(&format!("/api/v1/channels/{dm}/messages"), &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(
        history
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["call"].is_null()),
        "no call log for a refused call: {history}"
    );
}

#[tokio::test]
async fn only_the_chats_own_people_can_call_it_and_spaces_use_voice_channels() {
    let srv = TestServer::start().await;
    let alice = srv.register("ownalice", "password123").await;
    let bob = srv.register("ownbob", "password123").await;
    let carol = srv.register("owncarol", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;

    assert_eq!(start_call(&srv, &carol, &dm).await.status(), 404);
    assert_eq!(
        srv.post_empty_auth(&format!("/api/v1/channels/{dm}/call/decline"), &carol.token)
            .await
            .status(),
        404
    );

    let server: Value = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Space" }))
        .await
        .json()
        .await
        .unwrap();
    let text = server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(start_call(&srv, &alice, &text).await.status(), 400);
}

#[tokio::test]
async fn an_unanswered_call_becomes_a_missed_call() {
    Box::pin(unanswered()).await;
}

async fn unanswered() {
    let srv = TestServer::start_with(|s| s.call_ring_secs = 1).await;
    let alice = srv.register("missalice", "password123").await;
    let bob = srv.register("missbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    let mut bob_gw = ready(&srv, &bob).await;
    let mut alice_gw = ready(&srv, &alice).await;

    join_voice(&mut alice_gw, &dm).await;
    next(&mut alice_gw, |e| e["t"] == "VoiceRoster").await;
    assert_eq!(start_call(&srv, &alice, &dm).await.status(), 200);
    next(&mut bob_gw, ring_in(&dm)).await;

    next(&mut bob_gw, ring_stop_in(&dm, "missed")).await;
    let ended = next(&mut alice_gw, |e| {
        e["t"] == "CallEnded" && e["d"]["channel_id"] == dm.as_str()
    })
    .await;
    assert_eq!(ended["d"]["outcome"], "missed", "{ended}");
    next(&mut bob_gw, call_log_in(&dm, "missed")).await;
}

#[tokio::test]
async fn declining_ends_a_one_to_one_call() {
    Box::pin(declined()).await;
}

async fn declined() {
    let srv = TestServer::start().await;
    let alice = srv.register("declinealice", "password123").await;
    let bob = srv.register("declinebob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    let mut bob_gw = ready(&srv, &bob).await;
    let mut alice_gw = ready(&srv, &alice).await;

    join_voice(&mut alice_gw, &dm).await;
    next(&mut alice_gw, |e| e["t"] == "VoiceRoster").await;
    assert_eq!(start_call(&srv, &alice, &dm).await.status(), 200);
    next(&mut bob_gw, ring_in(&dm)).await;

    assert_eq!(
        srv.post_empty_auth(&format!("/api/v1/channels/{dm}/call/decline"), &bob.token)
            .await
            .status(),
        204
    );
    next(&mut bob_gw, ring_stop_in(&dm, "declined")).await;
    let ended = next(&mut alice_gw, |e| {
        e["t"] == "CallEnded" && e["d"]["channel_id"] == dm.as_str()
    })
    .await;
    assert_eq!(ended["d"]["outcome"], "declined", "{ended}");
    let log = next(&mut alice_gw, call_log_in(&dm, "declined")).await;
    assert_eq!(log["d"]["call"]["declined_by"], bob.id.as_str(), "{log}");
}

#[tokio::test]
async fn hanging_up_before_anyone_answers_is_a_missed_call() {
    Box::pin(cancelled()).await;
}

async fn cancelled() {
    let srv = TestServer::start().await;
    let alice = srv.register("cancelalice", "password123").await;
    let bob = srv.register("cancelbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    let mut bob_gw = ready(&srv, &bob).await;
    let mut alice_gw = ready(&srv, &alice).await;

    join_voice(&mut alice_gw, &dm).await;
    next(&mut alice_gw, |e| e["t"] == "VoiceRoster").await;
    assert_eq!(start_call(&srv, &alice, &dm).await.status(), 200);
    next(&mut bob_gw, ring_in(&dm)).await;

    alice_gw
        .send(&json!({ "t": "LeaveVoice", "d": { "channel_id": dm } }))
        .await;
    next(&mut bob_gw, ring_stop_in(&dm, "cancelled")).await;
    next(&mut bob_gw, call_log_in(&dm, "missed")).await;
}

#[tokio::test]
async fn a_group_call_has_a_seat_limit() {
    Box::pin(seat_limit()).await;
}

async fn seat_limit() {
    let srv = TestServer::start_with(|s| s.dm_call_cap = 2).await;
    let alice = srv.register("seatalice", "password123").await;
    let bob = srv.register("seatbob", "password123").await;
    let carol = srv.register("seatcarol", "password123").await;
    let group = open_group(&srv, &alice, &[&bob, &carol]).await;
    let mut alice_gw = ready(&srv, &alice).await;
    let mut bob_gw = ready(&srv, &bob).await;
    let mut carol_gw = ready(&srv, &carol).await;

    join_voice(&mut alice_gw, &group).await;
    next(&mut alice_gw, |e| e["t"] == "VoiceRoster").await;
    join_voice(&mut bob_gw, &group).await;
    next(&mut bob_gw, |e| e["t"] == "VoiceRoster").await;

    join_voice(&mut carol_gw, &group).await;
    let refused = next(&mut carol_gw, |e| {
        e["t"] == "VoiceRefused" || e["t"] == "VoiceRoster"
    })
    .await;
    assert_eq!(refused["t"], "VoiceRefused", "{refused}");
    assert_eq!(refused["d"]["channel_id"], group.as_str(), "{refused}");
}

#[tokio::test]
async fn a_call_log_cannot_be_edited_or_replied_to() {
    let srv = TestServer::start().await;
    let alice = srv.register("logalice", "password123").await;
    let bob = srv.register("logbob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    let started: Value = start_call(&srv, &alice, &dm).await.json().await.unwrap();
    let message_id = started["message_id"]
        .as_str()
        .expect("message id")
        .to_owned();

    let edit = srv
        .patch_json_auth(
            &format!("/api/v1/channels/{dm}/messages/{message_id}"),
            &alice.token,
            json!({ "content": "rewritten history" }),
        )
        .await;
    assert_eq!(edit.status(), 400);

    let reply = srv
        .post_json_auth(
            &format!("/api/v1/channels/{dm}/messages"),
            &bob.token,
            json!({ "content": "about that call", "reply_to": message_id }),
        )
        .await;
    assert_eq!(reply.status(), 400);
}

#[tokio::test]
async fn someone_who_connects_while_a_call_rings_still_hears_it() {
    Box::pin(late_ring()).await;
}

async fn late_ring() {
    let srv = TestServer::start().await;
    let alice = srv.register("latealice", "password123").await;
    let bob = srv.register("latebob", "password123").await;
    let dm = open_dm(&srv, &alice, &bob).await;
    assert_eq!(start_call(&srv, &alice, &dm).await.status(), 200);

    let mut bob_gw = Box::pin(Gateway::connect(&srv, &bob.token)).await;
    let ring = next(&mut bob_gw, ring_in(&dm)).await;
    assert_eq!(ring["d"]["caller"]["id"], alice.id.as_str(), "{ring}");
}
