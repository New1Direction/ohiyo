mod common;

use common::TestServer;
use serde_json::{json, Value};

#[tokio::test]
async fn block_prevents_new_dm_and_message_sends() {
    let srv = TestServer::start().await;
    let alice = srv.register("abusealice", "supersecret123").await;
    let bob = srv.register("abusebob", "supersecret123").await;

    let blocked = srv
        .post_empty_auth(&format!("/api/v1/users/{}/block", bob.id), &alice.token)
        .await;
    assert_eq!(blocked.status(), 204);

    let open = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &bob.token,
            json!({ "recipient_id": alice.id }),
        )
        .await;
    assert_eq!(open.status(), 403, "blocked users cannot open a fresh DM");

    let blocks: Value = srv
        .get_auth("/api/v1/users/@me/blocks", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(blocks.as_array().unwrap().len(), 1);

    let unblocked = srv
        .delete_auth(&format!("/api/v1/users/{}/block", bob.id), &alice.token)
        .await;
    assert_eq!(unblocked.status(), 204);
    let open = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &bob.token,
            json!({ "recipient_id": alice.id }),
        )
        .await;
    assert_eq!(open.status(), 200);
    let channel: Value = open.json().await.unwrap();
    let channel_id = channel["id"].as_str().unwrap();

    let blocked_again = srv
        .post_empty_auth(&format!("/api/v1/users/{}/block", bob.id), &alice.token)
        .await;
    assert_eq!(blocked_again.status(), 204);
    let send = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &bob.token,
            json!({ "content": "hello?" }),
        )
        .await;
    assert_eq!(
        send.status(),
        403,
        "blocked users cannot keep sending in an existing DM"
    );
}

#[tokio::test]
async fn reports_feed_mod_queue_and_audit_log() {
    let srv = TestServer::start().await;
    let owner = srv.register("modowner", "supersecret123").await;
    let member = srv.register("modmember", "supersecret123").await;

    let server: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &owner.token,
            json!({ "name": "Moderated" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap();
    let channel_id = server["channels"][0]["id"].as_str().unwrap();
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
    let msg: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &member.token,
            json!({ "content": "bad stuff" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let message_id = msg["id"].as_str().unwrap();

    let report: Value = srv
        .post_json_auth(
            "/api/v1/reports",
            &owner.token,
            json!({ "target_type": "message", "target_id": message_id, "reason": "harassment", "details": "launch safety smoke" }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(report["status"], "open");
    assert_eq!(report["server_id"], server_id);

    let queue: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{server_id}/mod-queue"),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(queue.as_array().unwrap().len(), 1);

    let report_id = report["id"].as_str().unwrap();
    let resolved: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/mod-queue/{report_id}/resolve"),
            &owner.token,
            json!({ "status": "resolved", "note": "handled" }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(resolved["status"], "resolved");

    let actions: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{server_id}/moderation-actions"),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(actions
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["action"] == "create_report"));
    assert!(actions
        .as_array()
        .unwrap()
        .iter()
        .any(|a| a["action"] == "report_resolved"));

    let user_report: Value = srv
        .post_json_auth(
            "/api/v1/reports",
            &owner.token,
            json!({ "target_type": "user", "target_id": member.id, "server_id": server_id, "reason": "spam" }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(user_report["server_id"], server_id);
    assert_eq!(user_report["accused_user_id"], member.id);
    let queue: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{server_id}/mod-queue"),
            &owner.token,
        )
        .await
        .json()
        .await
        .unwrap();
    assert!(queue
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["target_type"] == "user"));
}
