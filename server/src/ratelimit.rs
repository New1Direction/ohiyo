use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// A tiny in-memory sliding-window rate limiter keyed by an arbitrary string
/// (e.g. "login:1.2.3.4" or "msg:<user_id>"). Good enough to blunt brute-force
/// and spam on a single-node deployment; swap for Redis if you scale out.
#[derive(Clone, Default)]
pub struct RateLimiter {
    hits: Arc<Mutex<HashMap<String, Vec<Instant>>>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an attempt for `key`; returns `true` if it's allowed (under `max`
    /// within `window`), `false` if the caller should be throttled.
    pub fn check(&self, key: &str, max: usize, window: Duration) -> bool {
        let now = Instant::now();
        let mut map = self.hits.lock().unwrap_or_else(|e| e.into_inner());

        // Opportunistic cleanup so the map can't grow unbounded.
        if map.len() > 10_000 {
            map.retain(|_, times| times.iter().any(|t| now.duration_since(*t) < window));
        }

        let times = map.entry(key.to_string()).or_default();
        times.retain(|t| now.duration_since(*t) < window);
        if times.len() >= max {
            return false;
        }
        times.push(now);
        true
    }
}
