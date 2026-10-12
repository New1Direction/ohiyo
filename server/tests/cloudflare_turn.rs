//! Calls that can't connect directly go through Cloudflare's TURN relay. The server
//! keeps the long-term TURN key and asks Cloudflare for short-lived credentials each
//! time someone joins a call; the browser only ever sees those. When Cloudflare fails or
//! is slow, the call still gets the direct-only answer in time. A local server stands in
//! for Cloudflare here, answering in the shape its docs give.

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use common::{now_unix, TestServer};
use serde_json::{json, Value};
use server::api::ice::CloudflareTurn;

const KEY_ID: &str = "turn-key-1";
const API_TOKEN: &str = "turn-api-token-1";

#[derive(Clone, Copy)]
enum Answer {
    Credentials,
    Failure,
    Slow,
}

/// What the stand-in was asked: (TURN key id in the path, Authorization header, body).
#[derive(Clone, Default)]
struct Asked(Arc<Mutex<Vec<(String, String, Value)>>>);

impl Asked {
    fn all(&self) -> Vec<(String, String, Value)> {
        self.0.lock().unwrap().clone()
    }
}

/// Cloudflare's documented 201 answer. Its notes say the list also carries URLs on the
/// alternate port 53, which browsers block, so the stand-in includes those too.
fn cloudflare_answer() -> Value {
    json!({ "iceServers": [
        { "urls": ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
        {
            "urls": [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:3478?transport=tcp",
                "turn:turn.cloudflare.com:80?transport=tcp",
                "turns:turn.cloudflare.com:5349?transport=tcp",
                "turns:turn.cloudflare.com:443?transport=tcp"
            ],
            "username": "cf-user",
            "credential": "cf-credential"
        }
    ]})
}

async fn generate(
    State((answer, asked)): State<(Answer, Asked)>,
    Path(key_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let authorization = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    asked.0.lock().unwrap().push((key_id, authorization, body));
    match answer {
        Answer::Credentials => (StatusCode::CREATED, Json(cloudflare_answer())),
        Answer::Failure => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "unavailable" })),
        ),
        Answer::Slow => {
            tokio::time::sleep(Duration::from_secs(5)).await;
            (StatusCode::CREATED, Json(cloudflare_answer()))
        }
    }
}

/// Start the stand-in for Cloudflare; returns its base URL and what it gets asked.
async fn fake_cloudflare(answer: Answer) -> (String, Asked) {
    let asked = Asked::default();
    let app = Router::new()
        .route(
            "/v1/turn/keys/{key_id}/credentials/generate-ice-servers",
            post(generate),
        )
        .with_state((answer, asked.clone()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), asked)
}

async fn start_with_cloudflare(base_url: &str, timeout: Duration) -> TestServer {
    let turn = CloudflareTurn::new(KEY_ID, API_TOKEN)
        .with_base_url(base_url)
        .with_timeout(timeout);
    TestServer::start_with(move |state| state.cloudflare_turn = Some(turn)).await
}

