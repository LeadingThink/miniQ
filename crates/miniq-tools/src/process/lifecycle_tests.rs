use super::super::*;
use crate::{ProcessInputTool, ProcessKillTool, ProcessOutputTool, ShellRunTool, Tool};

#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    unsafe { libc::killpg(pid as i32, 0) == 0 }
}

#[cfg(unix)]
#[tokio::test]
async fn kill_stops_descendants_and_keeps_output_replay() {
    let ctx = ToolContext::new(std::env::temp_dir());
    let job = ShellRunTool
        .execute(
            &ctx,
            json!({"command":"printf ready; sleep 30 & wait","yieldTimeMs":50}),
        )
        .await
        .unwrap();
    let id = job["session_id"].as_str().unwrap();
    let pid = job["pid"].as_u64().unwrap() as u32;
    let stopped = tokio::time::timeout(
        Duration::from_secs(3),
        ProcessKillTool.execute(&ctx, json!({"id":id})),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(stopped["status"], "killed");
    let end = Instant::now() + Duration::from_secs(2);
    while group_alive(pid) && Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!group_alive(pid));
    let replay = ProcessOutputTool
        .execute(&ctx, json!({"id":id,"stdoutOffset":0}))
        .await
        .unwrap();
    assert_eq!(replay["stdout"], "ready");
}
#[cfg(unix)]
#[tokio::test]
async fn shell_exit_does_not_wait_forever_for_descendant_pipes_and_cancel_stops_them() {
    let ctx = ToolContext::new(std::env::temp_dir());
    let job = tokio::time::timeout(
        Duration::from_secs(3),
        ShellRunTool.execute(
            &ctx,
            json!({"command":"printf done; sleep 30 &","yieldTimeMs":1000}),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(job["status"], "completed");
    assert_eq!(job["stdout"], "done");
    let pid = job["pid"].as_u64().unwrap() as u32;
    ctx.cancellation.cancel();
    let end = Instant::now() + Duration::from_secs(3);
    while group_alive(pid) && Instant::now() < end {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(!group_alive(pid));
}
#[cfg(unix)]
#[tokio::test]
async fn blocked_wait_does_not_prevent_another_call_from_writing_and_eof_works() {
    let ctx = ToolContext::new(std::env::temp_dir());
    let job = ShellRunTool
        .execute(
            &ctx,
            json!({"command":"cat","interactive":true,"yieldTimeMs":0}),
        )
        .await
        .unwrap();
    let id = job["session_id"].as_str().unwrap().to_owned();
    let other = ctx.clone();
    let target = id.clone();
    let wait = tokio::spawn(async move {
        ProcessOutputTool
            .execute(&other, json!({"id":target,"yieldTimeMs":5000}))
            .await
    });
    let written = tokio::time::timeout(
        Duration::from_secs(2),
        ProcessInputTool.execute(
            &ctx,
            json!({"id":id,"chars":"payload","eof":true,"yieldTimeMs":1000}),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    let read = wait.await.unwrap().unwrap();
    assert_eq!(
        format!(
            "{}{}",
            read["stdout"].as_str().unwrap(),
            written["stdout"].as_str().unwrap()
        ),
        "payload"
    );
    assert_eq!(written["status"], "completed");
}
#[cfg(unix)]
#[tokio::test]
async fn cancelled_input_cannot_execute_more_commands() {
    let ctx = ToolContext::new(std::env::temp_dir());
    let job = ShellRunTool
        .execute(
            &ctx,
            json!({"command":"cat","interactive":true,"yieldTimeMs":0}),
        )
        .await
        .unwrap();
    ctx.cancellation.cancel();
    assert!(ProcessInputTool
        .execute(&ctx, json!({"id":job["session_id"],"chars":"payload"}))
        .await
        .is_err());
}
