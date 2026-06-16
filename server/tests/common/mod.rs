//! Shared integration-test harness.
//!
//! Each test boots the *real* application — `server::build_app` over a freshly
//! migrated SQLite database — on an ephemeral loopback port, then drives it with a
//! real HTTP client. This exercises the exact middleware stack that ships
//! (security-headers layer, CORS, body limit) and the real `ConnectInfo` plumbing
//! that IP-based rate limiting depends on, rather than a hand-rolled approximation
//! that could silently drift from production.
//!
//! Not every helper here is used by every test binary (each `tests/*.rs` file is a
//! separate crate that re-compiles this module), so dead-code warnings are expected
//! and silenced.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Once;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// A throwaway SQLite database file (plus its WAL/SHM sidecars) removed on drop.
///
/// A file-backed DB is mandatory: `:memory:` with the pool's `max_connections = 16`
/// would hand each connection its *own* empty in-memory database, so migrations and
/// inserts would appear to vanish at random.
struct TempDb {
    url: String,
    path: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!("kikkacord-test-{}.db", uuid::Uuid::new_v4()));
        let url = format!("sqlite:{}", path.display());
        TempDb { url, path }
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut p = self.path.clone().into_os_string();
            p.push(suffix);
            let _ = std::fs::remove_file(p);
        }
    }
}

static JWT: Once = Once::new();

/// A running test server: base URL + a reqwest client, backed by a temp DB that is
/// cleaned up when this value drops.
pub struct TestServer {
    pub base: String,
    pub client: reqwest::Client,
    db: TempDb,
}

/// The useful bits of a successful auth response.
pub struct AuthOk {
    pub id: String,
    pub token: String,
}

impl TestServer {
    pub async fn start() -> Self {
        // One deterministic signing secret for the whole binary. Set before any
        // request is served so the `AuthUser` extractor (which reads the env at
        // request time) sees it. `Once` avoids a set_var race between parallel tests.
        JWT.call_once(|| {
            std::env::set_var("JWT_SECRET", "integration-test-secret-not-for-production");
        });

        let db = TempDb::new();
        let pool = server::db::connect(&db.url)
            .await
            .expect("connect + migrate test database");
        let app = server::build_app(server::build_state(pool));

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .expect("serve");
        });

        TestServer {
            base: format!("http://{addr}"),
            client: reqwest::Client::new(),
            db,
        }
    }

    pub fn url(&self, path: &str) -> String {
        format!("{}{}", self.base, path)
    }

    /// Direct connection string for the underlying DB — for the rare test that needs
    /// to assert on or seed state below the HTTP boundary (e.g. an expired token row).
    pub fn db_url(&self) -> &str {
        &self.db.url
    }

    // ── Raw request helpers (all paths are absolute, e.g. "/api/v1/auth/login") ──

    pub async fn post_json(&self, path: &str, body: Value) -> reqwest::Response {
        self.client
            .post(self.url(path))
            .json(&body)
            .send()
            .await
            .expect("request sent")
    }

    pub async fn post_json_auth(&self, path: &str, token: &str, body: Value) -> reqwest::Response {
        self.client
            .post(self.url(path))
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .expect("request sent")
    }

    /// POST with a bearer token and no body (for handlers that take no body extractor).
    pub async fn post_empty_auth(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .post(self.url(path))
            .bearer_auth(token)
            .send()
            .await
            .expect("request sent")
    }

    pub async fn get_auth(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .get(self.url(path))
            .bearer_auth(token)
            .send()
            .await
            .expect("request sent")
    }

    pub async fn delete_auth(&self, path: &str, token: &str) -> reqwest::Response {
        self.client
            .delete(self.url(path))
            .bearer_auth(token)
            .send()
            .await
            .expect("request sent")
    }

    /// Register a fresh account, asserting success, and return its id + token.
    pub async fn register(&self, username: &str, password: &str) -> AuthOk {
        let res = self
            .post_json(
                "/api/v1/auth/register",
                serde_json::json!({ "username": username, "password": password }),
            )
            .await;
        assert_eq!(
            res.status(),
            200,
            "register({username}) should succeed; got {}",
            res.status()
        );
        let body: Value = res.json().await.expect("register json");
        AuthOk {
            id: body["user"]["id"]
                .as_str()
                .expect("user.id present")
                .to_owned(),
            token: body["token"].as_str().expect("token present").to_owned(),
        }
    }
}

/// Current unix time in seconds (matches the server's token-expiry arithmetic).
pub fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_secs() as i64
}
