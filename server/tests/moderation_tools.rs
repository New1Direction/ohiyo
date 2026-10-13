//! Moderation a space can do without bots: time a member out, slow a channel down, decide
//! who may invite and pause invites, see and lift bans (optionally wiping a spammer's
//! recent messages), and read the moderation log with names and times.

mod common;

use std::time::Duration;

use common::{now_unix, ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use sqlx::sqlite::SqlitePool;

const PASS: &str = "supersecret123";
const MODERATE_MEMBERS: i64 = 1 << 9;
const CREATE_INVITE: i64 = 1 << 10;

struct Space {
    id: String,
    general: String,
    voice: String,
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> Space {
    let body: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    let channel = |kind: &str| {
        body["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["channel_type"] == kind)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    Space {
        id: body["id"].as_str().unwrap().to_owned(),
        general: channel("text"),
        voice: channel("voice"),
    }
}

async fn invite_code(srv: &TestServer, inviter: &AuthOk, server_id: &str, body: Value) -> String {
    let res = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &inviter.token,
            body,
        )
        .await;
    assert_eq!(res.status(), 200, "invite");
    res.json::<Value>().await.unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn join(srv: &TestServer, inviter: &AuthOk, server_id: &str, who: &AuthOk) {
    let code = invite_code(srv, inviter, server_id, json!({})).await;
    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &who.token, json!({}))
        .await;
    assert_eq!(res.status(), 200, "join");
}

/// A role carrying `permissions`, given to `who` by the owner.
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
    assert_eq!(
        role["permissions"].as_i64(),
        Some(permissions),
        "the role keeps its permissions"
    );
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

async fn post(srv: &TestServer, who: &AuthOk, channel: &str, content: &str) -> reqwest::Response {
    srv.post_json_auth(
        &format!("/api/v1/channels/{channel}/messages"),
        &who.token,
        json!({ "content": content }),
    )
    .await
}

async fn time_out(
    srv: &TestServer,
    actor: &AuthOk,
    server_id: &str,
    target: &AuthOk,
    seconds: i64,
) -> u16 {
    srv.put_json_auth(
        &format!("/api/v1/servers/{server_id}/members/{}/timeout", target.id),
        &actor.token,
        json!({ "seconds": seconds, "reason": "spam" }),
    )
    .await
    .status()
    .as_u16()
}

async fn pool(srv: &TestServer) -> SqlitePool {
    SqlitePool::connect(srv.db_url()).await.unwrap()
}

#[tokio::test]
async fn a_timed_out_member_can_read_but_not_post_react_start_threads_or_invite() {
    let srv = TestServer::start().await;
    let owner = srv.register("toowner", PASS).await;
    let moderator = srv.register("tomod", PASS).await;
    let member = srv.register("tomember", PASS).await;
    let s = space(&srv, &owner, "Calm").await;
    join(&srv, &owner, &s.id, &moderator).await;
    join(&srv, &owner, &s.id, &member).await;
    give_role(&srv, &owner, &s.id, &moderator, MODERATE_MEMBERS).await;

    let before: Value = post(&srv, &member, &s.general, "before")
        .await
        .json()
        .await
        .unwrap();
    let message_id = before["id"].as_str().unwrap().to_owned();

    assert_eq!(time_out(&srv, &moderator, &s.id, &member, 600).await, 200);

    let me: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/me/permissions", s.id),
            &member.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let until = me["timed_out_until"]
        .as_i64()
        .expect("the member is told until when");
    assert!(
        until >= now_unix() + 590 && until <= now_unix() + 610,
        "ten minutes: {until}"
    );

    let read = srv
        .get_auth(
            &format!("/api/v1/channels/{}/messages", s.general),
            &member.token,
        )
        .await;
    assert_eq!(read.status(), 200, "reading still works");

    let sent = post(&srv, &member, &s.general, "after").await;
    assert_eq!(sent.status(), 403, "no posting");
    assert!(sent.text().await.unwrap().contains("timed out"));
    let react = srv
        .post_json_auth(
            &format!(
                "/api/v1/channels/{}/messages/{message_id}/react/%F0%9F%91%8D",
                s.general
            ),
            &member.token,
            json!({}),
        )
        .await;
    assert_eq!(react.status(), 403, "no reacting");
    let thread = srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/threads", s.general),
            &member.token,
            json!({ "message_id": message_id }),
        )
        .await;
    assert_eq!(thread.status(), 403, "no threads");
    let invite = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/invites", s.id),
            &member.token,
            json!({}),
        )
        .await;
    assert_eq!(invite.status(), 403, "no invites");

    // The moderator lifts it early.
    let lifted = srv
        .delete_auth(
            &format!("/api/v1/servers/{}/members/{}/timeout", s.id, member.id),
            &moderator.token,
        )
        .await;
    assert_eq!(lifted.status(), 204);
    assert_eq!(post(&srv, &member, &s.general, "back").await.status(), 200);
}

