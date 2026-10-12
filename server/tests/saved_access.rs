//! S-L5: a saved message stayed in your Saved list, readable, after you lost access to
//! where it was posted (you left the space, or were removed from it). Saved now shows
//! only messages you can still see.

mod common;

use common::TestServer;
use serde_json::{json, Value};

#[tokio::test]
async fn a_saved_message_leaves_saved_with_your_access() {
    let srv = TestServer::start().await;
    let owner = srv.register("savedowner", "supersecret123").await;
    let member = srv.register("savedmember", "supersecret123").await;
    let space: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Saved" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = space["id"].as_str().unwrap().to_owned();
    let channel = space["channels"][0]["id"].as_str().unwrap().to_owned();
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
    let joined = srv
        .post_json_auth(
            &format!("/api/v1/invites/{}", invite["code"].as_str().unwrap()),
            &member.token,
            json!({}),
        )
        .await;
    assert_eq!(joined.status(), 200);

    let message: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel}/messages"),
            &owner.token,
            json!({ "content": "members only" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let message = message["id"].as_str().unwrap().to_owned();
    let saved = srv
        .post_empty_auth(
            &format!("/api/v1/channels/{channel}/messages/{message}/save"),
            &member.token,
        )
        .await;
    assert_eq!(saved.status(), 204);
    let count = |list: Value| list.as_array().map_or(0, Vec::len);
    let list: Value = srv
        .get_auth("/api/v1/users/@me/saved", &member.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(count(list), 1, "saved while a member");

    let left = srv
        .post_empty_auth(&format!("/api/v1/servers/{server_id}/leave"), &member.token)
        .await;
    assert_eq!(left.status(), 204);
    let list: Value = srv
        .get_auth("/api/v1/users/@me/saved", &member.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(count(list), 0, "gone from Saved once they left");
}
