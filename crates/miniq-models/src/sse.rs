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
    first_event_sent: &mut bool,
) -> bool {
    let event = match decode_event_bytes(bytes) {
        Ok(event) => event,
        Err(error) => {
            let _ = tx.send(Err(error)).await;
            return true;
        }
    };
    if !*first_event_sent && event_data(event).is_some() {
        *first_event_sent = true;
        if tx
            .send(Ok(ChatDelta::FirstEvent(std::time::Instant::now())))
            .await
            .is_err()
        {
            return true;
        }
    }
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
    let mut first_event_sent = false;
    let mut byte_stream = response.bytes_stream();
    loop {
        let chunk = tokio::select! {
            biased;
            _ = tx.closed() => return,
            chunk = byte_stream.next() => chunk,
        };
        let Some(chunk) = chunk else { break };
        match chunk {
            Ok(chunk) => buffer.extend_from_slice(&chunk),
            Err(error) => {
                let _ = tx.send(Err(ProviderError::Http(error))).await;
                return;
            }
        }
        while let Some(event) = take_event(&mut buffer) {
            if decode_and_emit(&event, &mut decoder, &tx, &mut first_event_sent).await {
                return;
            }
        }
    }
    if !buffer.iter().all(u8::is_ascii_whitespace)
        && decode_and_emit(&buffer, &mut decoder, &tx, &mut first_event_sent).await
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

    struct EmptyDecoder;

    impl EventDecoder for EmptyDecoder {
        fn decode(&mut self, _: &str) -> DecodedEvent {
            DecodedEvent::continue_with(vec![])
        }
        fn finish(&mut self) -> Vec<Result<ChatDelta, ProviderError>> {
            vec![]
        }
    }

    struct TrackedDecoder(std::sync::Arc<tokio::sync::Notify>);

    impl Drop for TrackedDecoder {
        fn drop(&mut self) {
            self.0.notify_one();
        }
    }

    impl EventDecoder for TrackedDecoder {
        fn decode(&mut self, _: &str) -> DecodedEvent {
            DecodedEvent::continue_with(vec![])
        }
        fn finish(&mut self) -> Vec<Result<ChatDelta, ProviderError>> {
            vec![]
        }
    }

    #[tokio::test]
    async fn dropping_consumer_closes_silent_and_heartbeat_response_streams() {
        use std::time::Duration;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for heartbeat in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    assert_ne!(socket.read_buf(&mut request).await.unwrap(), 0);
                }
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
                let mut buffer = [0; 1];
                loop {
                    tokio::select! {
                        result = socket.read(&mut buffer) => {
                            match result {
                                Ok(0) => {}
                                Err(error) if matches!(error.kind(),
                                    std::io::ErrorKind::ConnectionReset
                                    | std::io::ErrorKind::ConnectionAborted
                                    | std::io::ErrorKind::BrokenPipe) => {}
                                other => panic!("response connection must close: {other:?}"),
                            }
                            break;
                        }
                        _ = tokio::time::sleep(Duration::from_millis(10)), if heartbeat => {
                            if socket.write_all(b"E\r\n: keep-alive\n\n\r\n").await.is_err() {
                                break;
                            }
                        }
                    }
                }
            });
            let client = reqwest::Client::builder()
                .no_proxy()
                .pool_max_idle_per_host(0)
                .build()
                .unwrap();
            let response = client
                .get(format!("http://{address}/"))
                .send()
                .await
                .unwrap();
            let released = std::sync::Arc::new(tokio::sync::Notify::new());
            let stream = response_stream(response, TrackedDecoder(released.clone()));
            // Let the worker enter its pending read, including ignored heartbeats.
            assert!(
                tokio::time::timeout(Duration::from_millis(40), released.notified())
                    .await
                    .is_err(),
                "reader must remain active while the consumer exists; heartbeat={heartbeat}"
            );
            drop(stream);
            let stopped = tokio::time::timeout(Duration::from_secs(1), released.notified()).await;
            if stopped.is_err() {
                server.abort();
            }
            assert!(
                stopped.is_ok(),
                "consumer drop must stop SSE reader; heartbeat={heartbeat}"
            );
            tokio::time::timeout(Duration::from_secs(1), server)
                .await
                .expect("upstream connection must be released")
                .unwrap();
        }
    }

    #[tokio::test]
    async fn first_data_event_is_observed_once_even_when_decoder_has_no_output() {
        let (tx, mut rx) = tokio::sync::mpsc::channel(8);
        let mut decoder = EmptyDecoder;
        let mut sent = false;
        assert!(!decode_and_emit(b": keep-alive", &mut decoder, &tx, &mut sent).await);
        assert!(!sent);
        assert!(rx.try_recv().is_err());
        let before = std::time::Instant::now();
        assert!(
            !decode_and_emit(
                b"data: {\"type\":\"response.created\"}",
                &mut decoder,
                &tx,
                &mut sent
            )
            .await
        );
        let Some(Ok(ChatDelta::FirstEvent(observed))) = rx.recv().await else {
            panic!("missing transport timing");
        };
        assert!(observed >= before && observed <= std::time::Instant::now());
        assert!(!decode_and_emit(b"data: another event", &mut decoder, &tx, &mut sent).await);
        assert!(rx.try_recv().is_err());
    }

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
