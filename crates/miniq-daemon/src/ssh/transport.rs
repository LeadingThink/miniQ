//! Correlated JSON-RPC over one SSH process. Disconnects never replay a request.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use miniq_protocol::{ErrorCode, RpcError, RpcRequest};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use super::process::{Bridge, MAX_FRAME_BYTES};
use super::{failed, invalid};

type Reply = Result<Value, RpcError>;
type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Reply>>>>;
const MAX_PENDING: usize = 128;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const INTERRUPTED: &str = "SSH 连接已中断；远程任务可能仍在运行，请重新连接查看。请求未自动重发";

pub(super) struct Connection {
    input: mpsc::Sender<(String, Vec<u8>)>,
    pending: Pending,
    pub cancel: CancellationToken,
}

impl Connection {
    pub fn start(
        bridge: Bridge,
        host: String,
        events: broadcast::Sender<Value>,
        cancel: CancellationToken,
    ) -> (Arc<Self>, oneshot::Receiver<String>) {
        let (input, receiver) = mpsc::channel(16);
        let (ended, completion) = oneshot::channel();
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let connection = Arc::new(Self {
            input,
            pending: pending.clone(),
            cancel: cancel.clone(),
        });
        tokio::spawn(async move {
            let error = run(bridge, receiver, &pending, &cancel, &host, &events).await;
            cancel.cancel();
            for (_, sender) in pending.lock().unwrap().drain() {
                let _ = sender.send(Err(failed(INTERRUPTED)));
            }
            let _ = ended.send(error);
        });
        (connection, completion)
    }

    pub async fn call(&self, method: &str, params: Option<Value>) -> Reply {
        if self.cancel.is_cancelled() {
            return Err(failed(INTERRUPTED));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let request = RpcRequest::new(id.clone(), method, params);
        let mut line = serde_json::to_vec(&request).map_err(|error| invalid(error.to_string()))?;
        if line.len() > MAX_FRAME_BYTES {
            return Err(invalid("SSH 请求超过 16 MiB，请使用分页或分块传输"));
        }
        line.push(b'\n');
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if pending.len() >= MAX_PENDING {
                return Err(RpcError::new(
                    ErrorCode::SessionBusy,
                    "该 SSH 主机请求过多，请稍后重试",
                ));
            }
            pending.insert(id.clone(), sender);
        }
        // Dropping a caller only stops waiting for its response; it never cancels a task.
        let _pending = PendingRequest {
            id: id.clone(),
            pending: self.pending.clone(),
        };
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            tokio::select! {
                _ = self.cancel.cancelled() => return Err(failed(INTERRUPTED)),
                result = self.input.send((id, line)) => result.map_err(|_| failed(INTERRUPTED))?,
            }
            tokio::select! {
                _ = self.cancel.cancelled() => Err(failed(INTERRUPTED)),
                result = receiver => result.unwrap_or_else(|_| Err(failed(INTERRUPTED))),
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(failed(
                "SSH 请求等待超时；远程任务可能仍在运行，请刷新状态。请求未自动重发",
            ))
        })
    }
}

struct PendingRequest {
    id: String,
    pending: Pending,
}
impl Drop for PendingRequest {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.id);
    }
}

struct Writer(tokio::task::JoinHandle<()>);
impl Drop for Writer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

async fn run(
    mut bridge: Bridge,
    mut requests: mpsc::Receiver<(String, Vec<u8>)>,
    pending: &Pending,
    cancel: &CancellationToken,
    host: &str,
    events: &broadcast::Sender<Value>,
) -> String {
    let mut input = bridge.input.take().expect("SSH stdin");
    let writer_pending = pending.clone();
    let writer_cancel = cancel.clone();
    // Independent reader and writer prevent pipe backpressure from deadlocking large responses.
    let mut writer = Writer(tokio::spawn(async move {
        while let Some((id, bytes)) = requests.recv().await {
            if !writer_pending.lock().unwrap().contains_key(&id) {
                continue;
            }
            tokio::select! {
                _ = writer_cancel.cancelled() => break,
                result = input.write_all(&bytes) => if result.is_err() { break; },
            }
        }
    }));
    let error = loop {
        tokio::select! {
            _ = cancel.cancelled() => break "SSH 连接已断开".into(),
            _ = &mut writer.0 => break INTERRUPTED.into(),
            line = bridge.output.next() => {
                let line = match line {
                    Ok(Some(line)) => line,
                    Ok(None) => break INTERRUPTED.into(),
                    Err(error) => break error,
                };
                if let Err(error) = receive(&line, pending, host, events) { break error; }
            }
        }
    };
    let _ = bridge.child.kill().await;
    error
}

