use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Most distinct keys each map tracks at once. What happens to a new key once a map is
/// full and nothing in it has expired depends on the map; see [`KeyMap`].
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
///
/// Keys live in two independent maps, each with its own cap and sweep, so a flood of
/// keys in one can never cause a refusal in the other.
#[derive(Clone)]
pub struct RateLimiter {
    user: Arc<Mutex<Inner>>,
    unauth: Arc<Mutex<Inner>>,
    max_keys: usize,
    sweep_above: usize,
}

#[derive(Clone, Copy)]
enum KeyMap {
    /// Keys derived from an authenticated user id. When full, a new key is let through
    /// untracked: making these keys needs an account each, and refusing them would lock
    /// real users out.
    User,
    /// Keys derived from a client address or a caller-supplied string, which anyone can
    /// mint cheaply. When full, a new key is refused.
    Unauth,
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
            user: Arc::default(),
            unauth: Arc::default(),
            max_keys,
            sweep_above,
        }
    }

    /// Record an attempt for a key derived from an authenticated user id; returns `true`
    /// if it's allowed (under `max` within `window`), `false` if the caller should be
    /// throttled.
    pub fn check(&self, key: &str, max: usize, window: Duration) -> bool {
        self.check_at(KeyMap::User, key, max, window, Instant::now())
    }

    /// Like [`RateLimiter::check`], for a key derived from a client address or a
    /// caller-supplied string (a username, say).
    pub fn check_unauth(&self, key: &str, max: usize, window: Duration) -> bool {
        self.check_at(KeyMap::Unauth, key, max, window, Instant::now())
    }

    /// How many keys the authenticated-user map holds right now.
    pub fn tracked_user_keys(&self) -> usize {
        let inner = self.user.lock().unwrap_or_else(|e| e.into_inner());
        inner.keys.len()
    }

    fn map(&self, map: KeyMap) -> &Mutex<Inner> {
        match map {
            KeyMap::User => &self.user,
            KeyMap::Unauth => &self.unauth,
        }
    }

    fn check_at(&self, map: KeyMap, key: &str, max: usize, window: Duration, now: Instant) -> bool {
        let key = truncate_key(key);
        let mut inner = self.map(map).lock().unwrap_or_else(|e| e.into_inner());

        if inner.keys.len() > self.sweep_above {
            inner.sweep_expired(now);
        }
        if inner.keys.len() >= self.max_keys && !inner.keys.contains_key(key) {
            return match map {
                KeyMap::User => true,
                KeyMap::Unauth => false,
            };
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
    fn tracked_keys(&self, map: KeyMap) -> Vec<String> {
        let inner = self.map(map).lock().unwrap_or_else(|e| e.into_inner());
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
            assert!(limiter.check_at(KeyMap::Unauth, &format!("live{i}"), 5, MINUTE, t0));
        }

        assert!(
            !limiter.check_at(KeyMap::Unauth, "one-too-many", 5, MINUTE, t0),
            "a new key is refused while every tracked key is live"
        );
        assert_eq!(limiter.tracked_keys(KeyMap::Unauth).len(), 8);
        assert!(
            limiter.check_at(KeyMap::Unauth, "live0", 5, MINUTE, t0),
            "existing keys keep working"
        );
    }

    #[test]
    fn a_full_unauthenticated_map_does_not_touch_user_keys() {
        let limiter = RateLimiter::with_limits(8, 2);
        let t0 = Instant::now();
        for i in 0..8 {
            assert!(limiter.check_at(KeyMap::Unauth, &format!("auth:10.0.0.{i}"), 5, MINUTE, t0));
        }
        assert!(!limiter.check_at(KeyMap::Unauth, "auth:10.0.1.1", 5, MINUTE, t0));

        // A user key not yet tracked is accepted, then limited normally.
        for _ in 0..2 {
            assert!(limiter.check_at(KeyMap::User, "msg:alice", 2, MINUTE, t0));
        }
        assert!(
            !limiter.check_at(KeyMap::User, "msg:alice", 2, MINUTE, t0),
            "the user's own limit still applies"
        );
        assert_eq!(limiter.tracked_keys(KeyMap::User), ["msg:alice"]);
    }

    #[test]
    fn a_full_user_map_lets_new_user_keys_through_untracked() {
        let limiter = RateLimiter::with_limits(8, 2);
        let t0 = Instant::now();
        for i in 0..8 {
            assert!(limiter.check_at(KeyMap::User, &format!("msg:user{i}"), 5, MINUTE, t0));
        }

        for _ in 0..3 {
            assert!(
                limiter.check_at(KeyMap::User, "msg:newcomer", 1, MINUTE, t0),
                "a new user key is allowed, untracked, while the map is full"
            );
        }
        assert_eq!(limiter.tracked_keys(KeyMap::User).len(), 8);
        assert!(
            limiter.check_at(KeyMap::Unauth, "auth:10.0.0.1", 5, MINUTE, t0),
            "and the unauthenticated map is unaffected"
        );
    }

    #[test]
    fn expired_keys_are_swept_at_most_every_10_seconds_each_by_its_own_window() {
        let limiter = RateLimiter::with_limits(8, 2);
        let t0 = Instant::now();
        assert!(limiter.check_at(KeyMap::Unauth, "slow", 1, MINUTE, t0));
        for i in 0..3 {
            assert!(limiter.check_at(KeyMap::Unauth, &format!("fast{i}"), 5, SECOND, t0));
        }

        // Two seconds on, the fast keys have expired, but the last sweep (at t0) was
        // under 10 seconds ago: this call must not scan the map.
        assert!(limiter.check_at(KeyMap::Unauth, "later", 5, SECOND, t0 + 2 * SECOND));
        assert_eq!(
            limiter.tracked_keys(KeyMap::Unauth).len(),
            5,
            "no sweep between intervals"
        );

        // Past the interval the sweep runs, judging each key by its own window: the
        // fast keys go, and the minute-long counter survives with its hit.
        assert!(limiter.check_at(KeyMap::Unauth, "much-later", 5, SECOND, t0 + 11 * SECOND));
        let mut keys = limiter.tracked_keys(KeyMap::Unauth);
        keys.sort();
        assert_eq!(keys, ["much-later", "slow"]);
        assert!(
            !limiter.check_at(KeyMap::Unauth, "slow", 1, MINUTE, t0 + 11 * SECOND),
            "the minute-window key is still throttled"
        );
    }

    #[test]
    fn keys_are_cut_to_128_bytes_on_a_character_boundary() {
        let limiter = RateLimiter::new();
        let t0 = Instant::now();
        let long_ascii = format!("login-user:{}", "x".repeat(1000));
        let long_wide = format!("login-user:{}", "é".repeat(500));
        assert!(limiter.check_at(KeyMap::Unauth, &long_ascii, 1, MINUTE, t0));
        assert!(limiter.check_at(KeyMap::Unauth, &long_wide, 1, MINUTE, t0));

        for key in limiter.tracked_keys(KeyMap::Unauth) {
            assert!(key.len() <= 128, "{} bytes kept", key.len());
        }
        // Keys sharing their first 128 bytes share a counter.
        let same_prefix = format!("login-user:{}y", "x".repeat(1000));
        assert!(!limiter.check_at(KeyMap::Unauth, &same_prefix, 1, MINUTE, t0));
    }
}
