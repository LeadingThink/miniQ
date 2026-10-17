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

#[cfg(unix)]
#[tokio::test]
async fn detached_terminal_is_interactive_resizable_and_owner_scoped() {
    let manager = ProcessManager::default();
    let dir = tempfile::tempdir().unwrap();
    let launch = TerminalLaunch {
        command: "printf ready; read value; echo got:$value".into(),
        cwd: dir.path().into(),
        rows: 24,
        cols: 80,
    };
    let id = manager.terminal_start("session-a", launch).await.unwrap();
    manager
        .terminal_resize("session-a", dir.path().into(), &id, 40, 120)
        .await
        .unwrap();
    assert!(manager
        .terminal_input("session-b", dir.path().into(), &id, "blocked\n".into(),)
        .await
        .is_err());
    manager
        .terminal_input("session-a", dir.path().into(), &id, "hello\n".into())
        .await
        .unwrap();
    let mut offset = 0;
    let mut transcript = String::new();
    loop {
        let output = manager
            .terminal_output(
                "session-a",
                dir.path().into(),
                &id,
                TerminalOutputRequest {
                    stdout_offset: Some(offset),
                    max_bytes: 4096,
                    wait: Duration::from_secs(1),
                },
            )
            .await
            .unwrap();
        transcript.push_str(output["stdout"].as_str().unwrap());
        offset = output["stdoutPage"]["nextOffset"].as_u64().unwrap();
        if output["status"] != "running" {
            assert_eq!(output["status"], "completed");
            break;
        }
    }
    assert!(transcript.contains("got:hello"));
}

#[cfg(unix)]
#[tokio::test]
async fn detached_terminal_output_returns_without_waiting_when_data_is_ready() {
    let manager = ProcessManager::default();
    let dir = tempfile::tempdir().unwrap();
    let id = manager
        .terminal_start(
            "session-a",
            TerminalLaunch {
                command: "printf ready; sleep 2".into(),
                cwd: dir.path().into(),
                rows: 24,
                cols: 80,
            },
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let started = Instant::now();
    let output = manager
        .terminal_output(
            "session-a",
            dir.path().into(),
            &id,
            TerminalOutputRequest {
                stdout_offset: Some(0),
                max_bytes: 4096,
                wait: Duration::from_secs(1),
            },
        )
        .await
        .unwrap();
    assert!(output["stdout"].as_str().unwrap().contains("ready"));
    assert!(started.elapsed() < Duration::from_millis(250));
    manager
        .terminal_close("session-a", dir.path().into(), &id)
        .await
        .unwrap();
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
