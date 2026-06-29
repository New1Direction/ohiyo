mod common;

use common::TestServer;
use serde_json::{json, Value};

const VIEW_CHANNEL: i64 = 1 << 6;
const SEND_MESSAGES: i64 = 1 << 7;

#[tokio::test]
async fn channel_overwrites_enforce_everyone_role_and_member_order() {
    let srv = TestServer::start().await;
    let owner = srv.register("permowner", "supersecret123").await;
    let member = srv.register("permmember", "supersecret123").await;

    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Perms" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let channel_id = server["channels"][0]["id"].as_str().unwrap().to_owned();

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

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_everyone', ?, 'channel', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&server_id)
    .bind(&channel_id)
    .bind(VIEW_CHANNEL | SEND_MESSAGES)
    .execute(&db)
    .await
    .unwrap();

    let channels: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{server_id}/channels"),
            &member.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(
        !channels
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == channel_id),
        "@everyone deny View Channel hides the channel from normal loads"
    );
    assert_eq!(
        srv.get_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &member.token
        )
        .await
        .status(),
        403
    );
    assert_eq!(
        srv.post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &owner.token,
            json!({ "content": "owner bypass" }),
        )
        .await
        .status(),
        200,
        "owner/admin override bypasses channel overwrites"
    );

    let role: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/roles"),
            &owner.token,
            json!({ "name": "Readers", "permissions": VIEW_CHANNEL }),
        )
        .await
        .json()
        .await
        .unwrap();
    let role_id = role["id"].as_str().unwrap().to_owned();
    assert_eq!(
        srv.put_json_auth(
            &format!(
                "/api/v1/servers/{server_id}/members/{}/roles/{role_id}",
                member.id
            ),
            &owner.token,
            json!({}),
        )
        .await
        .status(),
        204
    );
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_role', ?, 'channel', ?, 'role', ?, ?, 0, 'test', 2)",
    )
    .bind(&server_id)
    .bind(&channel_id)
    .bind(&role_id)
    .bind(VIEW_CHANNEL)
    .execute(&db)
    .await
    .unwrap();

    assert_eq!(
        srv.get_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &member.token
        )
        .await
        .status(),
        200,
        "role allow View Channel overrides the @everyone deny at the role level"
    );
    assert_eq!(
        srv.post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &member.token,
            json!({ "content": "should not send yet" }),
        )
        .await
        .status(),
        403,
        "@everyone deny Send Messages still makes the channel read-only"
    );

    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_member', ?, 'channel', ?, 'member', ?, ?, 0, 'test', 3)",
    )
    .bind(&server_id)
    .bind(&channel_id)
    .bind(&member.id)
    .bind(SEND_MESSAGES)
    .execute(&db)
    .await
    .unwrap();
    assert_eq!(
        srv.post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &member.token,
            json!({ "content": "member-specific allow works" }),
        )
        .await
        .status(),
        200,
        "member-specific allow is applied after role denies/allows"
    );
}