#[tokio::test]
async fn timeouts_follow_permissions_and_rank() {
    let srv = TestServer::start().await;
    let owner = srv.register("trowner", PASS).await;
    let moderator = srv.register("trmod", PASS).await;
    let member = srv.register("trmember", PASS).await;
    let other = srv.register("trother", PASS).await;
    let s = space(&srv, &owner, "Ranks").await;
    join(&srv, &owner, &s.id, &moderator).await;
    join(&srv, &owner, &s.id, &member).await;
    join(&srv, &owner, &s.id, &other).await;
    give_role(&srv, &owner, &s.id, &moderator, MODERATE_MEMBERS).await;

    assert_eq!(
        time_out(&srv, &member, &s.id, &other, 60).await,
        403,
        "needs the permission"
    );
    assert_eq!(
        time_out(&srv, &moderator, &s.id, &owner, 60).await,
        400,
        "never the owner"
    );
    assert_eq!(
        time_out(&srv, &moderator, &s.id, &moderator, 60).await,
        403,
        "not yourself"
    );
    assert_eq!(
        time_out(&srv, &moderator, &s.id, &member, 7).await,
        400,
        "only the offered lengths"
    );
    let outsider = srv.register("troutsider", PASS).await;
    assert_eq!(
        time_out(&srv, &moderator, &s.id, &outsider, 60).await,
        404,
        "members only"
    );
    for seconds in [60, 300, 600, 3600, 86400, 604800] {
        assert_eq!(
            time_out(&srv, &moderator, &s.id, &member, seconds).await,
            200,
            "{seconds}s"
        );
    }
    // The owner outranks the moderator, so the owner can time the moderator out.
    assert_eq!(time_out(&srv, &owner, &s.id, &moderator, 60).await, 200);
    // And a timed-out moderator can't time anyone out.
    assert_eq!(time_out(&srv, &moderator, &s.id, &other, 60).await, 403);
}

#[tokio::test]
async fn a_timeout_runs_out_on_its_own() {
    let srv = TestServer::start().await;
    let owner = srv.register("exowner", PASS).await;
    let member = srv.register("exmember", PASS).await;
    let s = space(&srv, &owner, "Expiry").await;
    join(&srv, &owner, &s.id, &member).await;
    assert_eq!(time_out(&srv, &owner, &s.id, &member, 60).await, 200);
    assert_eq!(post(&srv, &member, &s.general, "nope").await.status(), 403);

    sqlx::query("UPDATE member_timeouts SET until = ? WHERE user_id = ?")
        .bind(now_unix() - 1)
        .bind(&member.id)
        .execute(&pool(&srv).await)
        .await
        .unwrap();
    assert_eq!(post(&srv, &member, &s.general, "free").await.status(), 200);
    let me: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/me/permissions", s.id),
            &member.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(me["timed_out_until"].is_null());
}

