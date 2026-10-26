//! Use the HTTP client's system proxy and TLS policy for the relay handshake.

use reqwest::{header, Client, ClientBuilder, Response, StatusCode, Url};
use tokio_tungstenite::{
    tungstenite::{
        handshake::{client::generate_key, derive_accept_key},
        protocol::Role,
    },
    WebSocketStream,
};

pub(super) type RelaySocket = WebSocketStream<reqwest::Upgraded>;

pub(super) async fn connect(relay_url: &str) -> anyhow::Result<RelaySocket> {
    // Re-read proxy settings on reconnect, including changes made while miniQ runs.
    let client = client_builder().build()?;
    connect_with_client(&client, relay_url).await
}

fn client_builder() -> ClientBuilder {
    Client::builder()
        .http1_only()
        .redirect(reqwest::redirect::Policy::none())
}

async fn connect_with_client(client: &Client, relay_url: &str) -> anyhow::Result<RelaySocket> {
    let mut url = Url::parse(relay_url)?;
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        _ => anyhow::bail!("relay 地址必须使用 ws 或 wss"),
    };
    url.set_scheme(scheme)
        .map_err(|_| anyhow::anyhow!("relay 地址无效"))?;
    let key = generate_key();
    let response = client
        .get(url)
        .header(header::CONNECTION, "Upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_VERSION, "13")
        .header(header::SEC_WEBSOCKET_KEY, &key)
        .send()
        .await?;
    validate_upgrade(&response, &key)?;
    let stream = response.upgrade().await?;
    Ok(WebSocketStream::from_raw_socket(stream, Role::Client, None).await)
}

fn validate_upgrade(response: &Response, key: &str) -> anyhow::Result<()> {
    anyhow::ensure!(
        response.status() == StatusCode::SWITCHING_PROTOCOLS,
        "relay WebSocket 握手返回 HTTP {}",
        response.status().as_u16()
    );
    let headers = response.headers();
    let websocket = headers
        .get(header::UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"));
    let upgrade = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case("upgrade"));
    let accepted = headers
        .get(header::SEC_WEBSOCKET_ACCEPT)
        .is_some_and(|value| value.as_bytes() == derive_accept_key(key.as_bytes()).as_bytes());
    anyhow::ensure!(
        websocket && upgrade && accepted,
        "relay WebSocket 握手响应无效"
    );
    // No extensions or subprotocols were offered. Do not accept unsolicited ones.
    anyhow::ensure!(
        !headers.contains_key(header::SEC_WEBSOCKET_EXTENSIONS)
            && !headers.contains_key(header::SEC_WEBSOCKET_PROTOCOL),
        "relay WebSocket 返回了未请求的扩展或子协议"
    );
    Ok(())
}

#[cfg(test)]
mod tests;
