//! Joining a space by invite shows it on every device you're signed in on. Before, only
//! the device that joined listed it: the space told its members, but not the joiner's own
//! other sessions, which found out at their next reload.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};
use std::time::Duration;

#[tokio::test]
async fn a_space_you_join_appears_on_your_other_devices() {
    let srv = TestServer::start().await;
    let owner = srv.register("joinowner", "supersecret123").await;
    let joiner = srv.register("joinerdev", "supersecret123").await;
    let space: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &owner.token,
            json!({ "name": "Joined live" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let server_id = space["id"].as_str().unwrap().to_owned();
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

    // The joiner's other device, already online.
    let mut other = Gateway::connect(&srv, &joiner.token).await;
    other.wait_for(|ev| ev["t"] == "Ready").await;

    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &joiner.token, json!({}))
        .await;
    assert_eq!(res.status(), 200);

    let seen = tokio::time::timeout(
        Duration::from_secs(5),
        other.wait_for(|ev| ev["t"] == "ServerCreate" && ev["d"]["id"] == server_id.as_str()),
    )
    .await
    .expect("the space shows up on the other device");
    assert!(
        seen["d"]["channels"]
            .as_array()
            .is_some_and(|c| !c.is_empty()),
        "it arrives with its channels"
    );
}
