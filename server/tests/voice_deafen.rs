//! Deafen travels with voice state, like Discord: everyone in (or looking at) a voice channel
//! sees who is deafened, a deafened person always counts as muted, and apps that don't know
//! about deafen keep working.

mod common;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};

/// A space with its seeded voice channel, and a second member invited in.
async fn space_with_two(srv: &TestServer, owner: &AuthOk, member: &AuthOk) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Calls" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let voice = server["channels"]
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
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    assert_eq!(
        srv.post_json_auth(&format!("/api/v1/invites/{code}"), &member.token, json!({}))
            .await
            .status(),
        200
    );
    voice
}

fn voice_state_of<'a>(user: &'a AuthOk) -> impl Fn(&Value) -> bool + 'a {
    move |e: &Value| {
        e["t"] == "VoiceState" && e["d"]["user_id"] == user.id.as_str() && e["d"]["joined"] == true
    }
}

#[tokio::test]
async fn deafen_reaches_everyone_and_always_counts_as_muted() {
    let srv = TestServer::start().await;
    let alice = srv.register("deafalice", "password123").await;
    let bob = srv.register("deafbob", "password123").await;
    let voice = space_with_two(&srv, &alice, &bob).await;

    let mut bob_gw = Gateway::connect(&srv, &bob.token).await;
    bob_gw.wait_for(|e| e["t"] == "Ready").await;
    let mut alice_gw = Gateway::connect(&srv, &alice.token).await;
    alice_gw.wait_for(|e| e["t"] == "Ready").await;

    alice_gw
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": voice } }))
        .await;
    alice_gw.wait_for(|e| e["t"] == "VoiceRoster").await;
    let joined = bob_gw.wait_for(voice_state_of(&alice)).await;
    assert_eq!(joined["d"]["deafened"], false, "{joined}");

    // Alice deafens. Her app says she is unmuted, but a deafened person is muted.
    alice_gw
        .send(&json!({ "t": "VoiceMeta", "d": {
            "channel_id": voice, "muted": false, "video": false, "screen": false, "deafened": true
        } }))
        .await;
    let deaf = bob_gw
        .wait_for(|e| voice_state_of(&alice)(e) && e["d"]["deafened"] == true)
        .await;
    assert_eq!(deaf["d"]["muted"], true, "deafened implies muted: {deaf}");

    // Bob joins and the roster he gets already shows her deafened.
    bob_gw
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": voice } }))
        .await;
    let roster = bob_gw.wait_for(|e| e["t"] == "VoiceRoster").await;
    let peer = roster["d"]["peers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["user_id"] == alice.id.as_str())
        .expect("alice in the roster")
        .clone();
    assert_eq!(peer["deafened"], true, "{peer}");
    assert_eq!(peer["muted"], true, "{peer}");

    // Undeafening is announced too.
    alice_gw
        .send(&json!({ "t": "VoiceMeta", "d": {
            "channel_id": voice, "muted": false, "video": false, "screen": false, "deafened": false
        } }))
        .await;
    let back = bob_gw
        .wait_for(|e| voice_state_of(&alice)(e) && e["d"]["deafened"] == false)
        .await;
    assert_eq!(back["d"]["muted"], false, "{back}");
}

#[tokio::test]
async fn joining_deafened_is_announced_as_deafened() {
    let srv = TestServer::start().await;
    let alice = srv.register("deafjoina", "password123").await;
    let bob = srv.register("deafjoinb", "password123").await;
    let voice = space_with_two(&srv, &alice, &bob).await;

    let mut bob_gw = Gateway::connect(&srv, &bob.token).await;
    bob_gw.wait_for(|e| e["t"] == "Ready").await;
    let mut alice_gw = Gateway::connect(&srv, &alice.token).await;
    alice_gw.wait_for(|e| e["t"] == "Ready").await;

    alice_gw
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": voice, "deafened": true } }))
        .await;
    let joined = bob_gw.wait_for(voice_state_of(&alice)).await;
    assert_eq!(joined["d"]["deafened"], true, "{joined}");
    assert_eq!(joined["d"]["muted"], true, "{joined}");
}

#[tokio::test]
async fn an_app_that_never_mentions_deafen_still_works() {
    let srv = TestServer::start().await;
    let alice = srv.register("olderapp", "password123").await;
    let bob = srv.register("olderpeer", "password123").await;
    let voice = space_with_two(&srv, &alice, &bob).await;

    let mut bob_gw = Gateway::connect(&srv, &bob.token).await;
    bob_gw.wait_for(|e| e["t"] == "Ready").await;
    let mut alice_gw = Gateway::connect(&srv, &alice.token).await;
    alice_gw.wait_for(|e| e["t"] == "Ready").await;

    alice_gw
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": voice } }))
        .await;
    bob_gw.wait_for(voice_state_of(&alice)).await;
    // An older app's VoiceMeta has no "deafened" field.
    alice_gw
        .send(&json!({ "t": "VoiceMeta", "d": {
            "channel_id": voice, "muted": true, "video": false, "screen": false
        } }))
        .await;
    let muted = bob_gw
        .wait_for(|e| voice_state_of(&alice)(e) && e["d"]["muted"] == true)
        .await;
    assert_eq!(muted["d"]["deafened"], false, "{muted}");
}
