//! Clipboard and informational rendering used by slash commands.
use super::*;
use std::io::Write;

/// Copy via OSC 52 (works over SSH) and, when available, the local clipboard tool.
pub(super) fn copy(text: &str) {
    use base64_lite::encode;
    let _ = write!(
        std::io::stdout(),
        "\x1b]52;c;{}\x07",
        encode(text.as_bytes())
    );
    let _ = std::io::stdout().flush();
    for tool in ["pbcopy", "wl-copy", "xclip -selection clipboard"] {
        let mut parts = tool.split(' ');
        let Some(program) = parts.next() else {
            continue;
        };
        if let Ok(mut child) = std::process::Command::new(program)
            .args(parts)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(text.as_bytes());
            }
            let _ = child.wait();
            return;
        }
    }
}

pub(super) mod base64_lite {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(TABLE[(n >> (18 - 6 * i) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}

pub(super) fn usage(result: &Value) -> String {
    let calls = result["calls"]
        .as_array()
        .or(result["modelCalls"].as_array())
        .or(result.as_array())
        .cloned()
        .unwrap_or_default();
    let (mut input, mut output, mut cached, mut unknown) = (0u64, 0u64, 0u64, 0usize);
    for call in &calls {
        let usage = if call["response"]["usage"].is_object() {
            &call["response"]["usage"]
        } else {
            &call["usage"]
        };
        if !usage.is_object() {
            unknown += 1;
            continue;
        }
        let field = |names: &[&str]| names.iter().find_map(|n| usage[*n].as_u64()).unwrap_or(0);
        // Exact provider fields: OpenAI chat/responses and Anthropic shapes.
        input += field(&["input_tokens", "prompt_tokens", "inputTokens"]);
        output += field(&["output_tokens", "completion_tokens", "outputTokens"]);
        cached += usage["input_tokens_details"]["cached_tokens"]
            .as_u64()
            .or(usage["prompt_tokens_details"]["cached_tokens"].as_u64())
            .unwrap_or_else(|| field(&["cache_read_input_tokens", "cachedInputTokens"]));
    }
    let mut text = format!(
        "{} model call(s) · input {input} tokens ({cached} cached) · output {output} tokens",
        calls.len()
    );
    if unknown > 0 {
        text.push_str(&format!(" · {unknown} call(s) without usage data"));
    }
    text
}

pub(super) fn list_hooks(repl: &mut Repl, result: &Value) {
    let hooks = result["hooks"].as_array().cloned().unwrap_or_default();
    let mut text = String::new();
    if result["enabled"] == json!(false) {
        text.push_str("  (hooks feature flag is off)\n");
    }
    if hooks.is_empty() {
        repl.info(&format!("{}No hooks.", text.trim_start()));
        return;
    }
    for hook in hooks {
        let event = hook["event"].as_str().unwrap_or("?");
        let matcher = hook["matcher"].as_str().unwrap_or("*");
        let disabled = if hook["enabled"] == json!(false) {
            " (disabled)"
        } else {
            ""
        };
        let command = hook["command"].as_str().unwrap_or("");
        text.push_str(&format!(
            "  {event} [{matcher}]{disabled}  {}\n",
            command.to_owned()
        ));
    }
    repl.emit(&terminal_text(&text));
}

pub(super) fn list_names(repl: &mut Repl, result: &Value, keys: &[&str], label: &str) {
    let items = keys
        .iter()
        .find_map(|k| result[*k].as_array())
        .or(result.as_array())
        .cloned()
        .unwrap_or_default();
    if items.is_empty() {
        repl.info(&format!("No {label}."));
        return;
    }
    let mut text = String::new();
    for item in items {
        let name = item["name"]
            .as_str()
            .or(item["id"].as_str())
            .or(item.as_str())
            .unwrap_or("?");
        let detail = item["description"]
            .as_str()
            .or(item["status"].as_str())
            .unwrap_or("");
        text.push_str(&format!("  {name}  {}\n", detail.to_owned()));
    }
    repl.emit(&terminal_text(&text));
}
