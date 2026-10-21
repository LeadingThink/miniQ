//! Quiet, asynchronous update checks for long lived interactive terminals.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use semver::Version;
use serde_json::{json, Value};
use tokio::sync::mpsc;

const STARTUP_DELAY: Duration = Duration::from_secs(2);
const PERIODIC_CHECK: Duration = Duration::from_secs(10 * 60);
const RECHECK_SECONDS: u64 = 60;
const FAILURE_SECONDS: u64 = 5 * 60;
const REMINDER_SECONDS: u64 = 24 * 60 * 60;

pub struct UpdateNotice {
    receiver: mpsc::Receiver<String>,
    task: tokio::task::JoinHandle<()>,
}

impl UpdateNotice {
    pub fn new(directory: &Path) -> Self {
        let (sender, receiver) = mpsc::channel(1);
        let cache = directory.join("terminal-update.json");
        let task = tokio::spawn(run(cache, sender));
        Self { receiver, task }
    }

    /// Called at an existing UI tick; never does disk, network or terminal I/O.
    pub fn tick(&mut self) -> Option<String> {
        self.receiver.try_recv().ok()
    }
}

impl Drop for UpdateNotice {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
struct Cache {
    checked: u64,
    failed: u64,
    reminded: u64,
    reminder_version: Option<Version>,
    latest: Option<Version>,
}

impl Cache {
    fn from_json(value: Value) -> Self {
        let version = |key: &str| {
            value[key]
                .as_str()
                .and_then(|text| Version::parse(text).ok())
        };
        Self {
            checked: value["checkedAt"].as_u64().unwrap_or(0),
            failed: value["failedAt"].as_u64().unwrap_or(0),
            reminded: value["remindedAt"].as_u64().unwrap_or(0),
            reminder_version: version("reminderVersion"),
            latest: version("latestVersion"),
        }
    }

    fn json(&self) -> Value {
        json!({"checkedAt":self.checked,"failedAt":self.failed,"remindedAt":self.reminded,
            "reminderVersion":self.reminder_version.as_ref().map(ToString::to_string),
            "latestVersion":self.latest.as_ref().map(ToString::to_string)})
    }

    fn can_check(&self, now: u64) -> bool {
        !recent(self.checked, now, RECHECK_SECONDS) && !recent(self.failed, now, FAILURE_SECONDS)
    }

    fn can_remind(&self, latest: &Version, current: &Version, now: u64) -> bool {
        latest > current
            && (self.reminder_version.as_ref() != Some(latest)
                || !recent(self.reminded, now, REMINDER_SECONDS))
    }
}

fn recent(stamp: u64, now: u64, interval: u64) -> bool {
    stamp > 0
        && now
            .checked_sub(stamp)
            .is_some_and(|elapsed| elapsed < interval)
}

async fn run(path: PathBuf, sender: mpsc::Sender<String>) {
    tokio::time::sleep(STARTUP_DELAY).await;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).expect("valid package version");
    let mut cache = Cache::from_json(read_cache(&path).await);
    loop {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if cache.can_check(now) {
            match crate::updater::latest_version(Duration::from_secs(8)).await {
                Ok(version) => {
                    cache.latest = Some(version);
                    cache.checked = now;
                    cache.failed = 0;
                }
                Err(_) => cache.failed = now,
            }
        }
        if let Some(latest) = &cache.latest {
            if cache.can_remind(latest, &current, now) {
                let message = format!("miniQ {latest} is available (CLI {current}). Run `miniq update` to install, or `miniq update --activate` to activate when idle; active tasks are kept unless you explicitly choose to stop them.");
                if sender.try_send(message).is_ok() {
                    cache.reminded = now;
                    cache.reminder_version = Some(latest.clone());
                }
            }
        }
        // Cache failure must not affect chatting or remove the in-memory cooldown.
        let bytes = serde_json::to_vec_pretty(&cache.json()).unwrap_or_default();
        let cache_path = path.clone();
        let _ = tokio::task::spawn_blocking(move || {
            miniq_local::write_private_bytes(&cache_path, &bytes)
        })
        .await;
        let delay = if cache.failed != 0 {
            Duration::from_secs(FAILURE_SECONDS)
        } else {
            PERIODIC_CHECK
        };
        tokio::time::sleep(delay).await;
    }
}

async fn read_cache(path: &Path) -> Value {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn caches_checks_and_failures_and_recovers_from_clock_changes() {
        let mut cache = Cache::default();
        assert!(cache.can_check(1000));
        cache.checked = 1000;
        assert!(!cache.can_check(1059));
        assert!(cache.can_check(1060));
        cache.failed = 1060;
        assert!(!cache.can_check(1359));
        assert!(cache.can_check(1360));
        assert!(cache.can_check(1));
    }

    #[test]
    fn new_versions_bypass_same_version_reminder_cooldown() {
        let current = Version::new(1, 0, 0);
        let latest = Version::new(1, 0, 1);
        let mut cache = Cache::default();
        assert!(!cache.can_remind(&current, &current, 1000));
        assert!(cache.can_remind(&latest, &current, 1000));
        cache.reminded = 1000;
        cache.reminder_version = Some(latest.clone());
        assert!(!cache.can_remind(&latest, &current, 2000));
        assert!(cache.can_remind(&Version::new(1, 0, 2), &current, 2000));
        assert!(cache.can_remind(&latest, &current, 1000 + REMINDER_SECONDS));
        let restored = Cache::from_json(cache.json());
        assert!(!restored.can_remind(&latest, &current, 2000));
    }
}
