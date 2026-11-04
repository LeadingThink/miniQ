use super::*;
use serde_json::json;

const PLAIN: Style = Style { color: false };
const COLOR: Style = Style { color: true };

#[test]
fn markdown_streams_by_line() {
    let mut md = Markdown::default();
    assert_eq!(md.push("# Tit", PLAIN), "");
    assert_eq!(md.push("le\n- **a** `b`\n", PLAIN), "TITLE\n• a b\n");
    assert_eq!(md.push("> quote", PLAIN), "");
    assert_eq!(md.finish(PLAIN), "▌ quote\n");
}

#[test]
fn markdown_code_blocks_and_color() {
    let mut md = Markdown::default();
    let out = md.push("```diff\n+add\n-del\n```\n", COLOR);
    assert!(out.contains("┌── diff"));
    assert!(out.contains("\x1b[32m+add"));
    assert!(out.contains("\x1b[31m-del"));
    assert!(out.contains("└──"));
    assert_eq!(inline("**b**", COLOR), "\x1b[1mb\x1b[0m");
}

#[test]
fn markdown_strips_control_sequences() {
    let mut md = Markdown::default();
    let out = md.push("evil\x1b]52;c;AAAA\x07text\n", PLAIN);
    assert!(!out.contains('\x1b'));
}

#[test]
fn diff_rendering() {
    let result = json!({"files": [{"path": "a.rs", "additions": 1, "deletions": 1,
            "hunks": [{"lines": [
                {"kind": "context", "content": "x"},
                {"kind": "deletion", "content": "old"},
                {"kind": "addition", "content": "new"}]}]}]});
    let out = diff(&result, PLAIN);
    assert!(out.contains("a.rs +1 -1"));
    assert!(out.contains(" x\n-old\n+new\n"));
    assert_eq!(
        diff(&json!({"files": []}), PLAIN),
        "No changes in this session.\n"
    );
}

#[test]
fn tool_lines() {
    assert_eq!(
        tool_summary("shell", &json!({"command": "ls -la"})),
        "Ran shell: ls -la"
    );
    assert_eq!(
        tool_summary("file_read", &json!({"path": "a"})),
        "Read file_read: a"
    );
    let out = tool_finished("completed", Some(&json!("1\n2\n3\n4\n5\n6\n7")), PLAIN);
    assert!(out.starts_with("  ✓\n"));
    assert!(out.contains("│ 5\n"));
    assert!(out.contains("│ 6\n"));
    assert!(out.contains("│ 7\n"));
    assert!(tool_finished("failed", None, PLAIN).contains("✗ failed"));
}

#[test]
fn structured_tool_output_preserves_stdout_stderr_and_other_fields() {
    let payload = json!({"stdout":"all output", "stderr":"diagnostic", "exitCode":42,"details":{"tail":"last field"}});
    let out = tool_finished("failed", Some(&payload), PLAIN);
    for text in ["all output", "diagnostic", "42", "last field"] {
        assert!(out.contains(text));
    }
}

#[test]
fn plan_and_summary() {
    let out = plan(
        &json!([{"content": "a", "status": "completed"}, {"content": "b", "status": "in_progress"}, {"content": "c", "status": "pending"}]),
        PLAIN,
    );
    assert_eq!(out, "  ☑ a\n  ◐ b\n  ☐ c\n");
    let s = turn_summary(
        Some(
            &json!({"toolCalls": 3, "failedToolCalls": 1, "filesChanged": 2, "durationMs": 12500}),
        ),
        Default::default(),
        PLAIN,
    );
    assert_eq!(s, "─ 12.5s · 3 tools (1 failed) · 2 files changed ─\n");
    assert_eq!(duration(75_000), "1m15s");
}
