//! Message history paging. S-M6: `limit` is clamped to 1..=100, so a zero or negative
//! limit can't return the whole channel.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

async fn channel_with_messages(srv: &TestServer, owner: &AuthOk, count: usize) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Paging" }))
        .await
        .json()
        .await
        .unwrap();
    let channel_id = server["channels"][0]["id"].as_str().unwrap().to_owned();
    for i in 0..count {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/channels/{channel_id}/messages"),
                &owner.token,
                json!({ "content": format!("message {i}") }),
            )
            .await;
        assert_eq!(res.status(), 200);
    }
    channel_id
}

async fn page(srv: &TestServer, token: &str, channel_id: &str, query: &str) -> Vec<Value> {
    let res = srv
        .get_auth(
            &format!("/api/v1/channels/{channel_id}/messages?{query}"),
            token,
        )
        .await;
    assert_eq!(res.status(), 200, "{query}");
    res.json::<Vec<Value>>().await.unwrap()
}

#[tokio::test]
async fn zero_and_negative_limits_return_one_message() {
    let srv = TestServer::start().await;
    let owner = srv.register("pageowner", "password123").await;
    let channel_id = channel_with_messages(&srv, &owner, 3).await;

    for limit in ["-1", "0"] {
        let got = page(&srv, &owner.token, &channel_id, &format!("limit={limit}")).await;
        assert_eq!(got.len(), 1, "limit={limit} is clamped to 1");
    }
    assert_eq!(page(&srv, &owner.token, &channel_id, "limit=2").await.len(), 2);
}
