use super::*;
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{handshake::server, Message},
};

#[tokio::test]
async fn connects_directly_and_through_a_proxy_without_resolving_the_relay() {
    for proxy in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let relay_url = if proxy {
            "ws://miniq-proxy-only.invalid/relay/ws?test=proxy".to_string()
        } else {
            format!("ws://{address}/relay/ws?test=direct")
        };
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = accept_hdr_async(
                stream,
                move |request: &server::Request, response: server::Response| {
                    assert_eq!(request.uri().path(), "/relay/ws");
                    if proxy {
                        assert_eq!(request.uri().host(), Some("miniq-proxy-only.invalid"));
                        assert_eq!(request.uri().query(), Some("test=proxy"));
                    }
                    assert_eq!(request.headers()[header::SEC_WEBSOCKET_VERSION], "13");
                    Ok(response)
                },
            )
            .await
            .unwrap();
            socket
                .send(Message::Text("relay ready".into()))
                .await
                .unwrap();
            assert_eq!(
                socket.next().await.unwrap().unwrap().to_text().unwrap(),
                "desktop ready"
            );
        });
        let client = if proxy {
            client_builder().proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
        } else {
            client_builder().no_proxy()
        }
        .build()
        .unwrap();
        let mut socket = tokio::time::timeout(
            Duration::from_secs(3),
            connect_with_client(&client, &relay_url),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap().to_text().unwrap(),
            "relay ready"
        );
        socket
            .send(Message::Text("desktop ready".into()))
            .await
            .unwrap();
        task.await.unwrap();
    }
}

#[tokio::test]
async fn secure_relay_uses_a_connect_tunnel_to_the_proxy() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let mut stream = BufReader::new(stream);
        let mut line = String::new();
        stream.read_line(&mut line).await.unwrap();
        assert_eq!(line, "CONNECT miniq-proxy-only.invalid:443 HTTP/1.1\r\n");
        loop {
            line.clear();
            assert_ne!(stream.read_line(&mut line).await.unwrap(), 0);
            if line == "\r\n" {
                break;
            }
        }
        stream
            .get_mut()
            .write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
    });
    let client = client_builder()
        .proxy(reqwest::Proxy::all(format!("http://{address}")).unwrap())
        .build()
        .unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        connect_with_client(&client, "wss://miniq-proxy-only.invalid/ws"),
    )
    .await
    .unwrap();
    assert!(result.is_err());
    task.await.unwrap();
}

#[test]
fn validates_the_upgrade_before_accepting_websocket_frames() {
    let key = generate_key();
    let accept = derive_accept_key(key.as_bytes());
    let response = |status, upgrade: &str, connection: &str, accepted: &str, extra| {
        let mut builder = axum::http::Response::builder()
            .status(status)
            .header(header::UPGRADE, upgrade)
            .header(header::CONNECTION, connection)
            .header(header::SEC_WEBSOCKET_ACCEPT, accepted);
        if let Some((name, value)) = extra {
            builder = builder.header(name, value);
        }
        Response::from(builder.body("").unwrap())
    };
    assert!(validate_upgrade(
        &response(
            101,
            "WebSocket",
            "keep-alive, Upgrade",
            &accept,
            None::<(&str, &str)>
        ),
        &key
    )
    .is_ok());
    for invalid in [
        response(200, "websocket", "Upgrade", &accept, None),
        response(101, "h2c", "Upgrade", &accept, None),
        response(101, "websocket", "keep-alive", &accept, None),
        response(101, "websocket", "Upgrade", "incorrect", None),
        response(
            101,
            "websocket",
            "Upgrade",
            &accept,
            Some(("Sec-WebSocket-Extensions", "permessage-deflate")),
        ),
        response(
            101,
            "websocket",
            "Upgrade",
            &accept,
            Some(("Sec-WebSocket-Protocol", "unexpected")),
        ),
    ] {
        assert!(validate_upgrade(&invalid, &key).is_err());
    }
}