async fn ice_servers(srv: &TestServer, token: &str) -> Value {
    let res = srv.get_auth("/api/v1/ice-servers", token).await;
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

/// The entry carrying Cloudflare's credentials, if the answer has one.
fn relay(answer: &Value) -> Option<Value> {
    answer["iceServers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["username"] == "cf-user")
        .cloned()
}

fn all_urls(answer: &Value) -> Vec<String> {
    answer["iceServers"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| s["urls"].as_array().unwrap().clone())
        .map(|u| u.as_str().unwrap().to_owned())
        .collect()
}

const DIRECT_ONLY: &str =
    r#"{"iceServers":[{"urls":["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]}]}"#;

#[tokio::test]
async fn a_caller_gets_cloudflare_relay_credentials_minted_with_the_server_key() {
    let (base, asked) = fake_cloudflare(Answer::Credentials).await;
    let srv = start_with_cloudflare(&base, Duration::from_secs(3)).await;
    let caller = srv.register("caller", "password123").await;

    let answer = ice_servers(&srv, &caller.token).await;

    let relay = relay(&answer).expect("the answer carries Cloudflare's relay");
    assert_eq!(relay["credential"], "cf-credential");
    let urls = relay["urls"].as_array().unwrap();
    assert!(urls.contains(&json!("turn:turn.cloudflare.com:3478?transport=udp")));
    assert!(urls.contains(&json!("turns:turn.cloudflare.com:443?transport=tcp")));
    // The STUN servers already served stay first, so direct connections are tried as before.
    assert_eq!(
        answer["iceServers"][0]["urls"][0],
        "stun:stun.l.google.com:19302"
    );
    let expires = answer["ttlExpiresAt"]
        .as_i64()
        .expect("an expiry for the credentials");
    assert!(
        (expires - (now_unix() + 86_400)).abs() < 60,
        "expires in a day"
    );

    let asked = asked.all();
    assert_eq!(asked.len(), 1, "one request to Cloudflare per join");
    let (key_id, authorization, body) = &asked[0];
    assert_eq!(key_id, KEY_ID);
    assert_eq!(authorization, &format!("Bearer {API_TOKEN}"));
    assert_eq!(body, &json!({ "ttl": 86_400 }));
    // The long-term key never reaches the browser.
    assert!(!answer.to_string().contains(API_TOKEN));
}

#[tokio::test]
async fn urls_on_port_53_are_left_out_because_browsers_block_them() {
    let (base, _) = fake_cloudflare(Answer::Credentials).await;
    let srv = start_with_cloudflare(&base, Duration::from_secs(3)).await;
    let caller = srv.register("caller", "password123").await;

    let answer = ice_servers(&srv, &caller.token).await;

    let urls = all_urls(&answer);
    assert!(urls.contains(&"stun:stun.cloudflare.com:3478".to_owned()));
    assert!(urls.contains(&"turn:turn.cloudflare.com:3478?transport=udp".to_owned()));
    assert!(
        !urls.contains(&"stun:stun.cloudflare.com:53".to_owned()),
        "{urls:?}"
    );
    assert!(
        !urls.contains(&"turn:turn.cloudflare.com:53?transport=udp".to_owned()),
        "{urls:?}"
    );
}

#[tokio::test]
async fn when_cloudflare_fails_the_call_still_gets_the_direct_only_answer() {
    let (base, asked) = fake_cloudflare(Answer::Failure).await;
    let srv = start_with_cloudflare(&base, Duration::from_secs(3)).await;
    let caller = srv.register("caller", "password123").await;

    let answer = ice_servers(&srv, &caller.token).await;

    assert_eq!(asked.all().len(), 1, "Cloudflare was asked");
    assert_eq!(answer.to_string(), DIRECT_ONLY);
}

#[tokio::test]
async fn a_slow_cloudflare_does_not_hold_up_joining_a_call() {
    let (base, asked) = fake_cloudflare(Answer::Slow).await;
    let srv = start_with_cloudflare(&base, Duration::from_millis(300)).await;
    let caller = srv.register("caller", "password123").await;

    let started = Instant::now();
    let answer = ice_servers(&srv, &caller.token).await;

    assert!(
        started.elapsed() < Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(asked.all().len(), 1, "Cloudflare was asked");
    assert_eq!(answer.to_string(), DIRECT_ONLY);
}

#[tokio::test]
async fn without_a_cloudflare_key_the_answer_is_unchanged() {
    let srv = TestServer::start().await;
    let caller = srv.register("caller", "password123").await;

    let answer = ice_servers(&srv, &caller.token).await;

    assert_eq!(answer.to_string(), DIRECT_ONLY);
}

#[tokio::test]
async fn one_account_asking_over_and_over_stops_reaching_cloudflare() {
    // Joining a call asks once. The server asks Cloudflare at most 20 times a minute for
    // one account; past that the account gets the direct-only answer.
    let (base, asked) = fake_cloudflare(Answer::Credentials).await;
    let srv = start_with_cloudflare(&base, Duration::from_secs(3)).await;
    let caller = srv.register("caller", "password123").await;

    for _ in 0..20 {
        let answer = ice_servers(&srv, &caller.token).await;
        assert!(relay(&answer).is_some());
    }
    let answer = ice_servers(&srv, &caller.token).await;

    assert_eq!(asked.all().len(), 20);
    assert_eq!(answer.to_string(), DIRECT_ONLY);

    // Somebody else joining is not held back by that account.
    let other = srv.register("other", "password123").await;
    assert!(relay(&ice_servers(&srv, &other.token).await).is_some());
}
