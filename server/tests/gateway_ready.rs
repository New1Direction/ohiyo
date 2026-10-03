//! S-H3: the gateway `Ready` snapshot must apply View Channel exactly like REST does.
//! A channel the member cannot see must not appear in `Ready` (name/topic), and its
//! unread count must not leak through the `unread` map either.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};

const VIEW_CHANNEL: i64 = 1 << 6;
const SEND_MESSAGES: i64 = 1 << 7;

#[tokio::test]
async fn ready_omits_channels_and_unreads_the_member_cannot_view() {
    let srv = TestServer::start().await;
    let owner = srv.register("readyowner", "supersecret123").await;
    let member = srv.register("readymember", "supersecret123").await;

    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Ready" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let general_id = server["channels"][0]["id"].as_str().unwrap().to_owned();
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

    let hidden: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/channels"),
            &owner.token,
            json!({ "name": "staff-only", "topic": "layoffs" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let hidden_id = hidden["id"].as_str().unwrap().to_owned();

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_hidden', ?, 'channel', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&server_id)
    .bind(&hidden_id)
    .bind(VIEW_CHANNEL | SEND_MESSAGES)
    .execute(&db)
    .await
    .unwrap();

    // One unread message in each channel, authored by the owner.
    for channel_id in [&general_id, &hidden_id] {
        assert_eq!(
            srv.post_json_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &owner.token,
                json!({ "content": "unread for the member" }),
            )
            .await
            .status(),
            200
        );
    }

    let mut gw = Gateway::connect(&srv, &member.token).await;
    let ready = gw.wait_for(|ev| ev["t"] == "Ready").await;

    let servers = ready["d"]["servers"].as_array().unwrap();
    let ready_server = servers
        .iter()
        .find(|s| s["id"] == server_id)
        .expect("member's server is in Ready");
    let channel_ids: Vec<&str> = ready_server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap())
        .collect();
    assert!(
        channel_ids.contains(&general_id.as_str()),
        "visible channel is listed"
    );
    assert!(
        !channel_ids.contains(&hidden_id.as_str()),
        "hidden channel must not be listed in Ready"
    );

    let unread = ready["d"]["unread"].as_object().unwrap();
    assert_eq!(unread.get(&general_id), Some(&json!(1)));
    assert!(
        !unread.contains_key(&hidden_id),
        "hidden channel's unread count must not be in Ready"
    );
}

