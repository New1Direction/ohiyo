//! GIF search goes through the home's server to KLIPY. The server keeps the KLIPY key, sends
//! the search on without the person's IP address or any id of theirs, and hands back only what
//! the picker needs: KLIPY media links (https, KLIPY's own media hosts) with a title and size.
//! Without a key the answer says GIF search isn't available, and the app shows no GIFs tab.
//! A local server stands in for KLIPY here, answering in the shape its docs give
//! (https://docs.klipy.com/gifs-api/gifs-search-api).

mod common;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{Path, RawQuery, State},
    http::StatusCode,
    routing::get,
    Json, Router,
};
use common::TestServer;
use serde_json::{json, Value};
use server::api::gifs::Klipy;

const KEY: &str = "klipy-test-key-1";

#[derive(Clone, Copy)]
enum Answer {
    Results,
    Failure,
    Slow,
}

/// What the stand-in was asked: (key in the path, endpoint, raw query string).
#[derive(Clone, Default)]
struct Asked(Arc<Mutex<Vec<(String, String, String)>>>);

impl Asked {
    fn all(&self) -> Vec<(String, String, String)> {
        self.0.lock().unwrap().clone()
    }
}

fn media(url: &str, w: u32, h: u32) -> Value {
    json!({ "url": url, "width": w, "height": h, "size": 12345 })
}

/// KLIPY's documented answer, with one good GIF and two that must be dropped: one whose links
/// point somewhere other than KLIPY's media hosts, and one served over plain http.
fn klipy_answer(has_next: bool) -> Value {
    let good = json!({
        "id": 1001,
        "slug": "happy-dance-1001",
        "title": "Happy dance",
        "file": {
            "hd": { "gif": media("https://static.klipy.com/ii/a/hd.gif", 498, 280) },
            "md": {
                "gif": media("https://static.klipy.com/ii/a/md.gif", 320, 180),
                "webp": media("https://static.klipy.com/ii/a/md.webp", 320, 180)
            },
            "sm": {
                "gif": media("https://static2.klipy.com/ii/a/sm.gif", 220, 124),
                "webp": media("https://static1.klipy.com/ii/a/sm.webp", 220, 124)
            },
            "xs": { "gif": media("https://static.klipy.com/ii/a/xs.gif", 90, 50) }
        },
        "tags": ["dance", "happy"],
        "type": "gif",
        "blur_preview": "data:image/jpeg;base64,AAAA"
    });
    let elsewhere = json!({
        "id": 1002,
        "slug": "elsewhere",
        "title": "Elsewhere",
        "file": {
            "md": { "gif": media("https://tracker.example/md.gif", 320, 180) },
            "sm": { "webp": media("https://tracker.example/sm.webp", 220, 124) }
        },
        "type": "gif"
    });
    let plain_http = json!({
        "id": 1003,
        "slug": "plain",
        "title": "Plain http",
        "file": {
            "md": { "gif": media("http://static.klipy.com/ii/c/md.gif", 320, 180) },
            "sm": { "webp": media("http://static.klipy.com/ii/c/sm.webp", 220, 124) }
        },
        "type": "gif"
    });
    json!({
        "result": true,
        "data": { "data": [good, elsewhere, plain_http], "current_page": 1, "per_page": 24, "has_next": has_next }
    })
}

async fn answer(
    State((answer, asked, endpoint)): State<(Answer, Asked, &'static str)>,
    Path(key): Path<String>,
    RawQuery(query): RawQuery,
) -> (StatusCode, Json<Value>) {
    asked
        .0
        .lock()
        .unwrap()
        .push((key, endpoint.to_owned(), query.unwrap_or_default()));
    match answer {
        Answer::Results => (StatusCode::OK, Json(klipy_answer(endpoint == "trending"))),
        Answer::Failure => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "result": false })),
        ),
        Answer::Slow => {
            tokio::time::sleep(Duration::from_secs(5)).await;
            (StatusCode::OK, Json(klipy_answer(false)))
        }
    }
}

/// Start the stand-in for KLIPY; returns its base URL and what it gets asked.
async fn fake_klipy(kind: Answer) -> (String, Asked) {
    let asked = Asked::default();
    let search = Router::new()
        .route("/api/v1/{key}/gifs/search", get(answer))
        .with_state((kind, asked.clone(), "search"));
    let trending = Router::new()
        .route("/api/v1/{key}/gifs/trending", get(answer))
        .with_state((kind, asked.clone(), "trending"));
    let app = search.merge(trending);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), asked)
}

async fn start_with_klipy(base_url: &str, timeout: Duration) -> TestServer {
    let klipy = Klipy::new(KEY)
        .with_base_url(base_url)
        .with_timeout(timeout);
    TestServer::start_with(move |state| state.klipy = Some(klipy)).await
}

