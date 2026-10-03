//! S-M10: removing a member (kick, ban, leave) must not leave state behind. Their roles
//! go with the membership, they drop out of the server's live voice rooms, and the
//! voice-key relay only delivers to recipients who can still see the channel.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};
use server::gateway::VoiceMember;
use server::types::{GatewayEvent, PublicUser};
use tokio::sync::broadcast;

const MANAGE_CHANNELS: i64 = 1 << 0;
const MANAGE_MESSAGES: i64 = 1 << 1;
const VIEW_CHANNEL: i64 = 1 << 6;

struct World {
    srv: TestServer,
    owner: AuthOk,
    server_id: String,
    voice_id: String,
    code: String,
}

async fn world() -> World {
    let srv = TestServer::start().await;
    let owner = srv.register("removalowner", "supersecret123").await;
    let server: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &owner.token,
            json!({ "name": "Removal" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let voice_id = server["channels"]
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
    let code = invite["code"].as_str().unwrap().to_owned();
    World {
        srv,
        owner,
        server_id,
        voice_id,
        code,
    }
}

async fn join_by_invite(w: &World, user: &AuthOk) {
    let res = w
        .srv
        .post_json_auth(
            &format!("/api/v1/invites/{}", w.code),
            &user.token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 200, "join by invite");
}

async fn join(w: &World, name: &str) -> AuthOk {
    let user = w.srv.register(name, "supersecret123").await;
    join_by_invite(w, &user).await;
    user
}

async fn my_permissions(w: &World, user: &AuthOk) -> i64 {
    let body: Value = w
        .srv
        .get_auth(
            &format!("/api/v1/servers/{}/me/permissions", w.server_id),
            &user.token,
        )
        .await
        .json()
        .await
        .unwrap();
    body["permissions"].as_i64().unwrap()
}

async fn member_roles(w: &World, user: &AuthOk) -> Value {
    w.srv
        .get_auth(
            &format!("/api/v1/servers/{}/members/{}/roles", w.server_id, user.id),
            &w.owner.token,
        )
        .await
        .json()
        .await
        .unwrap()
}

fn seat_in_voice(w: &World, user: &AuthOk, name: &str) {
    let member = VoiceMember {
        user: PublicUser {
            id: user.id.clone(),
            username: name.to_owned(),
            display_name: name.to_owned(),
            avatar_url: None,
        },
        muted: false,
        video: false,
        screen: false,
        listen_only: false,
    };
    w.srv
        .state
        .voice
        .write()
        .unwrap()
        .entry(w.voice_id.clone())
        .or_default()
        .insert(user.id.clone(), member);
}

fn in_voice(w: &World, user: &AuthOk) -> bool {
    w.srv
        .state
        .voice
        .read()
        .unwrap()
        .get(&w.voice_id)
        .is_some_and(|room| room.contains_key(&user.id))
}

/// Register a gateway session for `user` and return its receiving end.
fn listen(w: &World, user: &AuthOk) -> broadcast::Receiver<GatewayEvent> {
    let (tx, rx) = broadcast::channel(256);
    w.srv
        .state
        .sessions
        .write()
        .unwrap()
        .entry(user.id.clone())
        .or_default()
        .insert(u64::MAX, tx);
    rx
}

/// Everything already delivered to a session. Broadcasts happen before the handler
/// responds, so after an awaited request this is complete — no waiting involved.
fn drain(rx: &mut broadcast::Receiver<GatewayEvent>) -> Vec<Value> {
    let mut events = Vec::new();
    while let Ok(event) = rx.try_recv() {
        events.push(serde_json::to_value(&event).unwrap());
    }
    events
}

#[tokio::test]
async fn removed_members_rejoin_with_default_permissions() {
    let w = world().await;
    let role: Value = w
        .srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/roles", w.server_id),
            &w.owner.token,
            json!({ "name": "Mod", "permissions": MANAGE_CHANNELS | MANAGE_MESSAGES }),
        )
        .await
        .json()
        .await
        .unwrap();
    let role_id = role["id"].as_str().unwrap().to_owned();
    let control = join(&w, "removalcontrol").await;
    let default_permissions = my_permissions(&w, &control).await;

    for (name, path) in [
        ("removalkicked", "kick"),
        ("removalbanned", "ban"),
        ("removalleaver", "leave"),
    ] {
        let user = join(&w, name).await;
        let res = w
            .srv
            .put_json_auth(
                &format!(
                    "/api/v1/servers/{}/members/{}/roles/{role_id}",
                    w.server_id, user.id
                ),
                &w.owner.token,
                json!({}),
            )
            .await;
        assert_eq!(res.status(), 204);
        assert_ne!(my_permissions(&w, &user).await, default_permissions);

        let removed = match path {
            "kick" => {
                w.srv
                    .delete_auth(
                        &format!("/api/v1/servers/{}/members/{}", w.server_id, user.id),
                        &w.owner.token,
                    )
                    .await
            }
            "ban" => {
                let banned = w
                    .srv
                    .post_empty_auth(
                        &format!("/api/v1/servers/{}/bans/{}", w.server_id, user.id),
                        &w.owner.token,
                    )
                    .await;
                assert_eq!(banned.status(), 204);
                w.srv
                    .delete_auth(
                        &format!("/api/v1/servers/{}/bans/{}", w.server_id, user.id),
                        &w.owner.token,
                    )
                    .await
            }
            _ => {
                w.srv
                    .post_empty_auth(
                        &format!("/api/v1/servers/{}/leave", w.server_id),
                        &user.token,
                    )
                    .await
            }
        };
        assert_eq!(removed.status(), 204, "{path} succeeds");

        join_by_invite(&w, &user).await;
        assert_eq!(
            my_permissions(&w, &user).await,
            default_permissions,
            "after {path} and rejoin, permissions are the default member's"
        );
        assert_eq!(
            member_roles(&w, &user).await,
            json!([]),
            "{path} clears roles"
        );
    }
}

#[tokio::test]
async fn removed_members_are_evicted_from_the_servers_voice_rooms() {
    let w = world().await;
    let kicked = join(&w, "voicekicked").await;
    let leaver = join(&w, "voiceleaver").await;
    seat_in_voice(&w, &w.owner, "removalowner");
    seat_in_voice(&w, &kicked, "voicekicked");
    seat_in_voice(&w, &leaver, "voiceleaver");
    let mut owner_rx = listen(&w, &w.owner);

    let res = w
        .srv
        .delete_auth(
            &format!("/api/v1/servers/{}/members/{}", w.server_id, kicked.id),
            &w.owner.token,
        )
        .await;
    assert_eq!(res.status(), 204);
    let res = w
        .srv
        .post_empty_auth(
            &format!("/api/v1/servers/{}/leave", w.server_id),
            &leaver.token,
        )
        .await;
    assert_eq!(res.status(), 204);

    assert!(!in_voice(&w, &kicked), "kicked member left the voice room");
    assert!(
        !in_voice(&w, &leaver),
        "departed member left the voice room"
    );
    assert!(in_voice(&w, &w.owner), "everyone else stays");

    let left: Vec<Value> = drain(&mut owner_rx)
        .into_iter()
        .filter(|ev| ev["t"] == "VoiceState" && ev["d"]["joined"] == false)
        .collect();
    for user in [&kicked, &leaver] {
        assert!(
            left.iter().any(|ev| ev["d"]["user_id"] == user.id.as_str()
                && ev["d"]["channel_id"] == w.voice_id.as_str()),
            "peers are told {} left the call",
            user.id
        );
    }
}

#[tokio::test]
async fn voice_keys_only_reach_recipients_who_can_view_the_channel() {
    let w = world().await;
    let locked_out = join(&w, "voicelockedout").await;
    let still_in = join(&w, "voicestillin").await;
    for (user, name) in [
        (&w.owner, "removalowner"),
        (&locked_out, "voicelockedout"),
        (&still_in, "voicestillin"),
    ] {
        seat_in_voice(&w, user, name);
    }
    let mut locked_out_rx = listen(&w, &locked_out);
    let mut still_in_rx = listen(&w, &still_in);

    // Locked out of the voice channel after joining the call.
    let db = sqlx::SqlitePool::connect(w.srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_voice', ?, 'channel', ?, 'member', ?, 0, ?, 'test', 1)",
    )
    .bind(&w.server_id)
    .bind(&w.voice_id)
    .bind(&locked_out.id)
    .bind(VIEW_CHANNEL)
    .execute(&db)
    .await
    .unwrap();

    let res = w
        .srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/voice-key", w.voice_id),
            &w.owner.token,
            json!({ "envelopes": { locked_out.id.clone(): "k1", still_in.id.clone(): "k2" } }),
        )
        .await;
    assert_eq!(res.status(), 204);

    let is_key = |ev: &Value| ev["t"] == "VoiceKeyDistribution";
    assert!(
        drain(&mut still_in_rx).iter().any(is_key),
        "a recipient who can view the channel gets the key"
    );
    assert!(
        !drain(&mut locked_out_rx).iter().any(is_key),
        "a recipient who lost View Channel must not get the key"
    );
}
