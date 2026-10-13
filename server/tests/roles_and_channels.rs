//! Roles and channels can be edited after they're made, like Discord: a role's name,
//! colour, permissions and "show separately" flag; the order of roles; a space's name; a
//! channel's name and topic; and a channel's (or category's) own permissions, which is how
//! a channel becomes private. Every change keeps the hierarchy (nobody acts on a role at or
//! above their own) and never hands out a permission the person doing it lacks.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

const MANAGE_CHANNELS: i64 = 1 << 0;
const MANAGE_MESSAGES: i64 = 1 << 1;
const MANAGE_ROLES: i64 = 1 << 4;
const MANAGE_SERVER: i64 = 1 << 5;
const VIEW_CHANNEL: i64 = 1 << 6;
const SEND_MESSAGES: i64 = 1 << 7;
const ADMINISTRATOR: i64 = 1 << 8;

struct Space {
    id: String,
    general: String,
    code: String,
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> Space {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    let id = server["id"].as_str().unwrap().to_owned();
    let general = server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "general")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{id}/invites"),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap().to_owned();
    Space { id, general, code }
}

async fn join(srv: &TestServer, s: &Space, name: &str) -> AuthOk {
    let who = srv.register(name, "supersecret123").await;
    let status = srv
        .post_json_auth(
            &format!("/api/v1/invites/{}", s.code),
            &who.token,
            json!({}),
        )
        .await
        .status();
    assert_eq!(status, 200, "{name} joins");
    who
}

async fn create_role(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    name: &str,
    perms: i64,
) -> String {
    let role: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/roles"),
            token,
            json!({ "name": name, "permissions": perms }),
        )
        .await
        .json()
        .await
        .unwrap();
    role["id"].as_str().unwrap().to_owned()
}

async fn assign(srv: &TestServer, token: &str, server_id: &str, user_id: &str, role_id: &str) {
    let status = srv
        .put_json_auth(
            &format!("/api/v1/servers/{server_id}/members/{user_id}/roles/{role_id}"),
            token,
            json!({}),
        )
        .await
        .status();
    assert_eq!(status, 204, "assign role");
}

async fn roles(srv: &TestServer, token: &str, server_id: &str) -> Vec<Value> {
    srv.get_auth(&format!("/api/v1/servers/{server_id}/roles"), token)
        .await
        .json::<Vec<Value>>()
        .await
        .unwrap()
}

async fn channel_ids(srv: &TestServer, token: &str, server_id: &str) -> Vec<String> {
    srv.get_auth(&format!("/api/v1/servers/{server_id}/channels"), token)
        .await
        .json::<Vec<Value>>()
        .await
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn the_owner_edits_a_roles_name_colour_permissions_and_hoist() {
    let srv = TestServer::start().await;
    let owner = srv.register("editowner", "supersecret123").await;
    let s = space(&srv, &owner, "Edit").await;
    let role = create_role(&srv, &owner.token, &s.id, "Helper", 0).await;

    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}/roles/{role}", s.id),
            &owner.token,
            json!({ "name": "Mods", "color": "#3fa7ff", "permissions": MANAGE_MESSAGES, "hoist": true }),
        )
        .await;
    assert_eq!(res.status(), 200, "edit role");
    let edited = roles(&srv, &owner.token, &s.id)
        .await
        .into_iter()
        .find(|r| r["id"] == role)
        .unwrap();
    assert_eq!(edited["name"], "Mods");
    assert_eq!(edited["color"], "#3fa7ff");
    assert_eq!(edited["permissions"], MANAGE_MESSAGES);
    assert_eq!(edited["hoist"], true);

    // The colour can be cleared, and a colour that isn't #rrggbb is refused.
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}/roles/{role}", s.id),
            &owner.token,
            json!({ "color": null }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let cleared = roles(&srv, &owner.token, &s.id)
        .await
        .into_iter()
        .find(|r| r["id"] == role)
        .unwrap();
    assert!(cleared["color"].is_null(), "colour cleared");
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}/roles/{role}", s.id),
            &owner.token,
            json!({ "color": "red" }),
        )
        .await;
    assert_eq!(res.status(), 400, "a colour must be #rrggbb");
}

