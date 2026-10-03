use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Most distinct keys each map tracks at once. A new key arriving at the cap evicts the
/// oldest-inserted key, so a map never refuses a request or stops limiting because it is
/// full.
const MAX_KEYS: usize = 100_000;

/// Above this many keys, expired ones are swept, at most once per [`SWEEP_INTERVAL`].
const SWEEP_ABOVE: usize = 10_000;

/// Minimum gap between sweeps, so the O(n) scan is amortised rather than per call.
const SWEEP_INTERVAL: Duration = Duration::from_secs(10);

/// Longest key kept, in bytes. Longer keys (an attacker-chosen username, say) are cut
/// on a character boundary; keys sharing their first 128 bytes share a counter.
const MAX_KEY_BYTES: usize = 128;

/// Stale entries the eviction queue may carry beyond twice the live keys before it is
/// compacted, so compaction stays amortised O(1) per insert.
const QUEUE_SLACK: usize = 1024;

/// A tiny in-memory sliding-window rate limiter keyed by an arbitrary string
/// (e.g. "login:1.2.3.4" or "msg:<user_id>"). Good enough to blunt brute-force
/// and spam on a single-node deployment; swap for Redis if you scale out.
///
/// Keys live in two independent maps, each with its own cap, sweep and eviction queue,
/// so a flood of keys in one never touches the other.
#[derive(Clone)]
pub struct RateLimiter {
    user: Arc<Mutex<Inner>>,
    unauth: Arc<Mutex<Inner>>,
    max_keys: usize,
    sweep_above: usize,
}

/// Both maps follow the same policy: at the cap, a new key evicts the oldest-inserted
/// key (a key whose window lapsed and restarted counts as inserted when it restarted),
/// and the new key is tracked and limited normally.
#[derive(Clone, Copy)]
enum KeyMap {
    /// Keys derived from an authenticated user id.
    User,
    /// Keys derived from a client address or a caller-supplied string.
    Unauth,
}

#[derive(Default)]
struct Inner {
    keys: HashMap<String, Hits>,
    /// Keys in insertion order, each with the start of the window it was queued for.
    /// An entry whose start no longer matches the key's (it was swept, evicted or
    /// restarted since) is stale and skipped.
    queue: VecDeque<(String, Instant)>,
    last_sweep: Option<Instant>,
}

/// One key's recent attempts, the window they count in, and when that window began.
struct Hits {
    times: Vec<Instant>,
    window: Duration,
    since: Instant,
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

    /// Count one attempt against `key` and against `block`, a wider key it belongs to
    /// (an address and its network), both or neither. The block is checked first: once
    /// it is spent the request is refused without creating or touching `key`. Returns
    /// false, recording nothing, when either is spent.
    pub fn check_unauth_within(
        &self,
        block: &str,
        block_max: usize,
        key: &str,
        max: usize,
        window: Duration,
    ) -> bool {
        self.check_pair_at(
            KeyMap::Unauth,
            (block, block_max),
            (key, max),
            window,
            Instant::now(),
        )
    }

    fn check_pair_at(
        &self,
        map: KeyMap,
        (block, block_max): (&str, usize),
        (key, max): (&str, usize),
        window: Duration,
        now: Instant,
    ) -> bool {
        let (block, key) = (truncate_key(block), truncate_key(key));
        let mut inner = self.map(map).lock().unwrap_or_else(|e| e.into_inner());

        if inner.keys.len() > self.sweep_above {
            inner.sweep_expired(now);
        }
        if inner.spent(block, block_max, window, now) || inner.spent(key, max, window, now) {
            return false;
        }
        inner.record(block, window, now, self.max_keys);
        inner.record(key, window, now, self.max_keys);
        true
    }

    /// How many keys the authenticated-user map holds right now.
    pub fn tracked_user_keys(&self) -> usize {
        let inner = self.user.lock().unwrap_or_else(|e| e.into_inner());
        inner.keys.len()
    }

    /// How many keys the address and caller-supplied map holds right now.
    pub fn tracked_unauth_keys(&self) -> usize {
        let inner = self.unauth.lock().unwrap_or_else(|e| e.into_inner());
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
        if inner.spent(key, max, window, now) {
            return false;
        }
        inner.record(key, window, now, self.max_keys);
        true
    }

