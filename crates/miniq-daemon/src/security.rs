use std::sync::OnceLock;

use miniq_models::ChatMessage;
use regex::Regex;
use serde_json::Value;

const REDACTED: &str = "[REDACTED]";

fn sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "password"
            | "passwd"
            | "passphrase"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "authorization"
            | "privatekey"
            | "clientsecret"
            | "secret"
            | "token"
            | "cookie"
    )
}

fn command_patterns() -> &'static [Regex] {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r#"(?i)(authorization\s*:\s*bearer\s+)[^\s'"]+"#,
            r#"(?i)((?:--?password|--?passwd|--?token|--?api[-_]?key)\s*(?:=|\s)\s*)[^\s'"]+"#,
            r#"(?i)((?:password|passwd|token|api[-_]?key|secret)=)[^\s'"]+"#,
            r#"(?i)(sshpass\s+-p\s+)[^\s'"]+"#,
        ]
        .into_iter()
        .map(|pattern| Regex::new(pattern).expect("valid redaction pattern"))
        .collect()
    })
}

fn redact_string(value: &str) -> String {
    if value.contains("PRIVATE KEY-----") {
        return REDACTED.to_string();
    }
    let mut text = String::with_capacity(value.len());
    let mut cursor = 0;
    // Provider errors wrap JSON bodies in diagnostic text. Parse complete
    // fragments while retaining surrounding text and unchanged JSON verbatim.
    while let Some(relative_start) = value[cursor..].find(['{', '[']) {
        let start = cursor + relative_start;
        let mut fragments =
            serde_json::Deserializer::from_str(&value[start..]).into_iter::<Value>();
        if let Some(Ok(mut parsed)) = fragments.next() {
            let end = start + fragments.byte_offset();
            text.push_str(&value[cursor..start]);
            if redact_sensitive(&mut parsed) {
                text.push_str(&parsed.to_string());
            } else {
                text.push_str(&value[start..end]);
            }
            cursor = end;
        } else {
            text.push_str(&value[cursor..start + 1]);
            cursor = start + 1;
        }
    }
    text.push_str(&value[cursor..]);
    command_patterns().iter().fold(text, |text, pattern| {
        pattern
            .replace_all(&text, format!("${{1}}{REDACTED}"))
            .into_owned()
    })
}

