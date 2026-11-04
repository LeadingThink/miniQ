use super::*;
use serde_json::json;

#[test]
fn live_partial_lines_are_visible_and_final_message_replaces_them_once() {
    let mut transcript = Transcript::default();
    transcript.event(&json!({"type":"assistant_delta","delta":"Hello **world"}));
    assert_eq!(transcript.entries[0].content, "Hello **world");
    assert!(transcript
        .lines(80, false, false)
        .iter()
        .any(|l| l.to_string().contains("world")));
    transcript.event(&json!({"type":"message_created","message":{"id":"m","role":"assistant","content":"Hello **world**!"}}));
    transcript.event(&json!({"type":"message_created","message":{"id":"m","role":"assistant","content":"Hello **world**!"}}));
    assert_eq!(transcript.entries.len(), 1);
    assert_eq!(transcript.entries[0].content, "Hello **world**!");
}

#[test]
fn provider_retry_removes_only_its_partial_message() {
    let mut transcript = Transcript::default();
    transcript.notice("keep this notice");
    transcript.event(&json!({"type":"assistant_delta","delta":"discard"}));
    transcript.event(&json!({"type":"assistant_replaced"}));
    transcript.event(&json!({"type":"assistant_delta","delta":"replacement"}));
    assert_eq!(transcript.entries.len(), 2);
    assert_eq!(transcript.entries[0].content, "keep this notice");
    assert_eq!(transcript.entries[1].content, "replacement");
}

#[test]
fn restores_ordered_history_tools_and_active_stream_and_pages_without_duplicates() {
    let mut transcript = Transcript::default();
    transcript.restore(&json!({"messages":[{"id":"m2","role":"assistant","content":"answer","createdAt":"3"},
        {"id":"m1","role":"user","content":"question","createdAt":"1"}],
        "toolCalls":[{"id":"t","toolName":"shell","input":{"command":"ls"},"createdAt":"2","status":"succeeded"}],
        "nextCursor":{"at":"1","id":"m1"},"streamingText":"live"}));
    assert_eq!(
        transcript
            .entries
            .iter()
            .map(|e| e.id.as_str())
            .collect::<Vec<_>>(),
        ["m1", "t", "m2", ""]
    );
    transcript.prepend(
        &json!({"messages":[{"id":"old","role":"user","content":"older","createdAt":"0"},
        {"id":"m1","role":"user","content":"question","createdAt":"1"}], "nextCursor":null}),
    );
    transcript.event(&json!({"type":"assistant_delta","delta":" tail"}));
    assert_eq!(transcript.entries.len(), 5);
    assert_eq!(transcript.entries.last().unwrap().content, "live tail");
    assert!(transcript.next_cursor.is_none());
}

#[test]
fn collapsed_tools_keep_complete_output_for_expansion_including_last_line() {
    let output = format!(
        "{}\nTAIL_MARKER",
        "very long tool output 中文\n".repeat(300)
    );
    let mut transcript = Transcript::default();
    transcript.event(&json!({"type":"tool_call_started","toolCallId":"t","toolName":"shell","input":{"command":"ls"}}));
    transcript.event(
        &json!({"type":"tool_call_finished","toolCallId":"t","status":"succeeded","output":output}),
    );
    assert_eq!(
        transcript.entries[0].tool.as_ref().unwrap()["output"],
        output
    );
    assert!(!transcript
        .lines(30, false, false)
        .iter()
        .any(|l| l.to_string().contains("TAIL_MARKER")));
    assert!(transcript
        .lines(30, true, false)
        .iter()
        .any(|l| l.to_string().contains("TAIL_MARKER")));
}

#[test]
fn renders_unterminated_code_blocks_without_resetting_their_style() {
    let mut markdown = render::Markdown::default();
    markdown.push("```rust\n", render::Style::plain());
    markdown.push("let x = 1;", render::Style::plain());
    assert_eq!(markdown.finish(render::Style::plain()), "│ let x = 1;\n");
}
