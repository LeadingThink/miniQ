//! Memory text is a disposable projection, not durable conversation evidence.
use crate::{ArchivedToolResult, ChatMessage};
use serde_json::{json, Value};
use std::collections::HashSet;
fn memory_tool(name: &str) -> bool {
    matches!(
        name,
        "memory_search" | "memory_read" | "memory_write" | "memory_forget" | "memory_project_read"
    )
}
fn references(raw: &str) -> String {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return json!({"memoryReferences":[],"refreshWith":"memory_read"}).to_string();
    };
    let rows = value
        .get("memories")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .chain(value.get("memory").filter(|v| v.is_object()));
    let refs=value.get("memoryReferences").and_then(Value::as_array).cloned().unwrap_or_else(|| rows.map(|row|json!({"id":row["id"],"scope":row["scope"],"workspaceId":row["workspaceId"],"revision":row["revision"]})).collect::<Vec<_>>());
    let project = value
        .get("projectReference")
        .cloned()
        .unwrap_or_else(|| value["projectSummary"]["sessionId"].clone());
    json!({"memoryReferences":refs,"projectReference":project,"status":value["status"],"deleted":value["deleted"],"error":value["error"],"reason":value["reason"],"refreshWith":"memory_read / memory_project_read"}).to_string()
}
pub fn strip_memory_archive(results: &mut [ArchivedToolResult]) {
    for item in results {
        if memory_tool(&item.tool) {
            item.content = references(&item.content);
            item.arguments = json!({"refreshWith":"memory_read"});
        }
    }
}
pub fn strip_memory_payloads(messages: &mut [ChatMessage]) {
    let calls = messages
        .iter()
        .flat_map(|m| &m.tool_calls)
        .filter(|c| memory_tool(&c.name))
        .map(|c| c.id.clone())
        .collect::<HashSet<_>>();
    for message in messages {
        for call in &mut message.tool_calls {
            if memory_tool(&call.name) {
                message.provider_context = None;
                if let Some(args) = call.arguments.as_object_mut() {
                    for field in ["content", "expectedContent"] {
                        if args.contains_key(field) {
                            args.insert(
                                field.into(),
                                json!("[historical memory text; read the current fact]"),
                            );
                        }
                    }
                }
            }
        }
        if message
            .tool_call_id
            .as_ref()
            .is_some_and(|id| calls.contains(id))
        {
            message.content = references(&message.content);
            message.provider_context = None;
        }
        if let Some(archive) = &mut message.working_memory {
            strip_memory_archive(&mut archive.results);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ToolCallRequest;
    #[test]
    fn memory_projection_drops_text_from_replays_and_archives_but_preserves_file_evidence() {
        let row = json!({"id":"m1","scope":"global","workspaceId":null,"revision":1,"content":"SECRET_MEMORY_TEXT"});
        let mut call = ChatMessage::assistant("");
        call.tool_calls.push(ToolCallRequest {
            id: "c1".into(),
            name: "memory_write".into(),
            arguments: json!({"content":"SECRET_MEMORY_TEXT"}),
        });
        let result =
            ChatMessage::tool_result("c1", json!({"status":"added","memory":row}).to_string());
        let file = ChatMessage::tool_result("file", "file evidence");
        let mut messages = vec![call, result, file];
        strip_memory_payloads(&mut messages);
        assert!(!serde_json::to_string(&messages)
            .unwrap()
            .contains("SECRET_MEMORY_TEXT"));
        assert_eq!(messages[2].content, "file evidence");
        let mut rehydrated: Value = serde_json::from_str(&messages[1].content).unwrap();
        rehydrated["memories"] = json!([row]);
        messages[1].content = rehydrated.to_string();
        strip_memory_payloads(&mut messages);
        assert!(!messages[1].content.contains("SECRET_MEMORY_TEXT"));
        assert_eq!(
            serde_json::from_str::<Value>(&messages[1].content).unwrap()["memoryReferences"][0]
                ["id"],
            "m1"
        );
        let mut archive = vec![ArchivedToolResult {
            id: "c1".into(),
            tool: "memory_read".into(),
            arguments: json!({}),
            content: json!({"memory":row}).to_string(),
        }];
        strip_memory_archive(&mut archive);
        assert!(!archive[0].content.contains("SECRET_MEMORY_TEXT"));
        let mut handoff=vec![ArchivedToolResult{id:"p1".into(),tool:"memory_project_read".into(),arguments:json!({"sourceSessionId":"s1"}),content:json!({"projectSummary":{"sessionId":"s1","decisions":[row],"goal":"SECRET_MEMORY_TEXT"}}).to_string()}];
        strip_memory_archive(&mut handoff);
        assert!(!handoff[0].content.contains("SECRET_MEMORY_TEXT"));
        assert_eq!(
            serde_json::from_str::<Value>(&handoff[0].content).unwrap()["projectReference"],
            "s1"
        );
    }
}
