//! S-H8 follow-up: when a web push registration is refused because its host is not on
//! the allowlist, the host is logged so a real push service we missed shows up. Only the
//! host: the rest of a push endpoint URL is the subscription's secret.
//!
//! The handler logs from the server's own tasks, so this binary installs a process-wide
//! subscriber that keeps every event from the push module. Its own binary, so nothing
//! else runs under that subscriber.

mod common;

use std::sync::Mutex;

use common::TestServer;
use serde_json::json;
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, SubscriberExt};

static PUSH_EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

struct KeepPushEvents;

struct Fields(String);

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.0.push_str(&format!("{}={value} ", field.name()));
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.0.push_str(&format!("{}={value:?} ", field.name()));
    }
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for KeepPushEvents {
    fn on_event(&self, event: &tracing::Event<'_>, _: Context<'_, S>) {
        if !event.metadata().target().starts_with("server::api::push") {
            return;
        }
        let mut fields = Fields(String::new());
        event.record(&mut fields);
        PUSH_EVENTS.lock().unwrap().push(fields.0);
    }
}

#[tokio::test]
async fn a_refused_web_push_host_is_logged_without_its_path_or_token() {
    tracing::subscriber::set_global_default(tracing_subscriber::registry().with(KeepPushEvents))
        .expect("install the capturing subscriber");
    let srv = TestServer::start().await;
    let alice = srv.register("unlistedpush", "supersecret123").await;

    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &alice.token,
            json!({
                "platform": "web",
                "endpoint": "https://push.unlisted.example/send/SECRET-SUBSCRIPTION-TOKEN?auth=QUERY-SECRET",
                "p256dh": "k",
                "auth": "a",
            }),
        )
        .await;
    assert_eq!(res.status(), 400);

    let events = PUSH_EVENTS.lock().unwrap().clone();
    assert!(
        events.iter().any(|e| e.contains("push.unlisted.example")),
        "the refused host is logged: {events:?}"
    );
    for secret in ["SECRET-SUBSCRIPTION-TOKEN", "QUERY-SECRET", "/send/"] {
        assert!(
            events.iter().all(|e| !e.contains(secret)),
            "{secret} must never be logged: {events:?}"
        );
    }
}