/// Pins which channels `Ready` lists across category and channel overwrites at every
/// level (@everyone, the member's roles, another role, the member), and checks each
/// against the per-channel access check REST uses for message history.
#[tokio::test]
async fn ready_applies_category_role_and_member_overwrites_like_rest() {
    let srv = TestServer::start().await;
    let owner = srv.register("pinowner", "supersecret123").await;
    let member = srv.register("pinmember", "supersecret123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Pins" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
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
    let roles_path = format!("/api/v1/servers/{server_id}/roles");
    let create_role = |name: &'static str| {
        srv.post_json_auth(
            &roles_path,
            &owner.token,
            json!({ "name": name, "permissions": 0 }),
        )
    };
    let staff: Value = create_role("Staff").await.json().await.unwrap();
    let staff_id = staff["id"].as_str().unwrap().to_owned();
    let other: Value = create_role("Other").await.json().await.unwrap();
    let other_id = other["id"].as_str().unwrap().to_owned();
    assert_eq!(
        srv.put_json_auth(
            &format!(
                "/api/v1/servers/{server_id}/members/{}/roles/{staff_id}",
                member.id
            ),
            &owner.token,
            json!({}),
        )
        .await
        .status(),
        204
    );
    let category: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/categories"),
            &owner.token,
            json!({ "name": "ops" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let category_id = category["id"].as_str().unwrap().to_owned();

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let overwrite = |scope_type: &'static str,
                     scope_id: String,
                     target: (&'static str, Option<String>),
                     allow: i64,
                     deny: i64| {
        sqlx::query(
            "INSERT INTO permission_overwrites
             (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', 1)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(server_id.clone())
        .bind(scope_type)
        .bind(scope_id)
        .bind(target.0)
        .bind(target.1)
        .bind(allow)
        .bind(deny)
        .execute(&db)
    };
    // The whole category is hidden from @everyone.
    overwrite(
        "category",
        category_id.clone(),
        ("everyone", None),
        0,
        VIEW_CHANNEL,
    )
    .await
    .unwrap();

    let everyone = || ("everyone", None);
    let role = |id: &String| ("role", Some(id.clone()));
    let me = || ("member", Some(member.id.clone()));
    // (name, in the category?, channel overwrites as (target, allow, deny), visible?)
    type Target = (&'static str, Option<String>);
    type Case = (&'static str, bool, Vec<(Target, i64, i64)>, bool);
    let cases: Vec<Case> = vec![
        ("plain", false, vec![], true),
        (
            "everyone-denied",
            false,
            vec![(everyone(), 0, VIEW_CHANNEL)],
            false,
        ),
        (
            "staff-allowed",
            false,
            vec![
                (everyone(), 0, VIEW_CHANNEL),
                (role(&staff_id), VIEW_CHANNEL, 0),
            ],
            true,
        ),
        (
            "other-role-allowed",
            false,
            vec![
                (everyone(), 0, VIEW_CHANNEL),
                (role(&other_id), VIEW_CHANNEL, 0),
            ],
            false,
        ),
        (
            "staff-denied",
            false,
            vec![(role(&staff_id), 0, VIEW_CHANNEL)],
            false,
        ),
        (
            "staff-denied-member-allowed",
            false,
            vec![(role(&staff_id), 0, VIEW_CHANNEL), (me(), VIEW_CHANNEL, 0)],
            true,
        ),
        (
            "staff-allowed-member-denied",
            false,
            vec![
                (everyone(), 0, VIEW_CHANNEL),
                (role(&staff_id), VIEW_CHANNEL, 0),
                (me(), 0, VIEW_CHANNEL),
            ],
            false,
        ),
        ("in-hidden-category", true, vec![], false),
        (
            "category-member-allowed",
            true,
            vec![(me(), VIEW_CHANNEL, 0)],
            true,
        ),
        (
            "category-staff-allowed",
            true,
            vec![(role(&staff_id), VIEW_CHANNEL, 0)],
            true,
        ),
        (
            "category-everyone-reallowed",
            true,
            vec![(everyone(), VIEW_CHANNEL, 0)],
            true,
        ),
    ];

    let mut expected = std::collections::HashMap::new();
    for (name, in_category, overwrites, visible) in cases {
        let channel: Value = srv
            .post_json_auth(
                &format!("/api/v1/servers/{server_id}/channels"),
                &owner.token,
                json!({
                    "name": name,
                    "category_id": if in_category { Some(category_id.clone()) } else { None },
                }),
            )
            .await
            .json()
            .await
            .unwrap();
        let channel_id = channel["id"].as_str().unwrap().to_owned();
        for (target, allow, deny) in overwrites {
            overwrite("channel", channel_id.clone(), target, allow, deny)
                .await
                .unwrap();
        }
        assert_eq!(
            srv.post_json_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &owner.token,
                json!({ "content": "unread" }),
            )
            .await
            .status(),
            200
        );
        expected.insert(channel_id, (name, visible));
    }

    let mut gw = Gateway::connect(&srv, &member.token).await;
    let ready = gw.wait_for(|ev| ev["t"] == "Ready").await;
    let ready_server = ready["d"]["servers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["id"] == server_id)
        .expect("member's server is in Ready")
        .clone();
    let listed: std::collections::HashSet<String> = ready_server["channels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["id"].as_str().unwrap().to_owned())
        .collect();
    let unread = ready["d"]["unread"].as_object().unwrap();
    for (channel_id, (name, visible)) in &expected {
        assert_eq!(
            listed.contains(channel_id),
            *visible,
            "{name}: listed in Ready"
        );
        assert_eq!(
            unread.get(channel_id),
            visible.then_some(&json!(1)),
            "{name}: unread count in Ready"
        );
        let history = srv
            .get_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &member.token,
            )
            .await
            .status();
        assert_eq!(
            history == 200,
            *visible,
            "{name}: REST history access agrees"
        );
    }
}

/// The View Channel filter judges the channel list it was given. If the last channel of a
/// hidden category moves out between loading the list and reading the overwrites, the
/// channel as loaded (inside the hidden category) must still be judged with that
/// category's overwrites, not listed because the category no longer has channels.
#[tokio::test]
async fn the_view_filter_uses_the_overwrites_of_the_channel_list_it_was_given() {
    let srv = TestServer::start().await;
    let owner = srv.register("staleowner", "supersecret123").await;
    let member = srv.register("stalemember", "supersecret123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Stale" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
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
    let category: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/categories"),
            &owner.token,
            json!({ "name": "hidden" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let category_id = category["id"].as_str().unwrap().to_owned();
    let secret: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/channels"),
            &owner.token,
            json!({ "name": "secret", "category_id": category_id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let secret_id = secret["id"].as_str().unwrap().to_owned();
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_hidden_category', ?, 'category', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&server_id)
    .bind(&category_id)
    .bind(VIEW_CHANNEL)
    .execute(&db)
    .await
    .unwrap();

    let loaded: Vec<server::types::Channel> =
        sqlx::query_as("SELECT * FROM channels WHERE server_id = ? ORDER BY position")
            .bind(&server_id)
            .fetch_all(&db)
            .await
            .unwrap();
    // The category's only channel moves out after the list was loaded.
    sqlx::query("UPDATE channels SET category_id = NULL WHERE id = ?")
        .bind(&secret_id)
        .execute(&db)
        .await
        .unwrap();

    let visible = server::api::roles::viewable_channels(&srv.state, &server_id, &member.id, loaded)
        .await
        .unwrap();
    assert!(
        !visible.iter().any(|c| c.id == secret_id),
        "a channel loaded inside a hidden category stays hidden"
    );
    assert!(
        !visible.is_empty(),
        "the server's other channels are still listed"
    );
}
