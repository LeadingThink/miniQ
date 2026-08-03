//! Minimal MCP server over stdio, used by integration tests. Implements
//! initialize, tools/list and tools/call (an `echo` tool).

use std::io::{BufRead, Write};

fn main() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(method) = msg.get("method").and_then(|m| m.as_str()) else {
            continue;
        };
        let id = msg.get("id").cloned();
        let result = match method {
            "initialize" => serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "mock-mcp", "version": "0.1.0"},
            }),
            "tools/list" => serde_json::json!({
                "tools": [{
                    "name": "echo",
                    "description": "Echo the message back",
                    "inputSchema": {"type": "object", "properties": {"message": {"type": "string"}}}
                }]
            }),
            "tools/call" => {
                let message = msg["params"]["arguments"]["message"].as_str().unwrap_or("");
                serde_json::json!({
                    "content": [{"type": "text", "text": format!("echo: {message}")}],
                    "isError": false,
                })
            }
            // Notifications (no id) get no response.
            _ => continue,
        };
        if let Some(id) = id {
            let response = serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result});
            let mut out = stdout.lock();
            let _ = writeln!(out, "{response}");
            let _ = out.flush();
        }
    }
}