    #[cfg(test)]
    fn tracked_keys(&self, map: KeyMap) -> Vec<String> {
        let inner = self.map(map).lock().unwrap_or_else(|e| e.into_inner());
        inner.keys.keys().cloned().collect()
    }
}

impl Inner {
    /// Whether `key` has already used its `max` attempts within `window`. Forgets
    /// attempts that have left the window; never creates the key.
    fn spent(&mut self, key: &str, max: usize, window: Duration, now: Instant) -> bool {
        match self.keys.get_mut(key) {
            Some(hits) => {
                hits.times.retain(|t| now.duration_since(*t) < window);
                hits.times.len() >= max
            }
            None => max == 0,
        }
    }

    /// Record one attempt for `key`. A new key, or one whose window lapsed (no attempts
    /// left in it), starts a window now and joins the back of the eviction queue; a new
    /// key at the cap first evicts the oldest-inserted one.
    fn record(&mut self, key: &str, window: Duration, now: Instant, max_keys: usize) {
        let restarting = match self.keys.get(key) {
            Some(hits) => hits.times.is_empty(),
            None => {
                self.evict_oldest_while_full(max_keys);
                true
            }
        };
        let hits = self.keys.entry(key.to_owned()).or_insert_with(|| Hits {
            times: Vec::new(),
            window,
            since: now,
        });
        hits.window = window;
        hits.times.push(now);
        if restarting {
            hits.since = now;
            self.queue.push_back((key.to_owned(), now));
            if self.queue.len() > 2 * self.keys.len() + QUEUE_SLACK {
                self.drop_stale_queue_entries();
            }
        }
    }

    /// Evict oldest-inserted keys until there is room for one more. O(1) amortised:
    /// each queue entry is popped once, and stale ones are skipped.
    fn evict_oldest_while_full(&mut self, max_keys: usize) {
        while self.keys.len() >= max_keys {
            let Some((key, since)) = self.queue.pop_front() else {
                return;
            };
            if self.keys.get(&key).is_some_and(|hits| hits.since == since) {
                self.keys.remove(&key);
            }
        }
    }

    /// Keep only the queue entries that still match their key's current window.
    fn drop_stale_queue_entries(&mut self) {
        let Inner { keys, queue, .. } = self;
        queue.retain(|(key, since)| keys.get(key).is_some_and(|hits| hits.since == *since));
    }

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
        self.drop_stale_queue_entries();
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

    /// No sweeps (the threshold is above the cap), so only eviction removes keys.
    fn without_sweeps(max_keys: usize) -> RateLimiter {
        RateLimiter::with_limits(max_keys, usize::MAX)
    }

    #[test]
    fn a_full_map_evicts_its_oldest_key_to_track_a_new_one() {
        for map in [KeyMap::User, KeyMap::Unauth] {
            let limiter = without_sweeps(4);
            let t0 = Instant::now();
            for i in 0..4 {
                assert!(limiter.check_at(map, &format!("live{i}"), 5, MINUTE, t0));
            }

            assert!(
                limiter.check_at(map, "newcomer", 1, MINUTE, t0),
                "a new key is accepted at the cap"
            );
            let mut keys = limiter.tracked_keys(map);
            keys.sort();
            assert_eq!(keys, ["live1", "live2", "live3", "newcomer"], "live0 went");
            assert!(
                !limiter.check_at(map, "newcomer", 1, MINUTE, t0),
                "and the new key is tracked and limited"
            );
        }
    }

    #[test]
    fn a_key_refreshed_after_its_window_is_not_evicted_ahead_of_older_live_keys() {
        let limiter = without_sweeps(4);
        let t0 = Instant::now();
        assert!(limiter.check_at(KeyMap::Unauth, "restarted", 5, SECOND, t0));
        for i in 0..3 {
            assert!(limiter.check_at(KeyMap::Unauth, &format!("live{i}"), 5, MINUTE, t0));
        }
        // Its window lapsed and a new one began: it goes to the back of the queue.
        assert!(limiter.check_at(KeyMap::Unauth, "restarted", 5, SECOND, t0 + 2 * SECOND));

        assert!(limiter.check_at(KeyMap::Unauth, "newcomer", 5, MINUTE, t0 + 2 * SECOND));
        let mut keys = limiter.tracked_keys(KeyMap::Unauth);
        keys.sort();
        assert_eq!(keys, ["live1", "live2", "newcomer", "restarted"]);
    }

