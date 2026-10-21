//! Visible-view history: pages by what a conversation shows outside folded work.
//!
//! A turn is the non-steered user message that opened it plus every row up to the
//! next such message. Its visible rows are the opening message, final or
//! interrupted replies and, for legacy rows without a phase, a trailing reply.
//! Everything else (tool calls, commentary, steering, tool transcripts) is the
//! turn's folded process: counted here, fetched page by page on demand.

use std::collections::BTreeMap;

use miniq_protocol::{
    HistoryCursor, HistoryFilter, HistoryPage, HistoryParams, ProcessRecordsParams, ProcessSummary,
};
use rusqlite::{params, types::Value, Connection, OptionalExtension, Row, ToSql};

use super::history::{load_messages, load_tools};
use super::{MemoryError, Result};

/// Tools that checkpoint files before writing; mirrors the desktop change card.
const FILE_WRITE_TOOLS: &str =
    "'file_write', 'file_edit', 'doc_write', 'file_patch', 'notebook_edit', 'apply_patch'";
/// Messages a turn shows outside its fold. `:legacy` is the trailing reply of a
/// turn recorded before replies carried a phase.
const VISIBLE_MESSAGE: &str = "((role = 'user' AND steered = 0) \
     OR (role = 'assistant' AND coalesce(assistant_kind, '') IN ('final', 'interrupted')) \
     OR id IS :legacy)";

/// Rows of one turn in `(created_at, id)` order: `start` inclusive, `end` exclusive.
#[derive(Default, Clone)]
struct TurnRange {
    start: Option<HistoryCursor>,
    end: Option<HistoryCursor>,
}

