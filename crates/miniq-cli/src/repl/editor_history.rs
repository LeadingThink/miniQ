//! Private, bounded prompt-history persistence and search.
use super::*;
use std::{fs, io::Write};

pub(super) fn find(history: &[String], query: &str, before: usize) -> Option<usize> {
    if query.is_empty() {
        return None;
    }
    history[..before.min(history.len())]
        .iter()
        .rposition(|entry| entry.contains(query))
}

/// Commands whose arguments may contain secrets are never stored in history.
pub fn sensitive(entry: &str) -> bool {
    let first = entry.split_whitespace().next().unwrap_or_default();
    matches!(first, "/login" | "/logout" | "/key" | "/apikey" | "/token")
        || entry.to_ascii_lowercase().contains("api_key=")
}

pub fn load_history(path: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut entries: Vec<String> = text
        .lines()
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<String>(line).ok())
        .collect();
    if entries.len() > HISTORY_LIMIT {
        entries.drain(..entries.len() - HISTORY_LIMIT);
    }
    entries
}

pub fn save_history(path: &Path, entries: &[String]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = path.with_extension("tmp");
    {
        let mut file = open_private(&temp)?;
        for entry in entries.iter().rev().take(HISTORY_LIMIT).rev() {
            let line = serde_json::to_string(entry).unwrap_or_default();
            writeln!(file, "{line}")?;
        }
    }
    fs::rename(temp, path)
}

#[cfg(unix)]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(unix))]
fn open_private(path: &Path) -> std::io::Result<fs::File> {
    fs::File::create(path)
}