pub(crate) fn redact_sensitive(value: &mut Value) -> bool {
    let mut changed = false;
    match value {
        Value::Object(entries) => {
            for (key, entry) in entries {
                if sensitive_key(key) {
                    if entry.as_str() != Some(REDACTED) {
                        *entry = Value::String(REDACTED.to_string());
                        changed = true;
                    }
                } else {
                    changed |= redact_sensitive(entry);
                }
            }
        }
        Value::Array(entries) => {
            for entry in entries {
                changed |= redact_sensitive(entry);
            }
        }
        Value::String(text) => {
            let redacted = redact_string(text);
            changed = *text != redacted;
            *text = redacted;
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    changed
}

pub(crate) fn redacted(mut value: Value) -> Value {
    redact_sensitive(&mut value);
    value
}

pub(crate) fn redact_provider_history(history: &mut [ChatMessage]) {
    for message in history {
        for call in &mut message.tool_calls {
            redact_sensitive(&mut call.arguments);
        }
        if let Some(context) = &mut message.provider_context {
            redact_sensitive(&mut context.data);
        }
        for archived in &mut message.image_archive {
            for source in &mut archived.sources {
                source.source_content = redact_string(&source.source_content);
                if let Some(arguments) = &mut source.tool_arguments {
                    redact_sensitive(arguments);
                }
            }
        }
        if let Some(memory) = &mut message.working_memory {
            for result in &mut memory.results {
                redact_sensitive(&mut result.arguments);
                result.content = redact_string(&result.content);
            }
        }
        message.content = redact_string(&message.content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_archive_is_redacted_without_losing_recall_ids() {
        let mut message = ChatMessage::assistant("handoff");
        message.working_memory = Some(miniq_models::WorkingMemory {
            results: vec![miniq_models::ArchivedToolResult {
                id: "call-1".into(),
                tool: "shell_run".into(),
                arguments: serde_json::json!({"api_key":"never-log-key"}),
                content: r#"{"password":"never-log-output"}"#.into(),
            }],
        });
        redact_provider_history(std::slice::from_mut(&mut message));
        let stored = serde_json::to_string(&message).unwrap();
        assert!(!stored.contains("never-log"));
        assert!(stored.contains("call-1"));
        assert!(stored.contains(REDACTED));
    }

    #[test]
    fn image_archive_provenance_is_redacted_without_losing_trusted_reference() {
        let mut carrier = ChatMessage::system("");
        carrier.image_archive = serde_json::from_value(serde_json::json!([{
            "id":"img_1", "image":{"path":"/trusted/image.png","mime_type":"image/png"},
            "sources":[{"role":"tool","image_index":0,"tool_call_id":"read-1","tool_name":"view_image",
                "source_content":"curl -H 'Authorization: Bearer never-log-source' https://example.test",
                "tool_arguments":{"path":"/trusted/image.png","api_key":"never-log-key"}}]
        }])).unwrap();
        redact_provider_history(std::slice::from_mut(&mut carrier));
        let archive = &carrier.image_archive[0];
        assert_eq!(archive.id, "img_1");
        assert_eq!(archive.image.path, "/trusted/image.png");
        assert_eq!(archive.sources[0].tool_call_id.as_deref(), Some("read-1"));
        let stored = serde_json::to_string(&carrier).unwrap();
        assert!(!stored.contains("never-log"));
        assert!(stored.contains(REDACTED));
    }

    #[test]
    fn redacts_nested_credentials_and_shell_flags() {
        let value = serde_json::json!({
            "password": "plain-secret",
            "nested": {"api_key": "sk-secret"},
            "command": "curl -H 'Authorization: Bearer secret-token' --password hunter2"
        });

        let redacted = redacted(value);

        assert_eq!(redacted["password"], REDACTED);
        assert_eq!(redacted["nested"]["api_key"], REDACTED);
        let command = redacted["command"].as_str().unwrap();
        assert!(!command.contains("secret-token"));
        assert!(!command.contains("hunter2"));
    }

    #[test]
    fn redacts_credentials_embedded_in_json_strings() {
        let value = Value::String(r#"{"username":"root","password":"secret"}"#.to_string());
        let redacted = redacted(value);

        assert!(!redacted.as_str().unwrap().contains("secret"));
        assert!(redacted.as_str().unwrap().contains(REDACTED));
    }

    #[test]
    fn redacts_json_credentials_inside_provider_error_text() {
        let diagnostic = "下载详情：网络超时；".repeat(1024);
        let body = serde_json::json!({
            "error": {
                "message": "download failed",
                "diagnostic": diagnostic,
                "api_key": "fixture-secret",
                "details": [{"authorization": "Bearer fixture-token", "attempt": 3}]
            },
            "request_id": "fixture-id"
        });
        let prefix = "provider returned 401: ";
        let suffix = " (request id: fixture-id)";
        let reason = redact_string(&format!("{prefix}{body}{suffix}"));
        let body: Value = serde_json::from_str(
            reason
                .strip_prefix(prefix)
                .unwrap()
                .strip_suffix(suffix)
                .unwrap(),
        )
        .unwrap();
        assert_eq!(body["error"]["api_key"], REDACTED);
        assert_eq!(body["error"]["details"][0]["authorization"], REDACTED);
        assert_eq!(body["error"]["details"][0]["attempt"], 3);
        assert_eq!(body["error"]["message"], "download failed");
        assert_eq!(body["error"]["diagnostic"], diagnostic);
        assert_eq!(body["request_id"], "fixture-id");
        assert!(!reason.contains("fixture-secret"));
        assert!(!reason.contains("fixture-token"));
    }

    #[test]
    fn redacts_multiple_json_fragments_after_ordinary_brackets() {
        let reason = redact_string(
            r#"[attempt 1] {"api_key":"first-secret"} details [{"token":"second-secret"}] retry later"#,
        );
        assert_eq!(
            reason,
            r#"[attempt 1] {"api_key":"[REDACTED]"} details [{"token":"[REDACTED]"}] retry later"#
        );
    }

    #[test]
    fn retains_ordinary_error_reasons_and_non_sensitive_json_verbatim() {
        for reason in [
            "provider error: The request timed out while trying to download the file. (request id: fixture)",
            "download failed [attempt 2] {status unavailable}: please retry later",
            r#"provider returned 429: { "message": "retry later", "request_id": "fixture" } (request id: fixture)"#,
        ] {
            assert_eq!(redact_string(reason), reason);
        }
    }

    #[test]
    fn redacts_provider_native_tool_context() {
        let mut message = ChatMessage::assistant("");
        message.provider_context = Some(miniq_models::ProviderContext {
            protocol: miniq_models::ApiProtocol::AnthropicMessages,
            data: serde_json::json!([{
                "type": "tool_use",
                "id": "call-1",
                "name": "shell_run",
                "input": {
                    "command": "curl -H 'Authorization: Bearer secret-token' https://example.test",
                    "api_key": "sk-secret"
                }
            }]),
        });

        redact_provider_history(std::slice::from_mut(&mut message));

        let context = &message.provider_context.unwrap().data;
        assert_eq!(context[0]["input"]["api_key"], REDACTED);
        assert!(!context[0]["input"]["command"]
            .as_str()
            .unwrap()
            .contains("secret-token"));
    }
}
