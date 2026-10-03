use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Most distinct keys tracked at once. When full and nothing has expired, a request for
/// a new key is refused (throttled) while existing keys keep working, so a flood of
/// distinct keys can't grow the map.
const MAX_KEYS: usize = 100_000;

/// Above this many keys, expired ones are swept, at most once per [`SWEEP_INTERVAL`].
const SWEEP_ABOVE: usize = 10_000;

/// Minimum gap between sweeps, so the O(n) scan is amortised rather than per call.
const SWEEP_INTERVAL: Duration = Duration::from_secs(10);

/// Longest key kept, in bytes. Longer keys (an attacker-chosen username, say) are cut
/// on a character boundary; keys sharing their first 128 bytes share a counter.
const MAX_KEY_BYTES: usize = 128;

/// A tiny in-memory sliding-window rate limiter keyed by an arbitrary string
/// (e.g. "login:1.2.3.4" or "msg:<user_id>"). Good enough to blunt brute-force
/// and spam on a single-node deployment; swap for Redis if you scale out.
#[derive(Clone)]
pub struct RateLimiter {
    inner: Arc<Mutex<Inner>>,
    max_keys: usize,
    sweep_above: usize,
}

#[derive(Default)]
struct Inner {
    keys: HashMap<String, Hits>,
    last_sweep: Option<Instant>,
}

/// One key's recent attempts, and the window they count in.
struct Hits {
    times: Vec<Instant>,
    window: Duration,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::with_limits(MAX_KEYS, SWEEP_ABOVE)
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    fn with_limits(max_keys: usize, sweep_above: usize) -> Self {
        RateLimiter {
            inner: Arc::default(),
            max_keys,
            sweep_above,
        }
    }

    /// Record an attempt for `key`; returns `true` if it's allowed (under `max`
    /// within `window`), `false` if the caller should be throttled.
    pub fn check(&self, key: &str, max: usize, window: Duration) -> bool {
        self.check_at(key, max, window, Instant::now())
    }

    fn check_at(&self, key: &str, max: usize, window: Duration, now: Instant) -> bool {
        let key = truncate_key(key);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        if inner.keys.len() > self.sweep_above {
            inner.sweep_expired(now);
        }
        if inner.keys.len() >= self.max_keys && !inner.keys.contains_key(key) {
            return false;
        }

        let hits = inner.keys.entry(key.to_owned()).or_insert_with(|| Hits {
            times: Vec::new(),
            window,
        });
        hits.window = window;
        hits.times.retain(|t| now.duration_since(*t) < window);
        if hits.times.len() >= max {
            return false;
        }
        hits.times.push(now);
        true
    }

    #[cfg(test)]
    fn tracked_keys(&self) -> Vec<String> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.keys.keys().cloned().collect()
    }
}

impl Inner {
    /// Drop keys with no attempt inside their own window, unless the last sweep was
    /// under [`SWEEP_INTERVAL`] ago.
    fn sweep_expired(&mut self, now: Instant) {
        if self
            .last_sweep
            .is_some_and(|t| now.duration_since(t) < SWEEP_INTERVAL)
        {
            return;
        }
        self.last_sweep = Some(now);
        self.keys.retain(|_, hits| {
            hits.times
                .last()
                .is_some_and(|t| now.duration_since(*t) < hits.window)
        });
    }
}

/// `key` cut to at most [`MAX_KEY_BYTES`], on a character boundary.
fn truncate_key(key: &str) -> &str {
    let mut end = key.len().min(MAX_KEY_BYTES);
    while !key.is_char_boundary(end) {
        end -= 1;
    }
    &key[..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: Duration = Duration::from_secs(60);
    const SECOND: Duration = Duration::from_secs(1);

    #[test]
    fn a_flood_of_distinct_keys_cannot_grow_past_the_cap() {
        let limiter = RateLimiter::with_limits(8, 2);
        let t0 = Instant::now();
        for i in 0..8 {
            assert!(limiter.check_at(&format!("live{i}"), 5, MINUTE, t0));
        }

        assert!(
            !limiter.check_at("one-too-many", 5, MINUTE, t0),
            "a new key is refused while every tracked key is live"
        );
        assert_eq!(limiter.tracked_keys().len(), 8);
        assert!(
            limiter.check_at("live0", 5, MINUTE, t0),
            "existing keys keep working"
        );
    }

    #[test]
    fn expired_keys_are_swept_at_most_every_10_seconds_each_by_its_own_window() {
        let limiter = RateLimiter::with_limits(8, 2);
        let t0 = Instant::now();
        assert!(limiter.check_at("slow", 1, MINUTE, t0));
        for i in 0..3 {
            assert!(limiter.check_at(&format!("fast{i}"), 5, SECOND, t0));
        }

        // Two seconds on, the fast keys have expired, but the last sweep (at t0) was
        // under 10 seconds ago: this call must not scan the map.
        assert!(limiter.check_at("later", 5, SECOND, t0 + 2 * SECOND));
        assert_eq!(
            limiter.tracked_keys().len(),
            5,
            "no sweep between intervals"
        );

        // Past the interval the sweep runs, judging each key by its own window: the
        // fast keys go, and the minute-long counter survives with its hit.
        assert!(limiter.check_at("much-later", 5, SECOND, t0 + 11 * SECOND));
        let mut keys = limiter.tracked_keys();
        keys.sort();
        assert_eq!(keys, ["much-later", "slow"]);
        assert!(
            !limiter.check_at("slow", 1, MINUTE, t0 + 11 * SECOND),
            "the minute-window key is still throttled"
        );
    }

    #[test]
    fn keys_are_cut_to_128_bytes_on_a_character_boundary() {
        let limiter = RateLimiter::new();
        let t0 = Instant::now();
        let long_ascii = format!("login-user:{}", "x".repeat(1000));
        let long_wide = format!("login-user:{}", "é".repeat(500));
        assert!(limiter.check_at(&long_ascii, 1, MINUTE, t0));
        assert!(limiter.check_at(&long_wide, 1, MINUTE, t0));

        for key in limiter.tracked_keys() {
            assert!(key.len() <= 128, "{} bytes kept", key.len());
        }
        // Keys sharing their first 128 bytes share a counter.
        let same_prefix = format!("login-user:{}y", "x".repeat(1000));
        assert!(!limiter.check_at(&same_prefix, 1, MINUTE, t0));
    }
}
