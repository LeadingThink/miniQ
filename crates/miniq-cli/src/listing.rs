//! Human-readable `miniq sessions` output. JSON remains the scripting format.

use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// "3 min ago" style age of an RFC 3339 timestamp; the raw value when unparsable.
pub fn relative(timestamp: &str, now: OffsetDateTime) -> String {
    let Ok(then) = OffsetDateTime::parse(timestamp, &Rfc3339) else {
        return timestamp.to_owned();
    };
    let seconds = (now - then).whole_seconds();
    if seconds < 0 {
        return "just now".into();
    }
    let (value, unit) = match seconds {
        0..=59 => return "just now".into(),
        60..=3_599 => (seconds / 60, "min"),
        3_600..=86_399 => (seconds / 3_600, "hour"),
        86_400..=2_591_999 => (seconds / 86_400, "day"),
        _ => return then.date().to_string(),
    };
    let plural = if value == 1 || unit == "min" { "" } else { "s" };
    format!("{value} {unit}{plural} ago")
}

fn text<'a>(session: &'a Value, key: &str) -> Option<&'a str> {
    session[key].as_str().filter(|value| !value.is_empty())
}

/// Renders a `session.list` result. `all` adds each session's project directory.
pub fn render(result: &Value, all: bool, now: OffsetDateTime) -> String {
    let sessions = result["sessions"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    if sessions.is_empty() {
        return if all {
            "No sessions yet. Run `miniq` in a project directory to start one.\n".into()
        } else {
            "No sessions in this project. Run `miniq` to start one, or `miniq sessions --all` to list every project.\n".into()
        };
    }
    let mut out = String::new();
    for session in sessions {
        let id = text(session, "id").unwrap_or("?");
        let title = text(session, "title").unwrap_or("(untitled)");
        let mut facts = vec![text(session, "status").unwrap_or("unknown").to_owned()];
        let updated = text(session, "lastActivityAt").or_else(|| text(session, "updatedAt"));
        if let Some(updated) = updated {
            facts.push(relative(updated, now));
        }
        if let Some(turns) = session["turnCount"].as_u64() {
            facts.push(format!("{turns} turn{}", if turns == 1 { "" } else { "s" }));
        }
        if session["pinned"] == true {
            facts.push("pinned".into());
        }
        if session["archived"] == true {
            facts.push("archived".into());
        }
        if !session["external"].is_null() {
            facts.push("imported".into());
        }
        out.push_str(&format!("{title} · {}\n  {id}\n", facts.join(" · ")));
        if all {
            if let Some(directory) = text(session, "workingDirectory") {
                out.push_str(&format!("  {directory}\n"));
            }
        }
        if let Some(preview) = text(session, "preview") {
            out.push_str(&format!("  {preview}\n"));
        }
    }
    let count = sessions.len();
    out.push_str(&format!(
        "\n{count} session{}. Next: miniq history ID · miniq watch ID · miniq resume ID (JSON: --json)\n",
        if count == 1 { "" } else { "s" }
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> OffsetDateTime {
        OffsetDateTime::parse("2026-09-25T12:00:00Z", &Rfc3339).unwrap()
    }

    #[test]
    fn relative_ages() {
        assert_eq!(relative("2026-09-25T11:59:30Z", now()), "just now");
        assert_eq!(relative("2026-09-25T11:55:00Z", now()), "5 min ago");
        assert_eq!(relative("2026-09-25T11:00:00Z", now()), "1 hour ago");
        assert_eq!(relative("2026-09-22T12:00:00Z", now()), "3 days ago");
        assert_eq!(relative("2026-06-01T00:00:00Z", now()), "2026-06-01");
        assert_eq!(relative("not a time", now()), "not a time");
    }

    #[test]
    fn renders_titles_ids_and_markers() {
        let result = json!({"sessions":[
            {"id":"s1","title":"中文项目测试","status":"idle","updatedAt":"2026-09-25T11:00:00Z",
             "turnCount":2,"preview":"最后一条消息","workingDirectory":"/work/a"},
            {"id":"s2","title":"","status":"running","updatedAt":"2026-09-24T12:00:00Z",
             "archived":true,"external":{"provider":"codex"},"pinned":true}
        ]});
        let text = render(&result, true, now());
        assert!(text.contains(
            "中文项目测试 · idle · 1 hour ago · 2 turns\n  s1\n  /work/a\n  最后一条消息\n"
        ));
        assert!(text
            .contains("(untitled) · running · 1 day ago · pinned · archived · imported\n  s2\n"));
        assert!(text.contains("2 sessions. Next: miniq history ID"));
        assert!(!render(&result, false, now()).contains("/work/a"));
    }

    #[test]
    fn empty_lists_point_to_next_step() {
        assert!(render(&json!({"sessions":[]}), false, now()).contains("miniq sessions --all"));
    }
}
