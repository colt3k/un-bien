//! Rate limit for the "dest (peer, room) not found, dropping" warning.
//!
//! A pi streams every frame to each app it has attached, and an app that has
//! gone away is not at its (peer, room) any more, so one departed app turned
//! into a warning per streamed frame (several a second, for hours). A sender
//! connection keeps one `DropLog`: the first drop for a destination is
//! reported, then at most one line per interval carrying the count dropped
//! since the last line.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// How often a repeating drop for one destination is reported.
pub const DROP_LOG_INTERVAL: Duration = Duration::from_secs(60);

/// Destinations tracked per connection before the table is reset.
const MAX_TRACKED: usize = 256;

#[derive(Default)]
pub struct DropLog {
    seen: HashMap<(String, String), (Instant, u64)>,
}

impl DropLog {
    /// Record one dropped frame for `(dest, room)` at `now`. Returns
    /// `Some(n)` when it should be logged, `n` being how many drops for that
    /// destination were not logged since the previous line; `None` to stay
    /// quiet.
    pub fn note(&mut self, dest: &str, room: &str, now: Instant) -> Option<u64> {
        let key = (dest.to_string(), room.to_string());
        if let Some((last, suppressed)) = self.seen.get_mut(&key) {
            if now.duration_since(*last) < DROP_LOG_INTERVAL {
                *suppressed += 1;
                return None;
            }
            let n = *suppressed;
            *last = now;
            *suppressed = 0;
            return Some(n);
        }
        if self.seen.len() >= MAX_TRACKED {
            self.seen.clear();
        }
        self.seen.insert(key, (now, 0));
        Some(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_drop_logs_then_one_line_per_interval_with_the_count() {
        let mut log = DropLog::default();
        let t0 = Instant::now();
        assert_eq!(log.note("app", "main", t0), Some(0));
        for i in 1..=5 {
            assert_eq!(log.note("app", "main", t0 + Duration::from_secs(i)), None);
        }
        assert_eq!(log.note("app", "main", t0 + DROP_LOG_INTERVAL), Some(5));
        assert_eq!(
            log.note(
                "app",
                "main",
                t0 + DROP_LOG_INTERVAL + Duration::from_secs(1)
            ),
            None
        );
    }

    #[test]
    fn destinations_are_counted_separately() {
        let mut log = DropLog::default();
        let t0 = Instant::now();
        assert_eq!(log.note("app-a", "main", t0), Some(0));
        assert_eq!(log.note("app-b", "main", t0), Some(0));
        assert_eq!(log.note("app-a", "other", t0), Some(0));
        assert_eq!(log.note("app-a", "main", t0), None);
    }
}