#[tokio::test]
async fn a_moderator_cannot_edit_roles_at_or_above_their_own_or_grant_what_they_lack() {
    let srv = TestServer::start().await;
    let owner = srv.register("hierowner", "supersecret123").await;
    let s = space(&srv, &owner, "Hier").await;
    let low = create_role(&srv, &owner.token, &s.id, "Low", 0).await;
    let mods = create_role(&srv, &owner.token, &s.id, "Mods", MANAGE_ROLES).await;
    let high = create_role(&srv, &owner.token, &s.id, "High", 0).await;
    let moderator = join(&srv, &s, "hiermod").await;
    assign(&srv, &owner.token, &s.id, &moderator.id, &mods).await;

    let patch = |role: &str, body: Value| {
        let path = format!("/api/v1/servers/{}/roles/{role}", s.id);
        let token = moderator.token.clone();
        let srv = &srv;
        async move { srv.patch_json_auth(&path, &token, body).await.status() }
    };
    assert_eq!(
        patch(&low, json!({ "name": "Lowly" })).await,
        200,
        "a role below theirs"
    );
    assert_eq!(
        patch(&mods, json!({ "name": "Me" })).await,
        403,
        "their own role"
    );
    assert_eq!(
        patch(&high, json!({ "name": "Up" })).await,
        403,
        "a role above"
    );
    assert_eq!(
        patch(&low, json!({ "permissions": ADMINISTRATOR })).await,
        403,
        "can't grant a permission they don't have"
    );
    assert_eq!(
        patch(&low, json!({ "permissions": MANAGE_ROLES })).await,
        200,
        "can grant one they have"
    );
}

