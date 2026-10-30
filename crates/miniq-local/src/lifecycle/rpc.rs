use crate::ConnectionInfo;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{io, time::Duration};
use tokio_tungstenite::tungstenite::{Error, Message};

pub(super) async fn call(
    info: &ConnectionInfo,
    method: &str,
    timeout: Duration,
) -> io::Result<Value> {
    tokio::time::timeout(timeout, exchange(info, method))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, format!("后台 {method} 请求超时")))?
}

async fn exchange(info: &ConnectionInfo, method: &str) -> io::Result<Value> {
    let mut url =
        url::Url::parse(&format!("ws://127.0.0.1:{}/ws", info.port)).map_err(io::Error::other)?;
    url.query_pairs_mut().append_pair("token", &info.token);
    let (mut socket, _) = tokio_tungstenite::connect_async(url.as_str()).await.map_err(|error| {
        // Transport errors can contain the authenticated URL. Never return it.
        let rejected = matches!(&error, Error::Http(response) if matches!(response.status().as_u16(), 401 | 403));
        if rejected { io::Error::new(io::ErrorKind::PermissionDenied, "后台认证失败，请检查连接记录或重新启动 miniQ") }
        else { io::Error::new(io::ErrorKind::ConnectionRefused, "无法连接 miniQ 后台") }
    })?;
    socket
        .send(Message::text(
            json!({"jsonrpc":"2.0","id":"lifecycle","method":method}).to_string(),
        ))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::ConnectionReset, "无法发送后台请求"))?;
    while let Some(message) = socket.next().await {
        let message = message
            .map_err(|_| io::Error::new(io::ErrorKind::ConnectionReset, "后台连接已中断"))?;
        let Message::Text(text) = message else {
            continue;
        };
        let response: Value = serde_json::from_str(&text)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "后台返回了无效响应"))?;
        if response["id"] != "lifecycle" {
            continue;
        }
        if response.get("error").is_some() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("后台拒绝 {method} 请求"),
            ));
        }
        return response
            .get("result")
            .cloned()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "后台响应缺少结果"));
    }
    Err(io::Error::new(
        io::ErrorKind::ConnectionReset,
        "后台在确认请求前断开连接",
    ))
}

pub async fn probe(info: &ConnectionInfo, timeout: Duration) -> io::Result<()> {
    let response = call(info, "daemon.health", timeout).await?;
    if response["protocolVersion"] != miniq_protocol::PROTOCOL_VERSION
        || !response["daemonVersion"].is_string()
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "后台协议不匹配，请同时更新 miniQ 客户端与后台",
        ));
    }
    Ok(())
}
