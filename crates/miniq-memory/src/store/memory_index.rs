//! A derived index with CJK bigrams for short names and mixed-language search.
use super::{
    memories::{row, COLUMNS},
    MemoryRow, Result,
};
use rusqlite::{params, Connection};
use std::collections::{BTreeSet, HashMap};

fn cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x3134f | 0x3040..=0x30ff | 0xac00..=0xd7af)
}
pub(super) fn terms(text: &str, query: bool) -> Vec<String> {
    let mut result = BTreeSet::new();
    let mut word = String::new();
    let mut run = Vec::new();
    let flush = |word: &mut String, run: &mut Vec<char>, result: &mut BTreeSet<String>| {
        if !word.is_empty() {
            result.insert(std::mem::take(word));
        }
        if !query || run.len() == 1 {
            for c in run.iter() {
                result.insert(format!("u{:x}", *c as u32));
            }
        }
        for pair in run.windows(2) {
            result.insert(format!("b{:x}x{:x}", pair[0] as u32, pair[1] as u32));
        }
        run.clear();
    };
    for c in text.chars().flat_map(char::to_lowercase) {
        if cjk(c) {
            if !word.is_empty() {
                result.insert(std::mem::take(&mut word));
            }
            run.push(c);
        } else if c.is_alphanumeric() {
            if !run.is_empty() {
                flush(&mut word, &mut run, &mut result);
            }
            word.push(c);
        } else {
            flush(&mut word, &mut run, &mut result);
        }
    }
    flush(&mut word, &mut run, &mut result);
    result.into_iter().collect()
}
pub(super) fn index(conn: &Connection, id: &str, content: &str) -> Result<()> {
    conn.execute("DELETE FROM memory_fts WHERE memory_id=?1", [id])?;
    insert(conn, id, content)
}
fn insert(conn: &Connection, id: &str, content: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO memory_fts(memory_id,terms) VALUES (?1,?2)",
        params![id, terms(content, false).join(" ")],
    )?;
    Ok(())
}
pub(super) fn rebuild(conn: &Connection) -> Result<()> {
    conn.execute("DELETE FROM memory_fts", [])?;
    let mut stmt = conn.prepare("SELECT id, content FROM memories")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        insert(conn, &row.get::<_, String>(0)?, &row.get::<_, String>(1)?)?;
    }
    Ok(())
}
const SCOPE: &str = "((m.scope='global' AND m.workspace_id IS NULL) OR (m.scope='workspace' AND m.workspace_id=?1))";
pub(super) fn search(
    conn: &Connection,
    workspace: Option<&str>,
    query: &str,
    limit: usize,
) -> Result<Vec<MemoryRow>> {
    let tokens = terms(query, true);
    if tokens.is_empty() {
        let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM memories m WHERE {SCOPE} AND instr(lower(m.content),lower(?2))>0 ORDER BY m.updated_at DESC,m.id DESC LIMIT ?3"))?;
        return Ok(stmt
            .query_map(params![workspace, query, limit as i64], row)?
            .collect::<std::result::Result<_, _>>()?);
    }
    let mut matches: HashMap<String, (f64, MemoryRow)> = HashMap::new();
    // Process all terms in batches to stay below SQLite's expression depth.
    for batch in tokens.chunks(64) {
        let expression = batch
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(" OR ");
        let mut stmt = conn.prepare(&format!("SELECT {COLUMNS}, bm25(memory_fts) FROM memory_fts JOIN memories m ON m.id=memory_fts.memory_id WHERE {SCOPE} AND memory_fts MATCH ?2 ORDER BY bm25(memory_fts),m.id LIMIT ?3"))?;
        for value in stmt.query_map(params![workspace, expression, limit as i64], |r| {
            Ok((r.get::<_, f64>(10)?, row(r)?))
        })? {
            let (score, item) = value?;
            matches
                .entry(item.id.clone())
                .and_modify(|e| e.0 += score)
                .or_insert((score, item));
        }
    }
    let mut matches = matches.into_values().collect::<Vec<_>>();
    matches.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.id.cmp(&b.1.id)));
    // Result page, not truncation of stored content. memory.list exposes every fact.
    Ok(matches.into_iter().take(limit).map(|(_, m)| m).collect())
}
