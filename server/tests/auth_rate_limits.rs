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

/// Login attempts allowed per username per minute, from any number of addresses.
const LOGIN_MAX_PER_USERNAME_PER_MIN: usize = 10;

#[tokio::test]
async fn logins_for_one_username_are_limited_to_10_a_minute() {
    std::env::remove_var("FLY_APP_NAME");
    std::env::remove_var("TRUSTED_PROXY_HOPS");
    let srv = TestServer::start().await;
    srv.register("victim", "password123").await;
    srv.register("bystander", "password123").await;
    let login = |username: &'static str, password: &'static str| {
        srv.post_json(
            "/api/v1/auth/login",
            json!({ "username": username, "password": password }),
        )
    };

    for _ in 0..LOGIN_MAX_PER_USERNAME_PER_MIN {
        assert_eq!(login("victim", "wrong-guess").await.status(), 401);
    }
    assert_eq!(
        login("victim", "wrong-guess").await.status(),
        429,
        "the 11th attempt on one username is throttled"
    );
    assert_eq!(
        login("victim", "password123").await.status(),
        429,
        "even with the right password, until the minute is up"
    );
    assert_eq!(
        login("bystander", "password123").await.status(),
        200,
        "other usernames are unaffected"
    );
}

#[tokio::test]
async fn a_flood_of_address_keys_does_not_lock_out_signed_in_users() {
    let srv = TestServer::start().await;
    let alice = srv.register("floodsurvivor", "password123").await;
    let server: serde_json::Value = srv
        .post_json_auth("/api/v1/servers", &alice.token, json!({ "name": "Flood" }))
        .await
        .json()
        .await
        .unwrap();
    let channel_id = server["channels"][0]["id"].as_str().unwrap().to_owned();

    // Made-up addresses and usernames fill the unauthenticated key map to its cap.
    let window = std::time::Duration::from_secs(60);
    for i in 0..100_000 {
        srv.state
            .rate
            .check_unauth(&format!("auth:flood{i}"), 40, window);
    }
    assert_eq!(
        srv.state.rate.tracked_unauth_keys(),
        100_000,
        "the unauthenticated map is full"
    );

    // Alice's message-send key is new, and is accepted and limited as usual (30 / 10 s).
    let path = format!("/api/v1/channels/{channel_id}/messages");
    let send = || srv.post_json_auth(&path, &alice.token, json!({ "content": "still here" }));
    for _ in 0..30 {
        assert_eq!(send().await.status(), 200);
    }
    assert_eq!(send().await.status(), 429, "her own limit still applies");
}

#[tokio::test]
async fn a_login_for_an_unknown_username_creates_no_username_key() {
    std::env::remove_var("FLY_APP_NAME");
    std::env::remove_var("TRUSTED_PROXY_HOPS");
    let srv = TestServer::start().await;

    // Past the 10-a-minute username limit, an unknown username still gets the plain
    // "invalid credentials" answer: only the per-address limit (40) counts it.
    for _ in 0..=LOGIN_MAX_PER_USERNAME_PER_MIN {
        let res = srv
            .post_json(
                "/api/v1/auth/login",
                json!({ "username": "nobodyhere", "password": "password123" }),
            )
            .await;
        assert_eq!(res.status(), 401);
    }
}

/// Registrations allowed per client address per hour.
const REGISTER_MAX_PER_HOUR: usize = 10;

#[tokio::test]
async fn registration_is_limited_to_10_an_hour_per_address_and_login_is_not() {
    std::env::remove_var("FLY_APP_NAME");
    std::env::remove_var("TRUSTED_PROXY_HOPS");
    let srv = TestServer::start().await;
    let register = |i: usize| {
        srv.post_json(
            "/api/v1/auth/register",
            json!({ "username": format!("newcomer{i}"), "password": "password123" }),
        )
    };

    for i in 0..REGISTER_MAX_PER_HOUR {
        assert_eq!(register(i).await.status(), 200, "registration {}", i + 1);
    }
    assert_eq!(
        register(REGISTER_MAX_PER_HOUR).await.status(),
        429,
        "the 11th registration from one address in an hour"
    );

    let res = srv
        .post_json(
            "/api/v1/auth/login",
            json!({ "username": "newcomer0", "password": "password123" }),
        )
        .await;
    assert_eq!(
        res.status(),
        200,
        "logging in from that address still works"
    );
}
