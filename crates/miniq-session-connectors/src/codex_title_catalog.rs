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
    let has_name_column = connection
        .prepare("PRAGMA table_info(threads)")
        .ok()?
        .query_map([], |row| row.get::<_, String>(1))
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?
        .iter()
        .any(|column| column == "name");
    // Codex uses `name` for the sidebar label and keeps the original prompt in `title`.
    // Older databases do not have `name`, so keep the title-only query for them.
    let query = if has_name_column {
        "SELECT id, COALESCE(NULLIF(name, ''), title) FROM threads
         WHERE COALESCE(NULLIF(name, ''), title) IS NOT NULL
           AND COALESCE(NULLIF(name, ''), title) != ''"
    } else {
        "SELECT id, title FROM threads WHERE title IS NOT NULL AND title != ''"
    };
    let mut statement = connection.prepare(query).ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok()?;
    let titles: Result<Vec<_>, _> = rows.collect();
    Some(titles.ok()?.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use rusqlite::{params, Connection};

    use super::CodexTitleCatalog;

    #[test]
    fn prefers_sidebar_name_and_falls_back_to_original_title() {
        let temp = tempfile::tempdir().unwrap();
        let database = temp.path().join("state_1.sqlite");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT)")
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (id, title, name) VALUES (?1, ?2, ?3)",
                params!["named", "long original prompt", "简洁的侧栏名称"],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads (id, title, name) VALUES (?1, ?2, ?3)",
                params!["unnamed", "fallback title", ""],
            )
            .unwrap();
        drop(connection);

        let catalog = CodexTitleCatalog::load(temp.path());
        assert_eq!(catalog.get("named"), Some("简洁的侧栏名称"));
        assert_eq!(catalog.get("unnamed"), Some("fallback title"));
    }
}