fn param(query: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

#[tokio::test]
async fn without_a_klipy_key_gif_search_says_it_is_unavailable() {
    let srv = TestServer::start().await;
    let me = srv.register("gifless", "password123").await;

    for path in ["/api/v1/gifs/search?q=cat", "/api/v1/gifs/trending"] {
        let res = srv.get_auth(path, &me.token).await;
        assert_eq!(res.status(), 200, "{path}");
        let body: Value = res.json().await.unwrap();
        assert_eq!(body["available"], false, "{path}");
        assert_eq!(body["results"], json!([]), "{path}");
    }
}

#[tokio::test]
async fn a_search_goes_to_klipy_through_the_server_and_comes_back_trimmed_to_klipy_media() {
    let (base, asked) = fake_klipy(Answer::Results).await;
    let srv = start_with_klipy(&base, Duration::from_secs(3)).await;
    let me = srv.register("gifsearcher", "password123").await;

    let res = srv
        .get_auth("/api/v1/gifs/search?q=happy%20dance", &me.token)
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["available"], true);

    let results = body["results"].as_array().unwrap();
    assert_eq!(
        results.len(),
        1,
        "only the GIF served from KLIPY's media hosts over https: {body}"
    );
    let gif = &results[0];
    assert_eq!(
        gif,
        &json!({
            "id": "1001",
            "title": "Happy dance",
            "url": "https://static.klipy.com/ii/a/md.gif",
            "preview": "https://static1.klipy.com/ii/a/sm.webp",
            "width": 320,
            "height": 180
        }),
        "just what the picker needs: no tags, no blur preview, no slug"
    );
    assert!(
        !body.to_string().contains(KEY),
        "the key never reaches the app"
    );

    let asked = asked.all();
    assert_eq!(asked.len(), 1);
    let (key, endpoint, query) = &asked[0];
    assert_eq!(key, KEY);
    assert_eq!(endpoint, "search");
    assert_eq!(param(query, "q").as_deref(), Some("happy dance"));
    assert_eq!(param(query, "page").as_deref(), Some("1"));
    assert_eq!(param(query, "per_page").as_deref(), Some("24"));
    assert_eq!(param(query, "content_filter").as_deref(), Some("medium"));
    assert_eq!(
        param(query, "customer_id"),
        None,
        "nothing that identifies the person goes to KLIPY"
    );
}

#[tokio::test]
async fn trending_works_and_pages_through() {
    let (base, asked) = fake_klipy(Answer::Results).await;
    let srv = start_with_klipy(&base, Duration::from_secs(3)).await;
    let me = srv.register("giftrend", "password123").await;

    let res = srv
        .get_auth("/api/v1/gifs/trending?page=2", &me.token)
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["available"], true);
    assert_eq!(body["page"], 2);
    assert_eq!(body["has_next"], true);
    assert_eq!(body["results"].as_array().unwrap().len(), 1);

    let asked = asked.all();
    assert_eq!(asked[0].1, "trending");
    assert_eq!(param(&asked[0].2, "page").as_deref(), Some("2"));
}

#[tokio::test]
async fn gif_search_needs_a_signed_in_person() {
    let (base, _asked) = fake_klipy(Answer::Results).await;
    let srv = start_with_klipy(&base, Duration::from_secs(3)).await;
    let res = srv.get("/api/v1/gifs/search?q=cat").await;
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn an_empty_or_overlong_search_or_an_odd_page_is_refused() {
    let (base, asked) = fake_klipy(Answer::Results).await;
    let srv = start_with_klipy(&base, Duration::from_secs(3)).await;
    let me = srv.register("gifodd", "password123").await;

    let long = "a".repeat(101);
    for path in [
        "/api/v1/gifs/search?q=".to_owned(),
        "/api/v1/gifs/search?q=%20%20".to_owned(),
        "/api/v1/gifs/search".to_owned(),
        format!("/api/v1/gifs/search?q={long}"),
        "/api/v1/gifs/search?q=cat&page=0".to_owned(),
        "/api/v1/gifs/trending?page=51".to_owned(),
    ] {
        let res = srv.get_auth(&path, &me.token).await;
        assert_eq!(res.status(), 400, "{path}");
    }
    assert!(asked.all().is_empty(), "nothing odd goes to KLIPY");
}

#[tokio::test]
async fn klipy_failing_or_slow_is_a_plain_502_in_good_time() {
    let (base, _asked) = fake_klipy(Answer::Failure).await;
    let srv = start_with_klipy(&base, Duration::from_secs(3)).await;
    let me = srv.register("giffail", "password123").await;
    let res = srv.get_auth("/api/v1/gifs/search?q=cat", &me.token).await;
    assert_eq!(res.status(), 502);
    let text = res.text().await.unwrap();
    assert!(!text.contains(KEY), "an error never shows the key");

    let (slow_base, _slow_asked) = fake_klipy(Answer::Slow).await;
    let slow = start_with_klipy(&slow_base, Duration::from_millis(800)).await;
    let me = slow.register("gifslow", "password123").await;
    let started = Instant::now();
    let res = slow.get_auth("/api/v1/gifs/trending", &me.token).await;
    assert_eq!(res.status(), 502);
    assert!(
        started.elapsed() < Duration::from_secs(3),
        "gives up instead of hanging"
    );
}

#[tokio::test]
async fn searches_are_limited_per_account() {
    let (base, _asked) = fake_klipy(Answer::Results).await;
    let srv = start_with_klipy(&base, Duration::from_secs(3)).await;
    let me = srv.register("gifspam", "password123").await;
    for i in 0..30 {
        let res = srv
            .get_auth(&format!("/api/v1/gifs/search?q=cat{i}"), &me.token)
            .await;
        assert_eq!(res.status(), 200, "search {i}");
    }
    let res = srv.get_auth("/api/v1/gifs/search?q=more", &me.token).await;
    assert_eq!(res.status(), 429);
}
