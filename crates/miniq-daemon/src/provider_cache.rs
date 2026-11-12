//! Bounded provider reuse across turns without changing an active task's route.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use miniq_models::{ConfiguredProvider, ModelProvider, ProviderConfig};

const MAX_PROVIDERS: usize = 16;
const MAX_PROVIDER_AGE: Duration = Duration::from_secs(300);

struct Entry {
    config: ProviderConfig,
    provider: Arc<ConfiguredProvider>,
    created_at: Instant,
}

pub(crate) struct ProviderCache {
    entries: Mutex<VecDeque<Entry>>,
    capacity: usize,
    max_age: Duration,
}

impl Default for ProviderCache {
    fn default() -> Self {
        Self::new(MAX_PROVIDERS, MAX_PROVIDER_AGE)
    }
}

impl ProviderCache {
    fn new(capacity: usize, max_age: Duration) -> Self {
        assert!(capacity > 0);
        Self {
            entries: Mutex::new(VecDeque::new()),
            capacity,
            max_age,
        }
    }

    pub(crate) fn get(&self, config: ProviderConfig) -> Arc<dyn ModelProvider> {
        self.get_at(config, Instant::now())
    }

    fn get_at(&self, config: ProviderConfig, now: Instant) -> Arc<dyn ModelProvider> {
        let mut entries = self.entries.lock().expect("provider cache mutex poisoned");
        entries.retain(|entry| {
            now.saturating_duration_since(entry.created_at) < self.max_age
                && entry.provider.is_cache_fresh()
        });
        if let Some(index) = entries.iter().position(|entry| entry.config == config) {
            let entry = entries.remove(index).expect("matched provider entry");
            let provider = entry.provider.clone();
            entries.push_back(entry);
            return provider;
        }
        // Construct under the lock so concurrent turns share one HTTP pool and
        // one metadata OnceCell. No network requests run while holding it.
        let provider = Arc::new(ConfiguredProvider::new(config.clone()));
        if entries.len() == self.capacity {
            entries.pop_front();
        }
        entries.push_back(Entry {
            config,
            provider: provider.clone(),
            created_at: now,
        });
        provider
    }
}

#[cfg(test)]
mod tests;
