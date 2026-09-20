use super::*;

#[test]
fn host_tunnel_checks_the_final_mobile_method() {
    for method in [
        "settings.update",
        "daemon.shutdown",
        "workspace.open",
        "workspace.updateRoots",
        "browser.resolve",
        "host.call",
        "host.save",
        "host.remove",
    ] {
        let request: RpcRequest = serde_json::from_value(json!({
            "jsonrpc":"2.0", "id":1, "method":"host.call",
            "params":{"hostId":"saved-server", "method":method, "params":{}}
        }))
        .unwrap();
        assert!(!remote_request_allowed(&request), "allowed {method}");
    }
    for method in [
        "session.open",
        "session.sync",
        "session.sendMessage",
        "session.cancel",
        "approval.resolve",
        "file.read",
        "file.describe",
        "tool.detail",
    ] {
        let request: RpcRequest = serde_json::from_value(json!({
            "jsonrpc":"2.0", "id":1, "method":"host.call",
            "params":{"hostId":"saved-server", "method":method, "params":{}}
        }))
        .unwrap();
        assert!(remote_request_allowed(&request), "denied {method}");
    }
    assert!(!remote_method_allowed("host.save"));
    assert!(!remote_method_allowed("host.remove"));
    assert!(remote_method_allowed("host.connect"));
    assert!(remote_method_allowed("host.list"));
}

#[test]
fn forwarded_tools_defer_large_payloads_without_replacing_the_remote_cursor() {
    let cursor = json!({"epoch":"remote-epoch", "sequence":71});
    for (kind, field) in [
        ("tool_call_started", "input"),
        ("tool_call_finished", "output"),
    ] {
        let mut raw = json!({"type":kind,"sessionId":"same","toolCallId":"tool","eventCursor":cursor,"createdAt":"2026-09-20T00:00:00Z","status":"succeeded"});
        raw[field] = json!({"content":"large tool data".repeat(100_000)});
        let projected =
            project_host_event(json!({"type":"host_event","hostId":"alpha","event":raw})).unwrap();
        assert_eq!(projected["hostId"], "alpha");
        assert_eq!(projected["event"]["eventCursor"], cursor);
        assert_eq!(projected["event"]["payloadDeferred"], true);
        assert!(projected["event"][field].is_null());
        assert_eq!(projected["event"]["createdAt"], "2026-09-20T00:00:00Z");
        assert!(projected.to_string().len() < 512);
    }
    assert!(project_host_event(
        json!({"type":"host_event","hostId":"alpha","event":{"type":"browser_driver_requested"}})
    )
    .is_none());
}

#[tokio::test]
async fn mobile_host_management_denials_do_not_disconnect_the_relay() {
    use super::tests::{next_payload, request, start};
    let (state, mut socket, task) = start().await;
    for (id, method, params) in [
        ("save", "host.save", json!({"hostId":"arbitrary-server"})),
        (
            "nested",
            "host.call",
            json!({"hostId":"server","method":"settings.update","params":{}}),
        ),
    ] {
        request(&mut socket, id, method, params).await;
        let response = next_payload(&mut socket).await;
        assert_eq!(response["id"], id);
        assert!(response.get("error").is_some());
    }
    request(&mut socket, "health", "daemon.health", Value::Null).await;
    assert_eq!(next_payload(&mut socket).await["id"], "health");
    request(&mut socket, "hosts", "host.list", Value::Null).await;
    let response = next_payload(&mut socket).await;
    assert_eq!(response["id"], "hosts");
    assert!(response["result"]["hosts"].is_array());
    state.shutdown.cancel();
    task.await.unwrap().unwrap();
}