    #[test]
    fn a_tracked_key_over_its_limit_is_still_refused_while_the_map_is_full() {
        let limiter = without_sweeps(4);
        let t0 = Instant::now();
        for i in 0..4 {
            assert!(limiter.check_at(KeyMap::User, &format!("msg:user{i}"), 2, MINUTE, t0));
        }
        assert!(limiter.check_at(KeyMap::User, "msg:user3", 2, MINUTE, t0));
        assert!(!limiter.check_at(KeyMap::User, "msg:user3", 2, MINUTE, t0));
    }

    #[test]
    fn a_full_unauthenticated_map_does_not_touch_user_keys() {
        let limiter = without_sweeps(8);
        let t0 = Instant::now();
        for i in 0..20 {
            assert!(limiter.check_at(KeyMap::Unauth, &format!("auth:10.0.0.{i}"), 5, MINUTE, t0));
        }

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
    fn a_spent_block_neither_creates_nor_touches_the_key_inside_it() {
        let limiter = without_sweeps(MAX_KEYS);
        let t0 = Instant::now();
        let pair = |key| limiter.check_pair_at(KeyMap::Unauth, ("block", 2), (key, 5), MINUTE, t0);
        assert!(pair("a"));
        assert!(pair("a"));

        assert!(!pair("b"), "the block is spent");
        assert!(
            !limiter
                .tracked_keys(KeyMap::Unauth)
                .contains(&"b".to_owned()),
            "and no key was created for b"
        );
        for _ in 0..3 {
            assert!(!pair("a"));
        }
        assert!(
            limiter.check_at(KeyMap::Unauth, "a", 3, MINUTE, t0),
            "refused retries didn't count against a (still 2 attempts)"
        );
    }

    #[test]
    fn a_spent_key_does_not_use_up_its_block() {
        let limiter = without_sweeps(MAX_KEYS);
        let t0 = Instant::now();
        let pair = |key| limiter.check_pair_at(KeyMap::Unauth, ("block", 3), (key, 1), MINUTE, t0);
        assert!(pair("a"));
        for _ in 0..5 {
            assert!(!pair("a"), "a is spent");
        }
        assert!(
            pair("b"),
            "a's refused retries left the block's budget alone"
        );
        assert!(pair("c"));
        assert!(!pair("d"), "three attempts spend the block");
    }

    #[test]
    fn restarting_keys_do_not_grow_the_eviction_queue_without_bound() {
        let limiter = without_sweeps(MAX_KEYS);
        let t0 = Instant::now();
        // Each check lands after the last window lapsed, so each one re-queues the key.
        for i in 0..10_000u32 {
            assert!(limiter.check_at(KeyMap::User, "msg:restarts", 1, SECOND, t0 + i * 2 * SECOND));
        }
        let queued = limiter.user.lock().unwrap().queue.len();
        assert!(
            queued <= 2 + QUEUE_SLACK,
            "{queued} queue entries for one key"
        );
    }

    #[test]
    fn inserting_at_the_cap_does_not_scan_the_map() {
        let limiter = RateLimiter::new();
        let t0 = Instant::now();
        for i in 0..MAX_KEYS {
            limiter.check_at(KeyMap::User, &format!("msg:user{i}"), 5, MINUTE, t0);
        }
        let started = Instant::now();
        for i in 0..10_000 {
            assert!(limiter.check_at(KeyMap::User, &format!("msg:new{i}"), 5, MINUTE, t0));
        }
        let took = started.elapsed();
        assert_eq!(limiter.tracked_keys(KeyMap::User).len(), MAX_KEYS);
        // A scan of 100,000 keys per insert would take minutes here.
        assert!(
            took < Duration::from_secs(2),
            "10,000 inserts took {took:?}"
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