fn receive(
    line: &str,
    pending: &Pending,
    host: &str,
    events: &broadcast::Sender<Value>,
) -> Result<(), String> {
    let value: Value = serde_json::from_str(line).map_err(|_| "SSH 返回了无效 JSON 数据")?;
    if !value.is_object() {
        return Err("SSH 数据必须是 JSON 对象".into());
    }
    if let Some(id) = value.get("id") {
        let id = id.as_str().ok_or("SSH 响应请求标识无效")?;
        if value["jsonrpc"] != "2.0" {
            return Err("SSH 响应协议无效".into());
        }
        let result = match (value.get("result"), value.get("error")) {
            (Some(result), None) => Ok(result.clone()),
            (None, Some(error)) => {
                Err(serde_json::from_value(error.clone()).map_err(|_| "SSH 错误响应格式无效")?)
            }
            _ => return Err("SSH 响应必须包含唯一的结果或错误".into()),
        };
        if let Some(sender) = pending.lock().unwrap().remove(id) {
            let _ = sender.send(result);
        }
    } else {
        if value["type"].as_str().is_none_or(str::is_empty) {
            return Err("SSH 事件格式无效".into());
        }
        let _ = events.send(json!({"type": "host_event", "hostId": host, "event": value}));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn null_results_errors_and_stale_replies_are_routed_without_wrapping() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(4);
        let (sender, receiver) = oneshot::channel();
        pending.lock().unwrap().insert("current".into(), sender);
        receive(
            r#"{"jsonrpc":"2.0","id":"stale","result":"old"}"#,
            &pending,
            "one",
            &events,
        )
        .unwrap();
        assert!(pending.lock().unwrap().contains_key("current"));
        receive(
            r#"{"jsonrpc":"2.0","id":"current","result":null}"#,
            &pending,
            "one",
            &events,
        )
        .unwrap();
        assert_eq!(receiver.await.unwrap().unwrap(), Value::Null);
        let (sender, receiver) = oneshot::channel();
        pending.lock().unwrap().insert("error".into(), sender);
        receive(r#"{"jsonrpc":"2.0","id":"error","error":{"code":-32100,"message":"remote reason","data":{"retry":false}}}"#, &pending, "one", &events).unwrap();
        let error = receiver.await.unwrap().unwrap_err();
        assert_eq!(error.code, -32100);
        assert_eq!(error.message, "remote reason");
        assert_eq!(error.data.unwrap(), json!({"retry":false}));
    }

    #[test]
    fn malformed_responses_and_events_are_rejected() {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events, _) = broadcast::channel(4);
        for line in [
            "[]",
            "{",
            "{}",
            r#"{"jsonrpc":"2.0","id":3,"result":true}"#,
            r#"{"jsonrpc":"2.0","id":"a","error":null}"#,
            r#"{"jsonrpc":"2.0","id":"a","result":1,"error":{}}"#,
        ] {
            assert!(receive(line, &pending, "one", &events).is_err(), "{line}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn unanswered_request_times_out_without_cancelling_the_connection_or_replaying() {
        let (input, mut requests) = mpsc::channel(2);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let connection = Arc::new(Connection {
            input,
            pending: pending.clone(),
            cancel: CancellationToken::new(),
        });
        let client = connection.clone();
        let call = tokio::spawn(async move { client.call("session.sendMessage", None).await });
        let _sent = requests.recv().await.unwrap();
        tokio::time::advance(REQUEST_TIMEOUT).await;
        assert!(call
            .await
            .unwrap()
            .unwrap_err()
            .message
            .contains("未自动重发"));
        assert!(pending.lock().unwrap().is_empty());
        assert!(!connection.cancel.is_cancelled());
        assert!(requests.try_recv().is_err());
    }
}
