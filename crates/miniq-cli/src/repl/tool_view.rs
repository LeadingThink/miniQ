//! Complete, semantic tool details; replacement diffs retain both sides verbatim.
use super::{jobs::Effect, render, Repl};
use serde_json::{json, Value};

pub fn details(tool: &Value, style: render::Style) -> String {
    let input = &tool["input"];
    let mut body = format!(
        "{}\n\nInput\n{}\n\nOutput\n{}",
        render::tool_summary(tool["toolName"].as_str().unwrap_or("tool"), input),
        crate::output::terminal_text(&serde_json::to_string_pretty(input).unwrap_or_default()),
        render::tool_finished(
            tool["status"].as_str().unwrap_or("running"),
            tool.get("output"),
            style
        )
    );
    let edits: Vec<_> = input["edits"]
        .as_array()
        .map(|edits| edits.iter().collect())
        .unwrap_or_else(|| vec![input]);
    for edit in edits {
        if let (Some(before), Some(after)) =
            (edit["old_string"].as_str(), edit["new_string"].as_str())
        {
            body.push_str("\n@@ replacement @@\n");
            for line in before.lines() {
                body.push_str(&render::diff_line(&format!("-{line}"), style));
                body.push('\n');
            }
            for line in after.lines() {
                body.push_str(&render::diff_line(&format!("+{line}"), style));
                body.push('\n');
            }
        }
    }
    body
}

impl Repl {
    pub(super) fn inspect_tool(&mut self, id: &str, detail: bool) {
        let tool = self
            .ui
            .transcript
            .entries
            .iter()
            .find(|entry| entry.id == id)
            .and_then(|entry| entry.tool.clone());
        let Some(tool) = tool else {
            return;
        };
        if !detail {
            self.ui.toggle_tool(id);
        }
        if tool["payloadDeferred"] == true {
            self.rpc(
                "Loading tool details",
                Effect::Tool {
                    id: id.into(),
                    detail,
                },
                "tool.detail",
                json!({"sessionId":self.session,"toolCallId":id}),
            );
        } else if detail {
            self.show_detail(id, &details(&tool, self.style));
        }
    }
}
