use super::*;
use crate::{ProcessInputTool, ProcessKillTool, ProcessOutputTool, ShellRunTool, Tool};

#[cfg(test)]
#[path = "lifecycle_tests.rs"]
mod lifecycle_tests;

#[path = "regression_tests.rs"]
mod regression_tests;

async fn launch(ctx: &ToolContext, command: &str) -> Value {
    ShellRunTool
        .execute(
            ctx,
            json!({"command":command,"interactive":true,"yieldTimeMs":10}),
        )
        .await
        .unwrap()
}
#[cfg(unix)]
#[tokio::test]
async fn stdin_session_is_incremental_replayable_and_owned() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    let started = launch(&ctx, "printf ready; read answer; printf '\n%s' \"$answer\"").await;
    let id = started["session_id"].as_str().unwrap();
    assert_eq!(started["status"], "running");
    let result = ProcessInputTool
        .execute(&ctx, json!({"id":id,"chars":"你好\n","yieldTimeMs":1000}))
        .await
        .unwrap();
    assert_eq!(result["status"], "completed");
    assert!(result["stdout"].as_str().unwrap().contains("你好"));
    let empty = ProcessInputTool
        .execute(&ctx, json!({"id":id,"chars":"","yieldTimeMs":0}))
        .await
        .unwrap();
    assert_eq!(empty["stdout"], "");
    let replay = ProcessOutputTool
        .execute(&ctx, json!({"id":id,"stdoutOffset":0,"stderrOffset":0}))
        .await
        .unwrap();
    assert_eq!(replay["stdout"], "ready\n你好");
    let other = ToolContext::new(dir.path().into()).with_processes(ctx.processes.clone());
    assert!(ProcessOutputTool
        .execute(&other, json!({"id":id}))
        .await
        .is_err());
    assert!(ProcessInputTool
        .execute(&other, json!({"id":id,"chars":"bad"}))
        .await
        .is_err());
    assert!(ProcessKillTool
        .execute(&other, json!({"id":id}))
        .await
        .is_err());
}
#[cfg(unix)]
#[tokio::test]
async fn pages_recover_large_output_and_timeout_keeps_partial_output() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    let mut result = ShellRunTool
        .execute(
            &ctx,
            json!({"command":"printf 1234567890","maxOutputTokens":1}),
        )
        .await
        .unwrap();
    let id = result["session_id"].as_str().unwrap().to_owned();
    let mut all = result["stdout"].as_str().unwrap().to_owned();
    while result["hasMore"] == true {
        result = ProcessOutputTool
            .execute(&ctx, json!({"id":id,"maxOutputTokens":1}))
            .await
            .unwrap();
        all.push_str(result["stdout"].as_str().unwrap());
    }
    assert_eq!(all, "1234567890");
    let timed = ShellRunTool
        .execute(
            &ctx,
            json!({"command":"printf partial; sleep 30", "timeoutSecs":1}),
        )
        .await
        .unwrap();
    assert_eq!(timed["timedOut"], true);
    assert_eq!(timed["stdout"], "partial");
}
#[cfg(unix)]
#[tokio::test]
async fn pty_accepts_input_resizes_and_finishes() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    let started = ShellRunTool.execute(&ctx, json!({"command":"test -t 0 && echo terminal; read value; echo got:$value", "tty":true,"yieldTimeMs":100})).await.unwrap();
    let id = started["session_id"].as_str().unwrap();
    assert!(started["stdout"].as_str().unwrap().contains("terminal"));
    ProcessResizeTool
        .execute(&ctx, json!({"id":id,"rows":40,"cols":120}))
        .await
        .unwrap();
    let result = ProcessInputTool
        .execute(&ctx, json!({"id":id,"chars":"hello\n","yieldTimeMs":1000}))
        .await
        .unwrap();
    assert_eq!(result["status"], "completed");
    assert!(result["stdout"].as_str().unwrap().contains("got:hello"));
}
#[tokio::test]
async fn validation_and_input_risk_are_not_silent_fallbacks() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    assert_eq!(
        ProcessInputTool
            .evaluate_risk(&ctx, &json!({"id":"x","chars":"rm -rf foo\n"}))
            .level,
        miniq_protocol::RiskLevel::High
    );
    assert_eq!(
        ProcessInputTool
            .evaluate_risk(&ctx, &json!({"id":"x"}))
            .level,
        miniq_protocol::RiskLevel::Low
    );
    assert!(ProcessInputTool
        .execute(&ctx, json!({"id":"x","yieldTimeMs":600001}))
        .await
        .is_err());
    assert!(ShellRunTool
        .execute(&ctx, json!({"command":"echo x","maxOutputTokens":0}))
        .await
        .is_err());
}