fn in_voice(srv: &TestServer, channel_id: &str, user: &AuthOk) -> bool {
    srv.state
        .voice
        .read()
        .unwrap()
        .get(channel_id)
        .is_some_and(|room| room.contains_key(&user.id))
}

#[tokio::test]
async fn a_timed_out_member_is_taken_out_of_voice_and_cant_rejoin() {
    Box::pin(voice_scenario()).await;
}

async fn voice_scenario() {
    let srv = TestServer::start().await;
    let owner = srv.register("vowner", PASS).await;
    let member = srv.register("vmember", PASS).await;
    let s = space(&srv, &owner, "Voice").await;
    join(&srv, &owner, &s.id, &member).await;

    let mut gateway = Gateway::connect(&srv, &member.token).await;
    gateway.wait_for(|e| e["t"] == "Ready").await;
    gateway
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": s.voice } }))
        .await;
    gateway.wait_for(|e| e["t"] == "VoiceRoster").await;
    assert!(in_voice(&srv, &s.voice, &member));

    assert_eq!(time_out(&srv, &owner, &s.id, &member, 600).await, 200);
    tokio::time::timeout(Duration::from_secs(5), async {
        while in_voice(&srv, &s.voice, &member) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a timeout takes the member out of the call");

    gateway
        .send(&json!({ "t": "JoinVoice", "d": { "channel_id": s.voice } }))
        .await;
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        !in_voice(&srv, &s.voice, &member),
        "no joining while timed out"
    );
}

#[tokio::test]
async fn slowmode_spaces_out_messages_except_for_moderators() {
    let srv = TestServer::start().await;
    let owner = srv.register("slowner", PASS).await;
    let member = srv.register("slmember", PASS).await;
    let s = space(&srv, &owner, "Slow").await;
    join(&srv, &owner, &s.id, &member).await;

    let set = |who: &AuthOk, seconds: i64| {
        let path = format!("/api/v1/channels/{}/slowmode", s.general);
        let token = who.token.clone();
        let srv = &srv;
        async move {
            srv.put_json_auth(&path, &token, json!({ "seconds": seconds }))
                .await
                .status()
                .as_u16()
        }
    };
    assert_eq!(set(&member, 10).await, 403, "needs Manage Channels");
    assert_eq!(set(&owner, 7).await, 400, "only the offered lengths");
    assert_eq!(set(&owner, 10).await, 204);

    let space_now: Value = srv
        .get_auth(&format!("/api/v1/servers/{}", s.id), &owner.token)
        .await
        .json()
        .await
        .unwrap();
    let general = space_now["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == s.general.as_str())
        .unwrap()
        .clone();
    assert_eq!(general["slowmode_seconds"].as_i64(), Some(10));

    assert_eq!(post(&srv, &member, &s.general, "one").await.status(), 200);
    let second = post(&srv, &member, &s.general, "two").await;
    assert_eq!(second.status(), 429, "too soon");
    let retry: i64 = second
        .headers()
        .get("retry-after")
        .expect("says how long to wait")
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=10).contains(&retry), "retry after {retry}");

    // The owner (Manage Channels / Manage Messages) isn't slowed down.
    assert_eq!(post(&srv, &owner, &s.general, "a").await.status(), 200);
    assert_eq!(post(&srv, &owner, &s.general, "b").await.status(), 200);

    // Turning it off frees the member at once.
    assert_eq!(set(&owner, 0).await, 204);
    assert_eq!(post(&srv, &member, &s.general, "three").await.status(), 200);
}

