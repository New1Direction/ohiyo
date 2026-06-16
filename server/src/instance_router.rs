//! Instant-Servers edge router.
//!
//! The main backend doubles as the front door for `*.ohiyo.gg`. For a community
//! subdomain (`yourcrew.ohiyo.gg`) it looks the instance up in the `hosted_instances`
//! registry and replays the request straight to that community's machine using Fly's
//! `fly-replay` header — Fly intercepts it and routes inside its network, so the body
//! never reaches the client. Every other Host (the apex, `api.`, the `.fly.dev` URL,
//! `localhost`) passes through to the normal API untouched.

use crate::AppState;
use axum::{
    body::Body,
    extract::{Request, State},
    http::{header::HOST, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};

/// Middleware: replay community-subdomain requests to their machine; pass everything else through.
pub async fn instance_router(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let Some(sub) = community_subdomain(req.headers().get(HOST)) else {
        return next.run(req).await;
    };

    let machine_id: Option<String> = sqlx::query_scalar(
        "SELECT machine_id FROM hosted_instances
         WHERE subdomain = ? AND status = 'healthy' AND machine_id IS NOT NULL",
    )
    .bind(&sub)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();

    match machine_id {
        Some(id) => fly_replay(&id),
        None => (StatusCode::NOT_FOUND, "no Ohiyo server lives here yet").into_response(),
    }
}

/// The single-label community subdomain of `ohiyo.gg`, or `None` for the apex, reserved
/// names (`www`/`api`/`app`), multi-level hosts, and any non-`ohiyo.gg` host.
fn community_subdomain(host: Option<&HeaderValue>) -> Option<String> {
    let host = host?.to_str().ok()?.to_ascii_lowercase();
    let hostname = host.split(':').next().unwrap_or(""); // strip :port
    let label = hostname.strip_suffix(".ohiyo.gg")?;
    if label.is_empty() || label.contains('.') || matches!(label, "www" | "api" | "app") {
        return None;
    }
    Some(label.to_string())
}

/// The `fly-replay` response that hands the request to a specific machine in the instances
/// app. Fly consumes it internally; the empty body never reaches the client.
fn fly_replay(machine_id: &str) -> Response {
    let app = std::env::var("FLY_INSTANCES_APP").unwrap_or_else(|_| "ohiyo-instances".into());
    let mut res = Response::new(Body::empty());
    if let Ok(v) = HeaderValue::from_str(&format!("app={app};instance={machine_id}")) {
        res.headers_mut().insert("fly-replay", v);
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(h: &str) -> Option<String> {
        community_subdomain(Some(&HeaderValue::from_str(h).unwrap()))
    }

    #[test]
    fn routes_community_subdomains() {
        assert_eq!(sub("yourcrew.ohiyo.gg").as_deref(), Some("yourcrew"));
        assert_eq!(
            sub("the-roost-a1b2c3.ohiyo.gg").as_deref(),
            Some("the-roost-a1b2c3")
        );
        assert_eq!(sub("YOURCREW.OHIYO.GG").as_deref(), Some("yourcrew"));
        assert_eq!(sub("yourcrew.ohiyo.gg:443").as_deref(), Some("yourcrew"));
    }

    #[test]
    fn ignores_apex_reserved_and_foreign_hosts() {
        for h in [
            "ohiyo.gg",
            "www.ohiyo.gg",
            "api.ohiyo.gg",
            "app.ohiyo.gg",
            "a.b.ohiyo.gg",
            "ohiyo.fly.dev",
            "localhost",
        ] {
            assert_eq!(sub(h), None, "{h} must not route as a community subdomain");
        }
    }

    #[test]
    fn fly_replay_targets_app_and_machine() {
        let res = fly_replay("abc123");
        let v = res.headers().get("fly-replay").unwrap().to_str().unwrap();
        assert!(v.starts_with("app=ohiyo-instances"), "got {v}");
        assert!(v.contains("instance=abc123"), "got {v}");
    }
}