#[tokio::test]
async fn roles_can_be_reordered_within_reach() {
    let srv = TestServer::start().await;
    let owner = srv.register("orderowner", "supersecret123").await;
    let s = space(&srv, &owner, "Order").await;
    let a = create_role(&srv, &owner.token, &s.id, "A", 0).await;
    let b = create_role(&srv, &owner.token, &s.id, "B", 0).await;
    let c = create_role(&srv, &owner.token, &s.id, "C", MANAGE_ROLES).await;

    // Highest first: C B A → A C B.
    let res = srv
        .put_json_auth(
            &format!("/api/v1/servers/{}/role-order", s.id),
            &owner.token,
            json!({ "role_ids": [a, c, b] }),
        )
        .await;
    assert_eq!(res.status(), 204, "owner reorders");
    let mut ranked = roles(&srv, &owner.token, &s.id).await;
    ranked.retain(|r| r["is_everyone"] != true);
    ranked.sort_by_key(|r| -r["position"].as_i64().unwrap());
    let names: Vec<&str> = ranked.iter().map(|r| r["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["A", "C", "B"]);

    // A moderator holding C may only reorder what's below C, and must name exactly that.
    let moderator = join(&srv, &s, "ordermod").await;
    assign(&srv, &owner.token, &s.id, &moderator.id, &c).await;
    let res = srv
        .put_json_auth(
            &format!("/api/v1/servers/{}/role-order", s.id),
            &moderator.token,
            json!({ "role_ids": [a, c, b] }),
        )
        .await;
    assert_eq!(res.status(), 403, "roles at or above their own stay put");
    let member = join(&srv, &s, "ordernobody").await;
    let res = srv
        .put_json_auth(
            &format!("/api/v1/servers/{}/role-order", s.id),
            &member.token,
            json!({ "role_ids": [b] }),
        )
        .await;
    assert_eq!(res.status(), 403, "needs Manage roles");
}

#[tokio::test]
async fn the_space_and_its_channels_can_be_renamed_by_whoever_may() {
    let srv = TestServer::start().await;
    let owner = srv.register("nameowner", "supersecret123").await;
    let s = space(&srv, &owner, "Before").await;
    let member = join(&srv, &s, "namemember").await;

    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}", s.id),
            &owner.token,
            json!({ "name": "After" }),
        )
        .await;
    assert_eq!(res.status(), 200, "owner renames the space");
    let server: Value = srv
        .get_auth(&format!("/api/v1/servers/{}", s.id), &member.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(server["name"], "After");
    assert_eq!(
        srv.patch_json_auth(
            &format!("/api/v1/servers/{}", s.id),
            &member.token,
            json!({ "name": "Mine" })
        )
        .await
        .status(),
        403,
        "a member without Manage server can't"
    );
    assert_eq!(
        srv.patch_json_auth(
            &format!("/api/v1/servers/{}", s.id),
            &owner.token,
            json!({ "name": "   " })
        )
        .await
        .status(),
        400,
        "a name is needed"
    );

    let res = srv
        .patch_json_auth(
            &format!("/api/v1/channels/{}", s.general),
            &owner.token,
            json!({ "name": "lobby", "topic": "Say hi" }),
        )
        .await;
    assert_eq!(res.status(), 200, "owner edits the channel");
    let channels: Vec<Value> = srv
        .get_auth(&format!("/api/v1/servers/{}/channels", s.id), &member.token)
        .await
        .json()
        .await
        .unwrap();
    let general = channels
        .iter()
        .find(|c| c["id"] == s.general.as_str())
        .unwrap();
    assert_eq!(general["name"], "lobby");
    assert_eq!(general["topic"], "Say hi");
    assert_eq!(
        srv.patch_json_auth(
            &format!("/api/v1/channels/{}", s.general),
            &member.token,
            json!({ "name": "x" })
        )
        .await
        .status(),
        403,
        "a member without Manage channels can't"
    );
}

#[tokio::test]
async fn a_private_channel_shows_only_to_the_roles_let_in() {
    let srv = TestServer::start().await;
    let owner = srv.register("privowner", "supersecret123").await;
    let s = space(&srv, &owner, "Priv").await;
    let staff: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/channels", s.id),
            &owner.token,
            json!({ "name": "staff", "channel_type": "text" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let staff = staff["id"].as_str().unwrap().to_owned();
    let mods = create_role(&srv, &owner.token, &s.id, "Mods", 0).await;
    let member = join(&srv, &s, "privmember").await;

    let base = format!(
        "/api/v1/servers/{}/permission-overwrites/channel/{staff}",
        s.id
    );
    assert_eq!(
        srv.put_json_auth(
            &format!("{base}/everyone/everyone"),
            &owner.token,
            json!({ "allow": 0, "deny": VIEW_CHANNEL })
        )
        .await
        .status(),
        204,
        "@everyone can't see #staff"
    );
    assert_eq!(
        srv.put_json_auth(
            &format!("{base}/role/{mods}"),
            &owner.token,
            json!({ "allow": VIEW_CHANNEL, "deny": 0 })
        )
        .await
        .status(),
        204,
        "Mods can"
    );
    let listed: Vec<Value> = srv
        .get_auth(&base, &owner.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(listed.len(), 2, "both overwrites are listed");

    assert!(
        !channel_ids(&srv, &member.token, &s.id)
            .await
            .contains(&staff),
        "hidden from a plain member"
    );
    assert_eq!(
        srv.get_auth(&format!("/api/v1/channels/{staff}/messages"), &member.token)
            .await
            .status(),
        403
    );
    assign(&srv, &owner.token, &s.id, &member.id, &mods).await;
    assert!(
        channel_ids(&srv, &member.token, &s.id)
            .await
            .contains(&staff),
        "Mods see it"
    );

    // Back in sync with the category: the channel's own overwrites go.
    assert_eq!(srv.delete_auth(&base, &owner.token).await.status(), 204);
    let listed: Vec<Value> = srv
        .get_auth(&base, &owner.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(listed.is_empty(), "synced");
    let _ = SEND_MESSAGES;
}

#[tokio::test]
async fn channel_permissions_never_grant_what_the_editor_lacks() {
    let srv = TestServer::start().await;
    let owner = srv.register("grantowner", "supersecret123").await;
    let s = space(&srv, &owner, "Grant").await;
    let low = create_role(&srv, &owner.token, &s.id, "Low", 0).await;
    let mods = create_role(
        &srv,
        &owner.token,
        &s.id,
        "Mods",
        MANAGE_ROLES | MANAGE_CHANNELS,
    )
    .await;
    let moderator = join(&srv, &s, "grantmod").await;
    assign(&srv, &owner.token, &s.id, &moderator.id, &mods).await;
    let member = join(&srv, &s, "grantmember").await;

    let base = format!(
        "/api/v1/servers/{}/permission-overwrites/channel/{}",
        s.id, s.general
    );
    let put = |target: String, token: String, body: Value| {
        let srv = &srv;
        async move { srv.put_json_auth(&target, &token, body).await.status() }
    };
    assert_eq!(
        put(
            format!("{base}/role/{low}"),
            moderator.token.clone(),
            json!({ "allow": MANAGE_MESSAGES, "deny": 0 })
        )
        .await,
        403,
        "Manage messages isn't theirs to give"
    );
    assert_eq!(
        put(
            format!("{base}/role/{low}"),
            moderator.token.clone(),
            json!({ "allow": VIEW_CHANNEL, "deny": 0 })
        )
        .await,
        204,
        "View channel is"
    );
    assert_eq!(
        put(
            format!("{base}/role/{mods}"),
            moderator.token.clone(),
            json!({ "allow": 0, "deny": SEND_MESSAGES })
        )
        .await,
        403,
        "not on their own role"
    );
    assert_eq!(
        put(
            format!("{base}/everyone/everyone"),
            owner.token.clone(),
            json!({ "allow": ADMINISTRATOR, "deny": 0 })
        )
        .await,
        400,
        "Administrator isn't a channel permission"
    );
    assert_eq!(
        put(
            format!("{base}/everyone/everyone"),
            owner.token.clone(),
            json!({ "allow": VIEW_CHANNEL, "deny": VIEW_CHANNEL })
        )
        .await,
        400,
        "allow and deny can't overlap"
    );
    assert_eq!(
        put(
            format!("{base}/member/{}", member.id),
            member.token.clone(),
            json!({ "allow": VIEW_CHANNEL, "deny": 0 })
        )
        .await,
        403,
        "needs Manage roles"
    );
    // Lifting a deny is changing it too: the moderator can't undo one they couldn't set.
    assert_eq!(
        put(
            format!("{base}/role/{low}"),
            owner.token.clone(),
            json!({ "allow": VIEW_CHANNEL, "deny": MANAGE_MESSAGES })
        )
        .await,
        204,
        "the owner denies Manage messages"
    );
    assert_eq!(
        put(
            format!("{base}/role/{low}"),
            moderator.token.clone(),
            json!({ "allow": VIEW_CHANNEL, "deny": 0 })
        )
        .await,
        403,
        "can't lift a deny of what they lack"
    );
    assert_eq!(
        srv.delete_auth(&format!("{base}/role/{low}"), &moderator.token)
            .await
            .status(),
        403,
        "nor remove it whole"
    );
    let _ = MANAGE_SERVER;
}

#[tokio::test]
async fn a_space_carries_its_roles_and_who_holds_them() {
    let srv = TestServer::start().await;
    let owner = srv.register("fullowner", "supersecret123").await;
    let s = space(&srv, &owner, "Full").await;
    let role = create_role(&srv, &owner.token, &s.id, "Crew", 0).await;
    let member = join(&srv, &s, "fullmember").await;
    assign(&srv, &owner.token, &s.id, &member.id, &role).await;

    let full: Value = srv
        .get_auth(&format!("/api/v1/servers/{}", s.id), &member.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(
        full["roles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["id"] == role.as_str()),
        "roles ride along with the space"
    );
    assert!(
        full["member_roles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["user_id"] == member.id.as_str() && m["role_id"] == role.as_str()),
        "and who holds which"
    );
}
