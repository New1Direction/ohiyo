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

/// S-L6: starting a group chat with someone who blocked you (or whom you blocked) was
/// refused, but adding them to a group you're already in went through.
#[tokio::test]
async fn a_block_also_stops_adding_someone_to_a_group() {
    let srv = TestServer::start().await;
    let alice = srv.register("groupalice", "supersecret123").await;
    let bob = srv.register("groupbob", "supersecret123").await;
    let carol = srv.register("groupcarol", "supersecret123").await;
    let blocked = srv
        .post_empty_auth(&format!("/api/v1/users/{}/block", bob.id), &alice.token)
        .await;
    assert_eq!(blocked.status(), 204);

    let group = |token: String| {
        let srv = &srv;
        let carol = carol.id.clone();
        async move {
            let res = srv
                .post_json_auth(
                    "/api/v1/users/@me/group-dms",
                    &token,
                    json!({ "recipient_ids": [carol], "name": "with carol" }),
                )
                .await;
            assert_eq!(res.status(), 200);
            res.json::<Value>().await.unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
    };
    let add = |token: String, channel: String, who: String| {
        let srv = &srv;
        async move {
            srv.post_json_auth(
                &format!("/api/v1/channels/{channel}/recipients"),
                &token,
                json!({ "user_id": who }),
            )
            .await
            .status()
        }
    };

    // Bob, whom Alice blocked, can't put her in his group.
    let bobs = group(bob.token.clone()).await;
    assert_eq!(
        add(bob.token.clone(), bobs.clone(), alice.id.clone()).await,
        403
    );
    let alices_chats: Value = srv
        .get_auth("/api/v1/users/@me/dms", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(
        !alices_chats
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["id"] == bobs.as_str()),
        "Alice wasn't added"
    );

    // And Alice can't put Bob in hers.
    let alices = group(alice.token.clone()).await;
    assert_eq!(add(alice.token.clone(), alices, bob.id.clone()).await, 403);
}