type Params = Vec<(&'static str, Value)>;

fn text(value: &str) -> Value {
    Value::Text(value.to_string())
}

/// Range conditions on an unqualified `(created_at, id)`, with their bindings.
fn bounds(range: &TurnRange, before: Option<&HistoryCursor>) -> (String, Params) {
    let mut sql = String::new();
    let mut params = Params::new();
    if let Some(start) = &range.start {
        sql += " AND (created_at, id) >= (:start_at, :start_id)";
        params.push((":start_at", text(&start.at)));
        params.push((":start_id", text(&start.id)));
    }
    if let Some(end) = &range.end {
        sql += " AND (created_at, id) < (:end_at, :end_id)";
        params.push((":end_at", text(&end.at)));
        params.push((":end_id", text(&end.id)));
    }
    if let Some(before) = before {
        sql += " AND (created_at, id) < (:before_at, :before_id)";
        params.push((":before_at", text(&before.at)));
        params.push((":before_id", text(&before.id)));
    }
    (sql, params)
}

/// Run a statement, binding only the named parameters its text mentions.
fn query<T>(
    conn: &Connection,
    sql: &str,
    params: &[(&'static str, Value)],
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut statement = conn.prepare_cached(sql)?;
    let bound = params
        .iter()
        .filter(|(name, _)| sql.contains(name))
        .map(|(name, value)| (*name, value as &dyn ToSql))
        .collect::<Vec<_>>();
    let rows = statement.query_map(bound.as_slice(), map)?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

fn cursor(row: &Row<'_>) -> rusqlite::Result<HistoryCursor> {
    Ok(HistoryCursor {
        at: row.get(0)?,
        id: row.get(1)?,
    })
}

fn session_params(session_id: &str, include_internal: bool) -> Params {
    vec![
        (":sid", text(session_id)),
        (":internal", Value::Integer(include_internal.into())),
    ]
}

fn opener_after(
    conn: &Connection,
    session_id: &str,
    after: Option<&HistoryCursor>,
) -> Result<Option<HistoryCursor>> {
    let mut params = session_params(session_id, false);
    let mut filter = String::new();
    if let Some(after) = after {
        filter = " AND (created_at, id) > (:after_at, :after_id)".into();
        params.push((":after_at", text(&after.at)));
        params.push((":after_id", text(&after.id)));
    }
    let sql = format!(
        "SELECT created_at, id FROM messages WHERE session_id = :sid AND inherited = 0 \
         AND role = 'user' AND steered = 0{filter} ORDER BY created_at, id LIMIT 1"
    );
    Ok(query(conn, &sql, &params, cursor)?.pop())
}

/// Opening user messages strictly older than `before`, newest first.
fn openers_before(
    conn: &Connection,
    session_id: &str,
    before: Option<&HistoryCursor>,
    limit: usize,
) -> Result<Vec<HistoryCursor>> {
    let (filter, mut params) = bounds(&TurnRange::default(), before);
    params.extend(session_params(session_id, false));
    params.push((":limit", Value::Integer(limit as i64)));
    let sql = format!(
        "SELECT created_at, id FROM messages WHERE session_id = :sid AND inherited = 0 \
         AND role = 'user' AND steered = 0{filter} ORDER BY created_at DESC, id DESC LIMIT :limit"
    );
    query(conn, &sql, &params, cursor)
}

/// The trailing reply of a turn whose replies carry no phase: the turn's last
/// row, when that row is such an assistant message.
fn legacy_final(
    conn: &Connection,
    range: &TurnRange,
    mut params: Params,
) -> Result<Option<String>> {
    let (filter, bound) = bounds(range, None);
    params.extend(bound);
    let message = query(
        conn,
        &format!(
            "SELECT id, created_at, role, assistant_kind FROM messages WHERE session_id = :sid \
             AND inherited = 0{filter} \
             AND (:internal OR role != 'system') ORDER BY created_at DESC, id DESC LIMIT 1"
        ),
        &params,
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        },
    )?
    .pop();
    let Some((id, at, role, kind)) = message else {
        return Ok(None);
    };
    if role != "assistant" || kind.is_some() {
        return Ok(None);
    }
    let tool = query(
        conn,
        &format!(
            "SELECT created_at, id FROM tool_calls WHERE session_id = :sid{filter} \
             AND (:internal OR tool_name != 'task_update') ORDER BY created_at DESC, id DESC LIMIT 1"
        ),
        &params,
        cursor,
    )?
    .pop();
    let later_tool =
        tool.is_some_and(|tool| (tool.at.as_str(), tool.id.as_str()) > (at.as_str(), id.as_str()));
    Ok((!later_tool).then_some(id))
}

/// Counts per status for one turn. Reads only `idx_tool_calls_session_timeline`:
/// `status` sits beside the payloads in the table.
fn tool_summary_sql(range_filter: &str) -> String {
    format!(
        "SELECT status, count(*), coalesce(sum(tool_name IN ({FILE_WRITE_TOOLS})), 0), \
         min(created_at), max(created_at) FROM tool_calls \
         WHERE session_id = :sid{range_filter} AND (:internal OR tool_name != 'task_update') \
         GROUP BY status"
    )
}

struct Turn {
    visible_ids: Vec<String>,
    summary: ProcessSummary,
}

fn turn_content(
    conn: &Connection,
    session_id: &str,
    turn_id: Option<&str>,
    range: &TurnRange,
    include_internal: bool,
) -> Result<Turn> {
    let mut params = session_params(session_id, include_internal);
    let legacy = legacy_final(conn, range, params.clone())?;
    params.push((
        ":legacy",
        legacy.as_deref().map_or(Value::Null, |id| text(id)),
    ));
    let (filter, bound) = bounds(range, None);
    params.extend(bound);
    let visible_ids = query(
        conn,
        &format!(
            "SELECT id FROM messages WHERE session_id = :sid AND inherited = 0{filter} AND {VISIBLE_MESSAGE} \
             ORDER BY created_at, id"
        ),
        &params,
        |row| row.get::<_, String>(0),
    )?;
    let (message_count, message_first, message_last) = query(
        conn,
        &format!(
            "SELECT count(*), min(created_at), max(created_at) FROM messages \
             WHERE session_id = :sid AND inherited = 0{filter} AND (:internal OR role != 'system') \
             AND NOT {VISIBLE_MESSAGE}"
        ),
        &params,
        |row| {
            Ok((
                row.get::<_, u32>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    )?
    .pop()
    .unwrap_or_default();
    let tools = query(conn, &tool_summary_sql(&filter), &params, |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, u32>(1)?,
            row.get::<_, u32>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut status_counts = BTreeMap::new();
    let (mut tool_call_count, mut file_write_count) = (0, 0);
    let mut times = message_first
        .into_iter()
        .chain(message_last)
        .collect::<Vec<_>>();
    for (status, count, writes, first, last) in tools {
        status_counts.insert(status, count);
        tool_call_count += count;
        file_write_count += writes;
        times.extend([first, last]);
    }
    Ok(Turn {
        visible_ids,
        summary: ProcessSummary {
            turn_id: turn_id.map(str::to_string),
            record_count: message_count + tool_call_count,
            tool_call_count,
            message_count,
            status_counts,
            file_write_count,
            first_at: times.iter().min().cloned(),
            last_at: times.iter().max().cloned(),
        },
    })
}

fn has_rows(conn: &Connection, session_id: &str, range: &TurnRange) -> Result<bool> {
    let (filter, bound) = bounds(range, None);
    let mut params = session_params(session_id, false);
    params.extend(bound);
    for table in [
        "messages WHERE session_id = :sid",
        "tool_calls WHERE session_id = :sid",
    ] {
        let sql = format!("SELECT 1 FROM {table}{filter} LIMIT 1");
        if !query(conn, &sql, &params, |row| row.get::<_, i64>(0))?.is_empty() {
            return Ok(true);
        }
    }
    Ok(false)
}

fn validate(input: &HistoryParams) -> Result<()> {
    if !matches!(input.filter, HistoryFilter::All)
        || !input.query.trim().is_empty()
        || input.agent_id.is_some()
        || input.tool_name.is_some()
        || input.include_payloads
    {
        return Err(MemoryError::InvalidData(
            "visible history takes no filter, query, agent, tool or payload options".into(),
        ));
    }
    Ok(())
}

/// Page by visible messages. Whole turns are returned, newest turns first, until
/// `limit` visible messages are reached; the last turn is never cut, so a page
/// can exceed `limit` by that turn's remaining visible messages.
pub(super) fn visible_page(conn: &Connection, input: &HistoryParams) -> Result<HistoryPage> {
    validate(input)?;
    let session_id = input.session_id.as_str();
    let limit = input.limit as usize;
    let openers = openers_before(conn, session_id, input.before.as_ref(), limit + 1)?;
    let mut turns = Vec::new();
    let mut visible = 0;
    let mut used = 0;
    while used < openers.len() && visible < limit {
        let end = if used == 0 {
            opener_after(conn, session_id, Some(&openers[0]))?
        } else {
            Some(openers[used - 1].clone())
        };
        let range = TurnRange {
            start: Some(openers[used].clone()),
            end,
        };
        let turn = turn_content(
            conn,
            session_id,
            Some(&openers[used].id),
            &range,
            input.include_internal,
        )?;
        visible += turn.visible_ids.len();
        turns.push(turn);
        used += 1;
    }
    // The oldest opener on the page is where the next page continues.
    let oldest = used.checked_sub(1).map(|index| openers[index].clone());
    let mut next_cursor = None;
    if used < openers.len() {
        next_cursor = oldest;
    } else {
        // Every older opener is on this page; rows before the first one remain.
        let head = TurnRange {
            start: None,
            end: opener_after(conn, session_id, None)?,
        };
        if has_rows(conn, session_id, &head)? {
            if visible < limit {
                turns.push(turn_content(
                    conn,
                    session_id,
                    None,
                    &head,
                    input.include_internal,
                )?);
            } else {
                next_cursor = oldest;
            }
        }
    }
    turns.reverse();
    let ids = turns
        .iter()
        .flat_map(|turn| turn.visible_ids.iter().cloned())
        .collect::<Vec<_>>();
    let mut loaded = load_messages(conn, session_id, &ids)?;
    let mut messages = ids
        .iter()
        .filter_map(|id| loaded.remove(id))
        .collect::<Vec<_>>();
    super::turn_timing::attach(conn, &mut messages)?;
    Ok(HistoryPage {
        messages,
        tool_calls: Vec::new(),
        next_cursor,
        process_summaries: turns
            .into_iter()
            .map(|turn| turn.summary)
            .filter(|summary| summary.record_count > 0)
            .collect(),
    })
}

/// One page of a turn's folded records, newest first by `before`. Payloads stay deferred.
pub(super) fn process_records_page(
    conn: &Connection,
    input: &ProcessRecordsParams,
) -> Result<HistoryPage> {
    let session_id = input.session_id.as_str();
    let range = match &input.turn_id {
        Some(turn_id) => {
            let opener = conn
                .query_row(
                    "SELECT created_at, id FROM messages WHERE id = ?1 AND session_id = ?2 \
                     AND role = 'user' AND steered = 0",
                    params![turn_id, session_id],
                    cursor,
                )
                .optional()?
                .ok_or_else(|| {
                    MemoryError::InvalidData("turn does not belong to this session".into())
                })?;
            TurnRange {
                end: opener_after(conn, session_id, Some(&opener))?,
                start: Some(opener),
            }
        }
        None => TurnRange {
            start: None,
            end: opener_after(conn, session_id, None)?,
        },
    };
    let mut params = session_params(session_id, input.include_internal);
    let legacy = legacy_final(conn, &range, params.clone())?;
    params.push((
        ":legacy",
        legacy.as_deref().map_or(Value::Null, |id| text(id)),
    ));
    let (filter, bound) = bounds(&range, input.before.as_ref());
    params.extend(bound);
    params.push((":limit", Value::Integer(i64::from(input.limit) + 1)));
    let mut positions = query(
        conn,
        &format!(
            "WITH timeline AS (\
                SELECT id, created_at, 'message' AS kind FROM messages \
                WHERE session_id = :sid AND inherited = 0{filter} AND (:internal OR role != 'system') \
                AND NOT {VISIBLE_MESSAGE} \
                UNION ALL \
                SELECT id, created_at, 'tool' AS kind FROM tool_calls \
                WHERE session_id = :sid{filter} AND (:internal OR tool_name != 'task_update')\
             ) SELECT id, created_at, kind FROM timeline \
             ORDER BY created_at DESC, id DESC LIMIT :limit"
        ),
        &params,
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    let has_more = positions.len() > input.limit as usize;
    if has_more {
        positions.pop();
    }
    let next_cursor = positions
        .last()
        .filter(|_| has_more)
        .map(|(id, at, _)| HistoryCursor {
            at: at.clone(),
            id: id.clone(),
        });
    let ids_of = |wanted: &str| {
        positions
            .iter()
            .filter(|(_, _, kind)| kind == wanted)
            .map(|(id, _, _)| id.clone())
            .collect::<Vec<_>>()
    };
    let mut messages = load_messages(conn, session_id, &ids_of("message"))?;
    let mut tools = load_tools(conn, session_id, &ids_of("tool"), false)?;
    let mut page = HistoryPage {
        messages: Vec::new(),
        tool_calls: Vec::new(),
        next_cursor,
        process_summaries: Vec::new(),
    };
    for (id, _, kind) in positions.into_iter().rev() {
        if kind == "message" {
            page.messages.extend(messages.remove(&id));
        } else {
            page.tool_calls.extend(tools.remove(&id));
        }
    }
    Ok(page)
}

#[cfg(test)]
mod tests;
