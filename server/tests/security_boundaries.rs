//! Locks in the platform-hardening boundaries (PRs #17/#18):
//!  - the security-headers middleware decorates EVERY response, including error
//!    responses and non-API routes;
//!  - internal failures are mapped to a generic body that never leaks the
//!    underlying `sqlx`/IO error string.

mod common;

use common::TestServer;

/// The exact header set the production middleware promises on every response.
const EXPECTED_HEADERS: &[(&str, &str)] = &[
    ("x-content-type-options", "nosniff"),
    ("referrer-policy", "strict-origin-when-cross-origin"),
    ("x-frame-options", "DENY"),
    (
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
    ),
    (
        "strict-transport-security",
        "max-age=31536000; includeSubDomains",
    ),
];

fn assert_security_headers(res: &reqwest::Response, context: &str) {
    let headers = res.headers();
    for (name, expected) in EXPECTED_HEADERS {
        let got = headers
            .get(*name)
            .unwrap_or_else(|| panic!("[{context}] missing header {name}"))
            .to_str()
            .expect("header is valid utf-8");
        assert_eq!(got, *expected, "[{context}] header {name} mismatch");
    }
}

#[tokio::test]
async fn security_headers_present_on_healthz() {
    let srv = TestServer::start().await;
    let res = srv.client.get(srv.url("/healthz")).send().await.unwrap();
    assert_eq!(res.status(), 200);
    assert_security_headers(&res, "GET /healthz");
}

#[tokio::test]
async fn security_headers_present_on_unauthorized_api_response() {
    // The middleware must wrap error responses too — a 401 still gets the headers.
    let srv = TestServer::start().await;
    let res = srv
        .client
        .get(srv.url("/api/v1/users/@me"))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401, "missing token should be rejected");
    assert_security_headers(&res, "GET /api/v1/users/@me (no token)");
}

#[tokio::test]
async fn security_headers_present_on_successful_api_response() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;
    let res = srv.get_auth("/api/v1/users/@me", &alice.token).await;
    assert_eq!(res.status(), 200);
    assert_security_headers(&res, "GET /api/v1/users/@me (authed)");
}

#[tokio::test]
async fn validation_errors_do_not_leak_schema_details() {
    // A 400 from input validation should carry a short, human message — never a raw
    // DB/driver string. Guard against schema/driver leakage markers.
    let srv = TestServer::start().await;
    let res = srv
        .post_json(
            "/api/v1/auth/register",
            serde_json::json!({ "username": "x", "password": "short" }),
        )
        .await;
    assert_eq!(res.status(), 400);
    let body = res.text().await.unwrap().to_lowercase();
    for leak in [
        "no such column",
        "sqlite",
        "sqlx",
        "syntax error",
        "constraint failed",
    ] {
        assert!(
            !body.contains(leak),
            "error body leaked driver detail {leak:?}: {body:?}"
        );
    }
}

#[test]
fn internal_error_helper_returns_generic_body_and_hides_cause() {
    // The single chokepoint every 500 flows through. It MUST log-and-generalise:
    // the caller's (potentially sensitive) error text must not appear in the response.
    let sensitive = "table users has no column named secret_password_hash";
    let (status, body) = server::api::error::internal(sensitive);
    assert_eq!(status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(body, "internal error");
    assert!(
        !body.contains("users") && !body.contains("column"),
        "internal() leaked the underlying cause"
    );
}
