wit_bindgen::generate!({
    world: "tool-plugin",
    path: "wit",
});

use exports::miniq::plugin::guest::{ExecutionResult, Guest, PluginIdentity, ToolMetadata};
use serde::Deserialize;
use serde_json::json;

struct TextStats;

#[derive(Deserialize)]
struct Arguments {
    text: String,
}

impl Guest for TextStats {
    fn identity() -> PluginIdentity {
        PluginIdentity {
            id: "dev.miniq.text-stats".into(),
            version: "1.0.0".into(),
            api_version: "1.0.0".into(),
        }
    }

    fn tools() -> Vec<ToolMetadata> {
        vec![ToolMetadata {
            name: "count".into(),
            description: "Count characters, words, and lines in text.".into(),
            input_schema_json: json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"],
                "additionalProperties": false
            })
            .to_string(),
            output_schema_json: json!({
                "type": "object",
                "properties": {
                    "characters": { "type": "integer" },
                    "words": { "type": "integer" },
                    "lines": { "type": "integer" }
                },
                "required": ["characters", "words", "lines"],
                "additionalProperties": false
            })
            .to_string(),
        }]
    }

    fn execute(tool_name: String, arguments_json: String) -> ExecutionResult {
        if tool_name != "count" {
            return ExecutionResult::Error("unknown tool".into());
        }
        let arguments: Arguments = match serde_json::from_str(&arguments_json) {
            Ok(arguments) => arguments,
            Err(_) => return ExecutionResult::Error("invalid arguments".into()),
        };
        ExecutionResult::Ok(
            json!({
                "characters": arguments.text.chars().count(),
                "words": arguments.text.split_whitespace().count(),
                "lines": arguments.text.lines().count()
            })
            .to_string(),
        )
    }
}

export!(TextStats);