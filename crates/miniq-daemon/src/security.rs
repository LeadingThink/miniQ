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
    let trimmed = value.trim_start();
    if trimmed.starts_with('{') || trimmed.starts_with('[') {
        if let Ok(mut parsed) = serde_json::from_str::<Value>(value) {
            redact_sensitive(&mut parsed);
            return parsed.to_string();
        }
    }
    command_patterns()
        .iter()
        .fold(value.to_string(), |text, pattern| {
            pattern
                .replace_all(&text, format!("${{1}}{REDACTED}"))
                .into_owned()
        })
}

pub(crate) fn redact_sensitive(value: &mut Value) {
    match value {
        Value::Object(entries) => {
            for (key, entry) in entries {
                if sensitive_key(key) {
                    *entry = Value::String(REDACTED.to_string());
                } else {
                    redact_sensitive(entry);
                }
            }
        }
        Value::Array(entries) => {
            for entry in entries {
                redact_sensitive(entry);
            }
        }
        Value::String(text) => *text = redact_string(text),
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
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
        message.content = redact_string(&message.content);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
