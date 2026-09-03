use miniq_protocol::*;
use serde_json::json;

#[test]
fn request_roundtrip() {
    let raw = json!({
        "jsonrpc": "2.0",
        "id": "req_01",
        "method": "session.sendMessage",
        "params": {"sessionId": "sess_01", "message": {"role": "user", "content": "hi"}}
    });
    let req: RpcRequest = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(req.method, "session.sendMessage");
    assert_eq!(req.id, RequestId::String("req_01".into()));
    let back = serde_json::to_value(&req).unwrap();
    assert_eq!(back, raw);
}

#[test]
fn numeric_request_id() {
    let raw = json!({"jsonrpc": "2.0", "id": 7, "method": "daemon.health"});
    let req: RpcRequest = serde_json::from_value(raw).unwrap();
    assert_eq!(req.id, RequestId::Number(7));
    assert!(req.params.is_none());
}

#[test]
fn response_ok_shape() {
    let resp = RpcResponse::ok("req_01".into(), json!({"ok": true}));
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["jsonrpc"], "2.0");
    assert_eq!(v["result"]["ok"], true);
    assert!(v.get("error").is_none());
}

#[test]
fn response_err_shape() {
    let resp = RpcResponse::err(
        "req_02".into(),
        RpcError::new(ErrorCode::MethodNotFound, "no such method"),
    );
    let v = serde_json::to_value(&resp).unwrap();
    assert_eq!(v["error"]["code"], -32601);
    assert!(v.get("result").is_none());
}

#[test]
fn event_tagged_serialization() {
    let ev = Event::ToolCallStarted {
        session_id: "sess_01".into(),
        tool_call_id: "tool_01".into(),
        tool_name: "shell_run".into(),
        input: json!({"command": "cargo test"}),
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v["type"], "tool_call_started");
    assert_eq!(v["sessionId"], "sess_01");
    assert_eq!(v["toolName"], "shell_run");

    let back: Event = serde_json::from_value(v).unwrap();
    assert_eq!(back.session_id(), "sess_01");
}

#[test]
fn context_compaction_event_uses_camel_case_metrics() {
    let event = Event::ContextCompacted {
        session_id: "sess_01".into(),
        estimated_tokens_before: 120_000,
        estimated_tokens_after: 18_000,
    };
    let value = serde_json::to_value(event).unwrap();

    assert_eq!(value["type"], "context_compacted");
    assert_eq!(value["estimatedTokensBefore"], 120_000);
    assert_eq!(value["estimatedTokensAfter"], 18_000);
}

#[test]
fn turn_progress_event_exposes_phase_step_and_timestamp() {
    let event = Event::TurnProgressChanged {
        session_id: "sess_01".into(),
        progress: TurnProgress {
            phase: TurnPhase::RequestingModel,
            model_step: Some(2),
            started_at: "2026-09-03T02:00:00Z".into(),
        },
    };
    let value = serde_json::to_value(event).unwrap();

    assert_eq!(value["type"], "turn_progress_changed");
    assert_eq!(value["sessionId"], "sess_01");
    assert_eq!(value["progress"]["phase"], "requesting_model");
    assert_eq!(value["progress"]["modelStep"], 2);
    assert_eq!(value["progress"]["startedAt"], "2026-09-03T02:00:00Z");
}

#[test]
fn status_enums_snake_case() {
    assert_eq!(
        serde_json::to_value(SessionStatus::WaitingApproval).unwrap(),
        json!("waiting_approval")
    );
    assert_eq!(
        serde_json::to_value(RiskLevel::Blocked).unwrap(),
        json!("blocked")
    );
    assert_eq!(
        serde_json::to_value(ToolCallStatus::Succeeded).unwrap(),
        json!("succeeded")
    );
}

#[test]
fn risk_level_ordering() {
    assert!(RiskLevel::Low < RiskLevel::Medium);
    assert!(RiskLevel::Medium < RiskLevel::High);
    assert!(RiskLevel::High < RiskLevel::Blocked);
}
