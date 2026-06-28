mod common;

use common::TestServer;
use serde_json::Value;

#[tokio::test]
async fn public_status_summary_has_safe_components() {
    let srv = TestServer::start().await;
    let res = srv.get("/api/v1/reliability/status").await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["ok"], true);
    assert!(body["uptime_seconds"].as_i64().unwrap() >= 0);
    let components = body["components"].as_array().unwrap();
    for expected in [
        "database",
        "gateway",
        "voice",
        "instant_servers",
        "push_relay",
    ] {
        assert!(
            components.iter().any(|c| c["name"] == expected),
            "missing {expected}"
        );
    }
    let serialized = body.to_string();
    assert!(!serialized.contains("JWT_SECRET"));
    assert!(!serialized.contains("password"));
}

#[tokio::test]
async fn cost_model_is_public_and_parameterized() {
    let srv = TestServer::start().await;
    let res = srv
        .get("/api/v1/reliability/cost-model?communities=25&paid=5&free_active_ratio=0.2")
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["communities"], 25);
    assert_eq!(body["paid"], 5);
    assert_eq!(body["free"], 20);
    assert!(body["estimated_monthly_usd"].as_f64().unwrap() > 0.0);
    assert!(body["assumptions"].as_array().unwrap().len() >= 5);
}