#[tokio::test]
async fn members_may_invite_until_the_owner_says_otherwise() {
    let srv = TestServer::start().await;
    let owner = srv.register("ivowner", PASS).await;
    let member = srv.register("ivmember", PASS).await;
    let s = space(&srv, &owner, "Invites").await;
    join(&srv, &owner, &s.id, &member).await;

    let me: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/me/permissions", s.id),
            &member.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_ne!(
        me["permissions"].as_i64().unwrap() & CREATE_INVITE,
        0,
        "on by default"
    );
    let create = |who: &AuthOk| {
        let path = format!("/api/v1/servers/{}/invites", s.id);
        let token = who.token.clone();
        let srv = &srv;
        async move {
            srv.post_json_auth(&path, &token, json!({}))
                .await
                .status()
                .as_u16()
        }
    };
    assert_eq!(create(&member).await, 200);

    let settings = format!("/api/v1/servers/{}/invite-settings", s.id);
    assert_eq!(
        srv.patch_json_auth(
            &settings,
            &member.token,
            json!({ "members_can_invite": false })
        )
        .await
        .status(),
        403,
        "needs Manage Server"
    );
    assert_eq!(
        srv.patch_json_auth(
            &settings,
            &owner.token,
            json!({ "members_can_invite": false })
        )
        .await
        .status(),
        200
    );
    assert_eq!(create(&member).await, 403);
    assert_eq!(create(&owner).await, 200, "the owner still can");

    let me: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/me/permissions", s.id),
            &member.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(me["permissions"].as_i64().unwrap() & CREATE_INVITE, 0);
    assert_eq!(
        srv.patch_json_auth(
            &settings,
            &owner.token,
            json!({ "members_can_invite": true })
        )
        .await
        .status(),
        200
    );
    assert_eq!(create(&member).await, 200);
}

#[tokio::test]
async fn paused_invites_turn_newcomers_away_with_a_clear_reason() {
    let srv = TestServer::start().await;
    let owner = srv.register("paowner", PASS).await;
    let newcomer = srv.register("panew", PASS).await;
    let s = space(&srv, &owner, "Paused").await;
    let code = invite_code(&srv, &owner, &s.id, json!({})).await;
    let settings = format!("/api/v1/servers/{}/invite-settings", s.id);

    let res = srv
        .patch_json_auth(&settings, &owner.token, json!({ "paused": true }))
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["paused"], true);
    assert_eq!(body["members_can_invite"], true);
    let read: Value = srv
        .get_auth(&settings, &owner.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(read["paused"], true, "the settings read back");

    let preview: Value = srv
        .get_auth(&format!("/api/v1/invites/{code}"), &newcomer.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        preview["paused"], true,
        "the preview says so before they try"
    );
    let joined = srv
        .post_json_auth(
            &format!("/api/v1/invites/{code}"),
            &newcomer.token,
            json!({}),
        )
        .await;
    assert_eq!(joined.status(), 403);
    assert!(joined
        .text()
        .await
        .unwrap()
        .contains("isn't taking new members"));

    srv.patch_json_auth(&settings, &owner.token, json!({ "paused": false }))
        .await;
    let joined = srv
        .post_json_auth(
            &format!("/api/v1/invites/{code}"),
            &newcomer.token,
            json!({}),
        )
        .await;
    assert_eq!(joined.status(), 200);
}

