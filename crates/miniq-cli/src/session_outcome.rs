//! Durable outcomes remain meaningful after the transient failed badge is read.

use serde_json::Value;

pub fn failure(snapshot: &Value) -> Option<&str> {
    let outcome = &snapshot["lastTurn"];
    if outcome["status"] != "failed" && snapshot["session"]["status"] != "failed" {
        return None;
    }
    match outcome["error"].as_str() {
        Some("cancelled") => None,
        Some(reason) if !reason.is_empty() => Some(reason),
        _ => Some("This older record did not save a specific failure reason."),
    }
}

pub fn paused(snapshot: &Value) -> bool {
    snapshot["session"]["status"] == "idle" && snapshot["lastTurn"]["status"] == "paused"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acknowledged_failures_keep_the_complete_reason() {
        let reason = "完整失败详情".repeat(1000);
        let snapshot =
            json!({"session":{"status":"idle"},"lastTurn":{"status":"failed","error":reason}});
        assert_eq!(failure(&snapshot), Some(reason.as_str()));
        assert!(!paused(&snapshot));
        assert!(failure(&json!({"session":{"status":"idle"},"lastTurn":{"status":"cancelled","error":"cancelled"}})).is_none());
        assert!(paused(
            &json!({"session":{"status":"idle"},"lastTurn":{"status":"paused"}})
        ));
    }
}
