//! Small rules found after the big features landed: a time out by someone without the
//! permission is a plain 403 whoever the target is; a call log can't be reacted to, pinned or
//! deleted (it's the record of a call); a thread is as slow as its channel's slowmode; and the
//! app can ask whom it may act on, so it doesn't offer Time out on people who outrank you.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

const PASS: &str = "followups-pass-1";
const MODERATE_MEMBERS: i64 = 1 << 9;

struct Space {
    id: String,
    general: String,
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> Space {
    let body: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    let general = body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    Space {
        id: body["id"].as_str().unwrap().to_owned(),
        general,
    }
}

async fn join(srv: &TestServer, inviter: &AuthOk, server_id: &str, who: &AuthOk) {
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &inviter.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &who.token, json!({}))
        .await;
    assert_eq!(res.status(), 200, "join");
}

async fn give_role(
    srv: &TestServer,
    owner: &AuthOk,
    server_id: &str,
    who: &AuthOk,
    permissions: i64,
) {
    let role: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/roles"),
            &owner.token,
            json!({ "name": "Mods", "permissions": permissions }),
        )
        .await
        .json()
        .await
        .unwrap();
    let res = srv
        .put_json_auth(
            &format!(
                "/api/v1/servers/{server_id}/members/{}/roles/{}",
                who.id,
                role["id"].as_str().unwrap()
            ),
            &owner.token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 204, "assign role");
}

async fn send(srv: &TestServer, who: &AuthOk, channel: &str, content: &str) -> reqwest::Response {
    srv.post_json_auth(
        &format!("/api/v1/channels/{channel}/messages"),
        &who.token,
        json!({ "content": content }),
    )
    .await
}

#[tokio::test]
async fn a_time_out_without_the_permission_is_refused_as_forbidden_even_on_the_owner() {
    let srv = TestServer::start().await;
    let owner = srv.register("fu_owner", PASS).await;
    let member = srv.register("fu_member", PASS).await;
    let s = space(&srv, &owner, "Rules").await;
    join(&srv, &owner, &s.id, &member).await;
    let res = srv
        .put_json_auth(
            &format!("/api/v1/servers/{}/members/{}/timeout", s.id, owner.id),
            &member.token,
            json!({ "seconds": 60 }),
        )
        .await;
    assert_eq!(res.status(), 403, "no permission comes first");
}

#[tokio::test]
async fn a_call_log_cannot_be_reacted_to_pinned_or_deleted() {
    let srv = TestServer::start().await;
    let ann = srv.register("fu_ann", PASS).await;
    let bea = srv.register("fu_bea", PASS).await;
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &ann.token,
            json!({ "recipient_id": bea.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let dm = dm["id"].as_str().unwrap().to_owned();
    let call: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{dm}/call"),
            &ann.token,
            json!({ "video": false }),
        )
        .await
        .json()
        .await
        .unwrap();
    let log = call["message_id"].as_str().expect("call log id").to_owned();

    for who in [&ann, &bea] {
        let react = srv
            .post_empty_auth(
                &format!("/api/v1/channels/{dm}/messages/{log}/react/%F0%9F%91%8D"),
                &who.token,
            )
            .await;
        assert_eq!(react.status(), 400, "no reactions on a call log");
        let pin = srv
            .post_empty_auth(
                &format!("/api/v1/channels/{dm}/messages/{log}/pin"),
                &who.token,
            )
            .await;
        assert_eq!(pin.status(), 400, "no pinning a call log");
        let delete = srv
            .delete_auth(&format!("/api/v1/channels/{dm}/messages/{log}"), &who.token)
            .await;
        assert_eq!(
            delete.status(),
            400,
            "no deleting a call log, not even its caller"
        );
    }

    // An ordinary message in the same chat is unaffected.
    let msg: Value = send(&srv, &bea, &dm, "hi").await.json().await.unwrap();
    let id = msg["id"].as_str().unwrap();
    let react = srv
        .post_empty_auth(
            &format!("/api/v1/channels/{dm}/messages/{id}/react/%F0%9F%91%8D"),
            &ann.token,
        )
        .await;
    assert!(
        react.status().is_success(),
        "react to a normal message: {}",
        react.status()
    );
}

#[tokio::test]
async fn a_thread_is_as_slow_as_its_channels_slowmode() {
    let srv = TestServer::start().await;
    let owner = srv.register("fu_slow_owner", PASS).await;
    let member = srv.register("fu_slow_member", PASS).await;
    let s = space(&srv, &owner, "Slow").await;
    join(&srv, &owner, &s.id, &member).await;
    let set = srv
        .put_json_auth(
            &format!("/api/v1/channels/{}/slowmode", s.general),
            &owner.token,
            json!({ "seconds": 30 }),
        )
        .await;
    assert!(set.status().is_success(), "set slowmode");
    let starter: Value = send(&srv, &owner, &s.general, "pizza?")
        .await
        .json()
        .await
        .unwrap();
    let thread: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/threads", s.general),
            &member.token,
            json!({ "message_id": starter["id"], "name": "Pizza" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let thread = thread["id"].as_str().expect("thread").to_owned();
    assert_eq!(send(&srv, &member, &thread, "me").await.status(), 200);
    assert_eq!(
        send(&srv, &member, &thread, "me again").await.status(),
        429,
        "the second reply within 30 s waits, as in the channel"
    );
}

/// The members `who` may time out, kick or ban in the space, as the app asks for them.
async fn moderatable(srv: &TestServer, server_id: &str, who: &AuthOk) -> (u16, Vec<String>) {
    let res = srv
        .get_auth(
            &format!("/api/v1/servers/{server_id}/moderatable"),
            &who.token,
        )
        .await;
    let status = res.status().as_u16();
    let body: Value = res.json().await.unwrap_or(Value::Null);
    let ids = body
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    (status, ids)
}

#[tokio::test]
async fn the_app_can_ask_whom_it_may_act_on() {
    let srv = TestServer::start().await;
    let owner = srv.register("fu_rank_owner", PASS).await;
    let moderator = srv.register("fu_rank_mod", PASS).await;
    let plain = srv.register("fu_rank_plain", PASS).await;
    let s = space(&srv, &owner, "Ranks").await;
    join(&srv, &owner, &s.id, &moderator).await;
    join(&srv, &owner, &s.id, &plain).await;
    give_role(&srv, &owner, &s.id, &moderator, MODERATE_MEMBERS).await;

    let (status, by_owner) = moderatable(&srv, &s.id, &owner).await;
    assert_eq!(status, 200);
    assert!(by_owner.contains(&moderator.id) && by_owner.contains(&plain.id));
    assert!(!by_owner.contains(&owner.id), "not yourself");

    let (status, by_mod) = moderatable(&srv, &s.id, &moderator).await;
    assert_eq!(status, 200);
    assert_eq!(
        by_mod,
        vec![plain.id.clone()],
        "only the plain member, never the owner"
    );

    let (status, by_plain) = moderatable(&srv, &s.id, &plain).await;
    assert_eq!(status, 200);
    assert!(by_plain.is_empty(), "no permission, nobody to act on");
}