#[tokio::test]
async fn invites_can_run_out_and_are_listed_for_who_may_see_them() {
    let srv = TestServer::start().await;
    let owner = srv.register("lsowner", PASS).await;
    let member = srv.register("lsmember", PASS).await;
    let first = srv.register("lsfirst", PASS).await;
    let second = srv.register("lssecond", PASS).await;
    let s = space(&srv, &owner, "Listed").await;
    join(&srv, &owner, &s.id, &member).await;

    let once = invite_code(&srv, &owner, &s.id, json!({ "max_uses": 1 })).await;
    assert_eq!(
        srv.post_json_auth(&format!("/api/v1/invites/{once}"), &first.token, json!({}))
            .await
            .status(),
        200
    );
    assert_eq!(
        srv.post_json_auth(&format!("/api/v1/invites/{once}"), &second.token, json!({}))
            .await
            .status(),
        410,
        "used up"
    );

    let res = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/invites", s.id),
            &member.token,
            json!({ "expires_in_secs": 1800 }),
        )
        .await;
    let mine: Value = res.json().await.unwrap();
    let expires = mine["expires_at"].as_i64().unwrap();
    assert!((now_unix() + 1790..=now_unix() + 1810).contains(&expires));

    // The owner sees every invite with who made it and how far it has been used.
    let all: Value = srv
        .get_auth(&format!("/api/v1/servers/{}/invites", s.id), &owner.token)
        .await
        .json()
        .await
        .unwrap();
    let all = all.as_array().expect("a list");
    assert!(all.len() >= 3, "{all:?}");
    let used = all.iter().find(|i| i["code"] == once.as_str()).unwrap();
    assert_eq!(used["uses"].as_i64(), Some(1));
    assert_eq!(used["max_uses"].as_i64(), Some(1));
    assert!(used["created_by_name"].is_string());

    // A member sees only their own.
    let theirs: Value = srv
        .get_auth(&format!("/api/v1/servers/{}/invites", s.id), &member.token)
        .await
        .json()
        .await
        .unwrap();
    let theirs = theirs.as_array().unwrap();
    assert_eq!(theirs.len(), 1);
    assert_eq!(theirs[0]["code"], mine["code"]);

    // Someone with Manage Server can revoke an invite they didn't make.
    let revoke = srv
        .delete_auth(
            &format!("/api/v1/invites/{}", mine["code"].as_str().unwrap()),
            &owner.token,
        )
        .await;
    assert_eq!(revoke.status(), 204);
}

#[tokio::test]
async fn the_ban_list_says_who_banned_whom_and_why_and_unbanning_works() {
    let srv = TestServer::start().await;
    let owner = srv.register("bnowner", PASS).await;
    let member = srv.register("bnmember", PASS).await;
    let spammer = srv.register("bnspammer", PASS).await;
    let s = space(&srv, &owner, "Bans").await;
    join(&srv, &owner, &s.id, &member).await;
    join(&srv, &owner, &s.id, &spammer).await;

    let ban = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/bans/{}", s.id, spammer.id),
            &owner.token,
            json!({ "reason": "links everywhere" }),
        )
        .await;
    assert_eq!(ban.status(), 204);

    assert_eq!(
        srv.get_auth(&format!("/api/v1/servers/{}/bans", s.id), &member.token)
            .await
            .status(),
        403,
        "needs Ban Members"
    );
    let bans: Value = srv
        .get_auth(&format!("/api/v1/servers/{}/bans", s.id), &owner.token)
        .await
        .json()
        .await
        .unwrap();
    let bans = bans.as_array().unwrap();
    assert_eq!(bans.len(), 1);
    assert_eq!(bans[0]["user"]["id"], spammer.id.as_str());
    assert_eq!(bans[0]["user"]["username"], "bnspammer");
    assert_eq!(bans[0]["banned_by_name"], "bnowner");
    assert_eq!(bans[0]["reason"], "links everywhere");
    assert!(bans[0]["banned_at"].as_i64().is_some());

    let unban = srv
        .delete_auth(
            &format!("/api/v1/servers/{}/bans/{}", s.id, spammer.id),
            &owner.token,
        )
        .await;
    assert_eq!(unban.status(), 204);
    let bans: Value = srv
        .get_auth(&format!("/api/v1/servers/{}/bans", s.id), &owner.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(bans.as_array().unwrap().len(), 0);
}

