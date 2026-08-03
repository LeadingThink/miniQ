use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

const BUSY_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
pub(super) struct CodexTitleCatalog {
    titles: HashMap<String, String>,
}

impl CodexTitleCatalog {
    pub(super) fn load(root: &Path) -> Self {
        highest_state_database(root)
            .and_then(|database| read_titles(&database))
            .map(|titles| Self { titles })
            .unwrap_or_default()
    }

    pub(super) fn get(&self, session_id: &str) -> Option<&str> {
        self.titles.get(session_id).map(String::as_str)
    }
}

fn highest_state_database(root: &Path) -> Option<PathBuf> {
    fs::read_dir(root)
        .ok()?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let version = state_database_version(&entry.file_name())?;
            entry
                .file_type()
                .ok()?
                .is_file()
                .then_some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
}

fn state_database_version(name: &OsStr) -> Option<u64> {
    let name = name.to_str()?;
    name.strip_prefix("state_")?
        .strip_suffix(".sqlite")?
        .parse()
        .ok()
}

fn read_titles(database: &Path) -> Option<HashMap<String, String>> {
    let connection =
        Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    connection.busy_timeout(BUSY_TIMEOUT).ok()?;
    let mut statement = connection
        .prepare("SELECT id, title FROM threads WHERE title IS NOT NULL AND title != ''")
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    let titles: Result<Vec<_>, _> = rows.collect();
    Some(titles.ok()?.into_iter().collect())
}
