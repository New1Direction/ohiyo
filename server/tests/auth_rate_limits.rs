//! S-M2: auth rate limits key on an address the client can't choose. Proxy headers are
//! trusted only when the deployment says a proxy sets them (`FLY_APP_NAME` for
//! `Fly-Client-IP`, `TRUSTED_PROXY_HOPS` for `X-Forwarded-For`); otherwise the socket peer
//! is the key. This binary runs with neither set.

mod common;

use common::TestServer;
use serde_json::json;

/// Auth attempts allowed per client address per minute.
const AUTH_MAX_PER_MIN: usize = 40;

#[tokio::test]
async fn a_rotating_fly_client_ip_does_not_escape_the_per_ip_limit() {
    std::env::remove_var("FLY_APP_NAME");
    std::env::remove_var("TRUSTED_PROXY_HOPS");
    let srv = TestServer::start().await;

    let mut statuses = Vec::new();
    for i in 0..=AUTH_MAX_PER_MIN {
        let res = srv
            .client
            .post(srv.url("/api/v1/auth/login"))
            .header("fly-client-ip", format!("10.9.{}.{}", i / 250, i % 250 + 1))
            .header(
                "x-forwarded-for",
                format!("10.8.{}.{}", i / 250, i % 250 + 1),
            )
            .json(&json!({ "username": format!("nobody{i}"), "password": "password123" }))
            .send()
            .await
            .unwrap();
        statuses.push(res.status().as_u16());
    }

    assert!(
        statuses[..AUTH_MAX_PER_MIN].iter().all(|s| *s == 401),
        "{statuses:?}"
    );
    assert_eq!(
        statuses[AUTH_MAX_PER_MIN], 429,
        "the 41st attempt from one peer is throttled whatever the headers say"
    );
}
