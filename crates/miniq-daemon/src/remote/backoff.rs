//! Reconnect pacing for the relay connection.
//!
//! The relay keeps a dropped desktop "online" for a 15s grace period, so every
//! retry delay must stay well below it; jitter spreads reconnect storms after a
//! relay restart.

use std::time::Duration;

const INITIAL_RETRY: Duration = Duration::from_secs(1);
pub(super) const MAX_RETRY: Duration = Duration::from_secs(10);
const JITTER_RATIO: f64 = 0.2;

/// Delay before reconnect attempt number `attempt` (0 = first retry after a
/// working connection). `jitter` is a uniform sample in `[-1, 1]` that scales
/// the exponential base by ±20%; the result never exceeds [`MAX_RETRY`].
pub(super) fn next_retry_delay(attempt: u32, jitter: f64) -> Duration {
    let base = INITIAL_RETRY
        .saturating_mul(1_u32.checked_shl(attempt).unwrap_or(u32::MAX))
        .min(MAX_RETRY);
    let scale = 1.0 + JITTER_RATIO * jitter.clamp(-1.0, 1.0);
    Duration::from_millis((base.as_millis() as f64 * scale).round() as u64).min(MAX_RETRY)
}

pub(super) fn random_jitter() -> f64 {
    use rand::Rng;
    rand::rng().random_range(-1.0..=1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_delay_doubles_from_one_second_and_caps_at_ten() {
        let delays: Vec<_> = (0..6)
            .map(|attempt| next_retry_delay(attempt, 0.0))
            .collect();
        assert_eq!(
            delays,
            [1, 2, 4, 8, 10, 10].map(Duration::from_secs).to_vec()
        );
        assert_eq!(next_retry_delay(u32::MAX, 0.0), MAX_RETRY);
    }

    #[test]
    fn retry_jitter_stays_within_twenty_percent_and_below_relay_grace() {
        assert_eq!(next_retry_delay(0, -1.0), Duration::from_millis(800));
        assert_eq!(next_retry_delay(0, 1.0), Duration::from_millis(1200));
        assert_eq!(next_retry_delay(2, 1.0), Duration::from_millis(4800));
        assert_eq!(next_retry_delay(10, -1.0), Duration::from_secs(8));
        for _ in 0..1000 {
            let delay = next_retry_delay(30, random_jitter());
            assert!(delay >= Duration::from_secs(8) && delay <= MAX_RETRY);
            assert!(delay < Duration::from_secs(15));
        }
    }
}