#[tokio::test]
async fn a_ban_can_take_the_spammers_recent_messages_with_it() {
    let srv = TestServer::start().await;
    let owner = srv.register("dmowner", PASS).await;
    let spammer = srv.register("dmspammer", PASS).await;
    let s = space(&srv, &owner, "Wipe").await;
    join(&srv, &owner, &s.id, &spammer).await;

    let old: Value = post(&srv, &spammer, &s.general, "from last week")
        .await
        .json()
        .await
        .unwrap();
    let recent: Value = post(&srv, &spammer, &s.general, "buy now")
        .await
        .json()
        .await
        .unwrap();
    let kept: Value = post(&srv, &owner, &s.general, "owner's own")
        .await
        .json()
        .await
        .unwrap();
    sqlx::query("UPDATE messages SET created_at = ? WHERE id = ?")
        .bind(now_unix() - 2 * 86_400)
        .bind(old["id"].as_str().unwrap())
        .execute(&pool(&srv).await)
        .await
        .unwrap();

    let ban = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/bans/{}", s.id, spammer.id),
            &owner.token,
            json!({ "delete_message_seconds": 86400 }),
        )
        .await;
    assert_eq!(ban.status(), 204);

    let left: Value = srv
        .get_auth(
            &format!("/api/v1/channels/{}/messages", s.general),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let ids: Vec<&str> = left
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert!(
        !ids.contains(&recent["id"].as_str().unwrap()),
        "the last day's spam goes"
    );
    assert!(
        ids.contains(&old["id"].as_str().unwrap()),
        "older messages stay"
    );
    assert!(
        ids.contains(&kept["id"].as_str().unwrap()),
        "nobody else's go"
    );
}

#[tokio::test]
async fn older_apps_can_still_ban_with_no_body() {
    let srv = TestServer::start().await;
    let owner = srv.register("obowner", PASS).await;
    let first = srv.register("obfirst", PASS).await;
    let second = srv.register("obsecond", PASS).await;
    let s = space(&srv, &owner, "Old apps").await;
    join(&srv, &owner, &s.id, &first).await;
    join(&srv, &owner, &s.id, &second).await;

    // No body at all.
    let res = srv
        .post_empty_auth(
            &format!("/api/v1/servers/{}/bans/{}", s.id, first.id),
            &owner.token,
        )
        .await;
    assert_eq!(res.status(), 204);
    // The app's request helper always says JSON, even with nothing to send.
    let res = srv
        .post_raw_auth(
            &format!("/api/v1/servers/{}/bans/{}", s.id, second.id),
            &owner.token,
            "application/json",
            Vec::new(),
        )
        .await;
    assert_eq!(res.status(), 204);
}

#[tokio::test]
async fn the_moderation_log_names_people_says_why_and_filters() {
    let srv = TestServer::start().await;
    let owner = srv.register("lgowner", PASS).await;
    let member = srv.register("lgmember", PASS).await;
    let kicked = srv.register("lgkicked", PASS).await;
    let s = space(&srv, &owner, "Log").await;
    join(&srv, &owner, &s.id, &member).await;
    join(&srv, &owner, &s.id, &kicked).await;

    assert_eq!(time_out(&srv, &owner, &s.id, &member, 300).await, 200);
    srv.delete_auth(
        &format!("/api/v1/servers/{}/members/{}", s.id, kicked.id),
        &owner.token,
    )
    .await;

    let log: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/moderation-actions", s.id),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let log = log.as_array().unwrap();
    let timeout = log
        .iter()
        .find(|a| a["action"] == "timeout_member")
        .expect("logged");
    assert_eq!(timeout["actor_name"], "lgowner");
    assert_eq!(timeout["target_name"], "lgmember");
    assert_eq!(timeout["reason"], "spam");
    assert!(timeout["created_at"].as_i64().is_some());
    let kick = log
        .iter()
        .find(|a| a["action"] == "kick_member")
        .expect("logged");
    assert_eq!(kick["target_name"], "lgkicked");

    let only: Value = srv
        .get_auth(
            &format!(
                "/api/v1/servers/{}/moderation-actions?action=kick_member",
                s.id
            ),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let only = only.as_array().unwrap();
    assert!(!only.is_empty() && only.iter().all(|a| a["action"] == "kick_member"));

    let page: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{}/moderation-actions?limit=1", s.id),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(page.as_array().unwrap().len(), 1, "pages");
}
