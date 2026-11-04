//! Clipboard and informational rendering used by slash commands.
use super::*;
use std::io::Write;

/// Copy via OSC 52 (works over SSH) and, when available, the local clipboard tool.
pub(super) async fn copy(text: &str) -> Result<Value> {
    use tokio::io::AsyncWriteExt;
    write!(
        std::io::stdout(),
        "\x1b]52;c;{}\x07",
        base64_lite::encode(text.as_bytes())
    )?;
    std::io::stdout().flush()?;
    let tools: &[&str] = if cfg!(windows) {
        &["clip.exe"]
    } else if cfg!(target_os = "macos") {
        &["pbcopy"]
    } else {
        &["wl-copy", "xclip -selection clipboard"]
    };
    for tool in tools {
        let mut parts = tool.split(' ');
        let mut command = tokio::process::Command::new(parts.next().unwrap());
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = match command
            .args(parts)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(child) => child,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        let copied = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            let mut stdin = child.stdin.take().unwrap();
            let bytes = if cfg!(windows) {
                text.encode_utf16().flat_map(u16::to_le_bytes).collect()
            } else {
                text.as_bytes().to_vec()
            };
            stdin.write_all(&bytes).await?;
            drop(stdin);
            child.wait().await
        })
        .await;
        match copied {
            Ok(Ok(status)) if status.success() => return Ok(json!({"native":true})),
            Err(_) => {
                child.kill().await?;
                anyhow::bail!("clipboard helper timed out");
            }
            Ok(Err(error)) => return Err(error.into()),
            _ => continue,
        }
    }
    Ok(json!({"native":false}))
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
