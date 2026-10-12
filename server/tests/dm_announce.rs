//! A new 1:1 DM is announced live, like a new group chat. Without it the person being
//! messaged saw nothing (an unread count for a chat missing from their list) until they
//! reloaded, and the starter's other devices didn't list it either.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};

#[tokio::test]
async fn a_new_dm_is_announced_to_both_people() {
    let srv = TestServer::start().await;
    let ann = srv.register("announcer", "supersecret123").await;
    let bea = srv.register("announcee", "supersecret123").await;

    let mut bea_gw = Gateway::connect(&srv, &bea.token).await;
    bea_gw.wait_for(|ev| ev["t"] == "Ready").await;
    // Ann's other device, already online.
    let mut ann_gw = Gateway::connect(&srv, &ann.token).await;
    ann_gw.wait_for(|ev| ev["t"] == "Ready").await;

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
    let dm_id = dm["id"].as_str().unwrap().to_owned();

    let seen = bea_gw
        .wait_for(|ev| ev["t"] == "ChannelCreate" && ev["d"]["id"] == dm_id)
        .await;
    assert_eq!(seen["d"]["channel_type"], json!("dm"));
    ann_gw
        .wait_for(|ev| ev["t"] == "ChannelCreate" && ev["d"]["id"] == dm_id)
        .await;
}
