use futures_util::StreamExt;

use crate::{ChatDelta, DeltaStream, ProviderError};

pub(crate) struct DecodedEvent {
    pub items: Vec<Result<ChatDelta, ProviderError>>,
    pub terminal: bool,
}

impl DecodedEvent {
    pub fn continue_with(items: Vec<Result<ChatDelta, ProviderError>>) -> Self {
        Self {
            items,
            terminal: false,
        }
    }

    pub fn terminal(items: Vec<Result<ChatDelta, ProviderError>>) -> Self {
        Self {
            items,
            terminal: true,
        }
    }
}

pub(crate) trait EventDecoder: Send + 'static {
    fn decode(&mut self, event: &str) -> DecodedEvent;
    fn finish(&mut self) -> Vec<Result<ChatDelta, ProviderError>>;
}

pub(crate) fn event_data(event: &str) -> Option<String> {
    let normalized = event.replace('\r', "\n");
    let data = normalized
        .lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
        .collect::<Vec<_>>()
        .join("\n");
    (!data.is_empty()).then_some(data)
}

fn newline_length(buffer: &[u8], index: usize) -> usize {
    match buffer.get(index) {
        Some(b'\r') if buffer.get(index + 1) == Some(&b'\n') => 2,
        Some(b'\r' | b'\n') => 1,
        _ => 0,
    }
}

pub(crate) fn take_event(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let mut index = 0;
    while index < buffer.len() {
        let first = newline_length(buffer, index);
        if first == 0 {
            index += 1;
            continue;
        }
        let second = newline_length(buffer, index + first);
        if second == 0 {
            index += first;
            continue;
        }
        let event = buffer.drain(..index).collect();
        buffer.drain(..first + second);
        return Some(event);
    }
    None
}

pub(crate) fn decode_event_bytes(bytes: &[u8]) -> Result<&str, ProviderError> {
    std::str::from_utf8(bytes).map_err(|error| {
        ProviderError::InvalidResponse(format!("SSE event is not valid UTF-8: {error}"))
    })
}

pub(crate) fn response_stream<D>(response: reqwest::Response, decoder: D) -> DeltaStream
where
    D: EventDecoder,
{
    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    tokio::spawn(run_response_stream(response, decoder, tx));
    Box::pin(futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx)))
}

async fn emit_decoded(
    decoded: DecodedEvent,
    tx: &tokio::sync::mpsc::Sender<Result<ChatDelta, ProviderError>>,
) -> bool {
    for item in decoded.items {
        if tx.send(item).await.is_err() {
            return true;
        }
    }
    decoded.terminal
}

async fn decode_and_emit<D: EventDecoder>(
    bytes: &[u8],
    decoder: &mut D,
    tx: &tokio::sync::mpsc::Sender<Result<ChatDelta, ProviderError>>,
) -> bool {
    let event = match decode_event_bytes(bytes) {
        Ok(event) => event,
        Err(error) => {
            let _ = tx.send(Err(error)).await;
            return true;
        }
    };
    emit_decoded(decoder.decode(event), tx).await
}

async fn run_response_stream<D>(
    response: reqwest::Response,
    mut decoder: D,
    tx: tokio::sync::mpsc::Sender<Result<ChatDelta, ProviderError>>,
) where
    D: EventDecoder,
{
    let mut buffer = Vec::new();
    let mut byte_stream = response.bytes_stream();
    while let Some(chunk) = byte_stream.next().await {
        match chunk {
            Ok(chunk) => buffer.extend_from_slice(&chunk),
            Err(error) => {
                let _ = tx.send(Err(ProviderError::Http(error))).await;
                return;
            }
        }
        while let Some(event) = take_event(&mut buffer) {
            if decode_and_emit(&event, &mut decoder, &tx).await {
                return;
            }
        }
    }
    if !buffer.iter().all(u8::is_ascii_whitespace)
        && decode_and_emit(&buffer, &mut decoder, &tx).await
    {
        return;
    }
    for item in decoder.finish() {
        if tx.send(item).await.is_err() {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buffers_split_utf8_until_the_complete_event_arrives() {
        let bytes = "data: {\"text\":\"中文\"}\n\n".as_bytes();
        let split = bytes.iter().position(|byte| *byte >= 0x80).unwrap() + 1;
        let mut buffer = bytes[..split].to_vec();
        assert!(take_event(&mut buffer).is_none());
        buffer.extend_from_slice(&bytes[split..]);
        let event = take_event(&mut buffer).unwrap();
        assert!(decode_event_bytes(&event).unwrap().contains("中文"));
    }

    #[test]
    fn recognizes_common_event_boundaries() {
        for separator in ["\n\n", "\r\n\r\n", "\r\r", "\r\n\n", "\n\r\n"] {
            let mut buffer = format!("data: done{separator}next").into_bytes();
            assert_eq!(take_event(&mut buffer).unwrap(), b"data: done");
            assert_eq!(buffer, b"next");
        }
    }
}
