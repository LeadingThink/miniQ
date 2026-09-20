//! Authenticated daemon transport over SSH's stdio; it never replays requests.

use std::io::BufRead;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use miniq_protocol::RpcRequest;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_tungstenite::tungstenite::Message;

use crate::client::Client;

// The daemon's WebSocket default frame limit is 16 MiB. Refuse oversized input
// explicitly instead of allocating without a bound or silently truncating it.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

pub async fn run(client: Client) -> Result<()> {
    let (mut socket, pending) = client.into_bridge_parts();
    let mut stdout = tokio::io::stdout();
    write_line(
        &mut stdout,
        &json!({"type":"miniq_bridge_ready", "protocolVersion":miniq_protocol::PROTOCOL_VERSION,
            "version":env!("CARGO_PKG_VERSION")}),
    )
    .await?;
    for event in pending {
        write_line(&mut stdout, &event).await?;
    }

    let mut input = input_lines();
    loop {
        tokio::select! {
            line = input.recv() => {
                let Some(line) = line else {
                    return Ok(());
                };
                let line = line?;
                validate_request(&line)?;
                socket.send(Message::text(line)).await
                    .context("bridge request send failed; outcome unknown, request was not replayed")?;
            }
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if text.len() > MAX_LINE_BYTES {
                        bail!("daemon bridge message exceeds the 16 MiB frame limit");
                    }
                    let value: Value = serde_json::from_str(&text).context("invalid daemon bridge JSON")?;
                    if !value.is_object() {
                        bail!("daemon bridge message must be a JSON object");
                    }
                    write_line(&mut stdout, &value).await?;
                }
                Some(Ok(Message::Ping(data))) => socket.send(Message::Pong(data)).await
                    .context("bridge keepalive failed")?,
                Some(Ok(Message::Close(_))) | None => {
                    bail!("daemon disconnected; tasks may still be running, no requests were replayed");
                }
                Some(Err(_)) => {
                    bail!("daemon transport interrupted; tasks may still be running, no requests were replayed");
                }
                Some(Ok(Message::Binary(_))) => bail!("daemon bridge requires JSON text messages"),
                _ => {}
            },
            _ = tokio::signal::ctrl_c() => return Ok(()),
        }
    }
}

async fn write_line(output: &mut tokio::io::Stdout, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    if bytes.len() > MAX_LINE_BYTES {
        bail!("daemon bridge message exceeds the 16 MiB frame limit");
    }
    bytes.push(b'\n');
    output
        .write_all(&bytes)
        .await
        .context("bridge stdout closed")?;
    output.flush().await.context("bridge stdout flush failed")
}

fn validate_request(line: &str) -> Result<()> {
    let request: RpcRequest = serde_json::from_str(line)
        .context("bridge input must be a JSON-RPC request with an id and method")?;
    if request.jsonrpc != "2.0" || request.method.trim().is_empty() {
        bail!("bridge input requires jsonrpc=2.0 and a nonempty method");
    }
    Ok(())
}

fn input_lines() -> tokio::sync::mpsc::Receiver<Result<String>> {
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    // Tokio's stdin uses a non-cancellable blocking pool read, which would keep
    // runtime shutdown waiting for input after an SSH/daemon disconnection.
    // A dedicated thread can be abandoned when the CLI process exits instead.
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            let line = match read_line(&mut stdin, MAX_LINE_BYTES) {
                Ok(Some(line)) => Ok(line),
                Ok(None) => break,
                Err(error) => Err(error),
            };
            let failed = line.is_err();
            if sender.blocking_send(line).is_err() || failed {
                break;
            }
        }
    });
    receiver
}

fn read_line(reader: &mut impl BufRead, limit: usize) -> Result<Option<String>> {
    let mut line = Vec::new();
    loop {
        let bytes = reader.fill_buf().context("bridge stdin read failed")?;
        if bytes.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                bail!("bridge stdin ended before the JSONL newline; request was not sent")
            };
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n');
        let count = newline.unwrap_or(bytes.len());
        if count > limit.saturating_sub(line.len()) {
            bail!("bridge input exceeds the 16 MiB frame limit; request was not sent");
        }
        line.extend_from_slice(&bytes[..count]);
        reader.consume(count + usize::from(newline.is_some()));
        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return String::from_utf8(line)
                .context("bridge input is not valid UTF-8")
                .map(Some);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_reader_rejects_oversize_and_partial_frames_without_truncation() {
        let mut input = std::io::Cursor::new(b"12345\n");
        assert_eq!(read_line(&mut input, 5).unwrap(), Some("12345".into()));
        assert_eq!(read_line(&mut input, 5).unwrap(), None);
        assert!(read_line(&mut std::io::Cursor::new(b"123456\n"), 5).is_err());
        assert!(read_line(&mut std::io::Cursor::new(b"12345"), 5).is_err());
        assert!(read_line(&mut std::io::Cursor::new([0xff, b'\n']), 5).is_err());
    }

    #[test]
    fn requests_need_current_protocol_and_correlatable_ids() {
        assert!(
            validate_request(r#"{"jsonrpc":"2.0","id":"one","method":"session.list"}"#).is_ok()
        );
        for invalid in [
            r#"{"jsonrpc":"1.0","id":1,"method":"session.list"}"#,
            r#"{"jsonrpc":"2.0","method":"session.list"}"#,
            r#"{"jsonrpc":"2.0","id":1,"method":" "}"#,
            "{",
            "[]",
            "null",
        ] {
            assert!(validate_request(invalid).is_err());
        }
    }
}
