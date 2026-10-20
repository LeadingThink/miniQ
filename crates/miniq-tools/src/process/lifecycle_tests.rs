use super::super::*;
use crate::{ProcessInputTool, ProcessKillTool, ProcessOutputTool, ShellRunTool, Tool};

async fn wait_for_released_handles(process: &ManagedProcess) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if matches!(process.runtime.lock().await.child, ProcessChild::Exited)
                && process.stdout.lock().unwrap().closed
                && process.stderr.lock().unwrap().closed
            {
                assert!(process.input.lock().await.is_none());
                assert!(process.stdout.lock().unwrap().closed);
                assert!(process.stderr.lock().unwrap().closed);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("background monitor must release handles without output polling");
}

#[cfg(windows)]
#[tokio::test]
async fn windows_completed_jobs_close_transports_and_drain_output_without_polling() {
    for tty in [false, true] {
        eprintln!("starting tty={tty}");
        let ctx = ToolContext::new(std::env::temp_dir());
        let id = ctx
            .processes
            .start(
                &ctx,
                Launch {
                    command: "[Console]::Write(('x' * 262144)); [Console]::Write('retained-tail')"
                        .into(),
                    cwd: ctx.workspace.clone(),
                    env: BTreeMap::new(),
                    interactive: true,
                    tty,
                    rows: 24,
                    cols: 80,
                },
            )
            .await
            .unwrap();
        let process = ctx.processes.owned(&ctx, &id).await.unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let runtime = process.runtime.lock().await;
            let child = match runtime.child {
                ProcessChild::Pipe(_) => "pipe",
                ProcessChild::Terminal(_) => "terminal",
                ProcessChild::Exited => "exited",
            };
            let mut stdout = process.stdout.lock().unwrap();
            let mut stderr = process.stderr.lock().unwrap();
            eprintln!("tty={tty} child={child} exit={:?} stdout_len={} stdout_closed={} stdout_error={:?} stderr_len={} stderr_closed={} stderr_error={:?}", runtime.exit_code, stdout.len, stdout.closed, stdout.error, stderr.len, stderr.closed, stderr.error);
            if child == "exited" && stdout.closed && stderr.closed {
                break;
            }
            if Instant::now() >= deadline {
                use base64::Engine;
                std::fs::create_dir_all("artifacts/conpty-diagnostics").unwrap();
                for (name, stream) in [("stdout", &mut stdout), ("stderr", &mut stderr)] {
                    let len = stream.len as usize;
                    let page = stream.page(0, len, true).unwrap();
                    let bytes = base64::engine::general_purpose::STANDARD.decode(page["base64"].as_str().unwrap()).unwrap();
                    std::fs::write(format!("artifacts/conpty-diagnostics/tty-{tty}-{name}.bin"), bytes).unwrap();
                }
                panic!("tty={tty}: managed process did not finish without terminal responses");
            }
            drop(stdout);
            drop(stderr);
            drop(runtime);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let replay = ctx
            .processes
            .output(
                &ctx,
                &id,
                Duration::ZERO,
                PageRequest {
                    stdout_offset: Some(0),
                    max_bytes: 1_048_576,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let text = replay["stdout"].as_str().unwrap();
        assert!(text.len() >= 262144, "tty={tty}, bytes={}", text.len());
        assert!(text.contains("retained-tail"), "tty={tty}");
        assert_eq!(replay["status"], "completed");
        assert_eq!(replay["outputPending"], false);
        assert_eq!(replay["hasMore"], false);
        assert_eq!(replay["ok"], true, "{replay}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn cancelled_jobs_release_handles_without_output_polling() {
    for tty in [false, true] {
        let ctx = ToolContext::new(std::env::temp_dir());
        let job = ShellRunTool
            .execute(
                &ctx,
                json!({"command":"printf retained; sleep 30","interactive":true,"tty":tty,"yieldTimeMs":50}),
            )
            .await
            .unwrap();
        let id = job["session_id"].as_str().unwrap();
        let process = ctx.processes.owned(&ctx, id).await.unwrap();
        ctx.cancellation.cancel();
        wait_for_released_handles(&process).await;
        let replay = ProcessOutputTool
            .execute(&ctx, json!({"id":id,"stdoutOffset":0,"stderrOffset":0}))
            .await
            .unwrap();
        assert_eq!(replay["stdout"], "retained");
        assert_eq!(replay["status"], "killed");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn exit_refresh_does_not_wait_for_an_in_progress_stdin_write() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ToolContext::new(dir.path().into());
    let job = ShellRunTool
        .execute(
            &ctx,
            json!({"command":"while [ ! -e release ]; do sleep 0.02; done; printf retained","interactive":true,"yieldTimeMs":0}),
        )
        .await
        .unwrap();
    let process = ctx
        .processes
        .owned(&ctx, job["session_id"].as_str().unwrap())
        .await
        .unwrap();
    // A pending stdin write owns this lock while the child can exit independently.
    let input = process.input.lock().await;
    std::fs::write(dir.path().join("release"), b"").unwrap();
    let refreshed = tokio::time::timeout(Duration::from_secs(1), async {
        while refresh(&process).await.unwrap() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
    drop(input);
    refreshed.expect("exit refresh must not wait on a pending stdin write");
    wait_for_released_handles(&process).await;
}

#[cfg(unix)]
#[tokio::test]
async fn completed_jobs_release_process_handles_and_keep_output_replay() {
    let ctx = ToolContext::new(std::env::temp_dir());
    for tty in [false, true] {
        let job = ShellRunTool
            .execute(
                &ctx,
                json!({"command":"printf retained","interactive":true,"tty":tty,"yieldTimeMs":1000}),
            )
            .await
            .unwrap();
        assert_eq!(job["status"], "completed");
        assert_eq!(job["outputPending"], false);
        let id = job["session_id"].as_str().unwrap();
        let process = ctx.processes.owned(&ctx, id).await.unwrap();
        assert!(process.input.lock().await.is_none());
        assert!(matches!(
            process.runtime.lock().await.child,
            ProcessChild::Exited
        ));
        let replay = ProcessOutputTool
            .execute(&ctx, json!({"id":id,"stdoutOffset":0,"stderrOffset":0}))
            .await
            .unwrap();
        assert_eq!(replay["stdout"], "retained");
        assert_eq!(replay["status"], "completed");
    }
}

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

#[cfg(unix)]
async fn replay_bytes(ctx: &ToolContext, id: &str, page_size: usize) -> (Vec<u8>, Vec<u8>) {
    use base64::Engine;
    let mut streams = [Vec::new(), Vec::new()];
    loop {
        let page = ctx
            .processes
            .output(
                ctx,
                id,
                Duration::ZERO,
                PageRequest {
                    stdout_offset: Some(streams[0].len() as u64),
                    stderr_offset: Some(streams[1].len() as u64),
                    max_bytes: page_size,
                    raw: true,
                },
            )
            .await
            .unwrap();
        assert_eq!(page["outputPending"], false);
        for (stream, key) in streams.iter_mut().zip(["stdoutPage", "stderrPage"]) {
            assert!(page[key]["error"].is_null(), "{page}");
            stream.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(page[key]["base64"].as_str().unwrap())
                    .unwrap(),
            );
            assert_eq!(page[key]["nextOffset"], stream.len() as u64);
            if page[key]["hasMore"] == false {
                assert_eq!(page[key]["totalBytes"], stream.len() as u64);
            }
        }
        if page["hasMore"] == false {
            let [stdout, stderr] = streams;
            return (stdout, stderr);
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn descendant_output_drains_after_leader_exit_before_handles_are_released() {
    for tty in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ToolContext::new(dir.path().into());
        // macOS closes a controlling PTY when its leader exits. Keep that
        // leader alive for the PTY case; inherited pipes can outlive theirs.
        let command = format!("trap '' HUP; printf parent; (while [ ! -e release ]; do sleep 0.02; done; printf late; printf error >&2) &{}", if tty { " wait" } else { "" });
        let job = ShellRunTool
            .execute(
                &ctx,
                json!({"command":command,"interactive":true,"tty":tty,"yieldTimeMs":1000}),
            )
            .await
            .unwrap();
        assert_eq!(job["status"], if tty { "running" } else { "completed" });
        assert_eq!(job["outputPending"], true, "tty={tty}, job={job}");
        let id = job["session_id"].as_str().unwrap();
        let process = ctx.processes.owned(&ctx, id).await.unwrap();
        assert!(!matches!(
            process.runtime.lock().await.child,
            ProcessChild::Exited
        ));
        std::fs::write(dir.path().join("release"), b"").unwrap();
        wait_for_released_handles(&process).await;
        let (stdout, stderr) = replay_bytes(&ctx, id, 4).await;
        if tty {
            assert_eq!(stdout, b"parentlateerror");
            assert!(stderr.is_empty());
        } else {
            assert_eq!(stdout, b"parentlate");
            assert_eq!(stderr, b"error");
        }
    }
}

#[cfg(unix)]
#[tokio::test]
async fn large_pipe_and_pty_output_is_fully_replayable_after_release() {
    for tty in [false, true] {
        let ctx = ToolContext::new(std::env::temp_dir());
        let job = ShellRunTool
            .execute(
                &ctx,
                json!({"command":"head -c 262144 /dev/zero; printf tail; head -c 131072 /dev/zero >&2; printf error >&2","interactive":true,"tty":tty,"yieldTimeMs":1000,"maxOutputTokens":1}),
            )
            .await
            .unwrap();
        let id = job["session_id"].as_str().unwrap();
        let process = ctx.processes.owned(&ctx, id).await.unwrap();
        wait_for_released_handles(&process).await;
        let mut stdout = vec![0; 262144];
        stdout.extend(b"tail");
        let mut stderr = vec![0; 131072];
        stderr.extend(b"error");
        if tty {
            stdout.append(&mut stderr);
        }
        assert_eq!(replay_bytes(&ctx, id, 4093).await, (stdout, stderr));
    }
}

#[cfg(unix)]
#[test]
fn completed_jobs_stay_within_low_fd_limit_and_replay_all_archives() {
    use std::os::unix::process::CommandExt;
    const CHILD: &str = "MINIQ_PROCESS_LOW_FD_CHILD";
    const FD_LIMIT: libc::rlim_t = 64;
    if std::env::var_os(CHILD).is_none() {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "process::tests::lifecycle_tests::completed_jobs_stay_within_low_fd_limit_and_replay_all_archives",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(CHILD, "1");
        // Limit only the isolated test executable, never the test runner or daemon.
        unsafe {
            command.pre_exec(|| {
                let limit = libc::rlimit {
                    rlim_cur: FD_LIMIT,
                    rlim_max: FD_LIMIT,
                };
                if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let output = command.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stdout}\n{stderr}");
        eprintln!("{stdout}{stderr}");
        return;
    }
    let open_fds = || {
        (0..FD_LIMIT as i32)
            .filter(|&fd| unsafe { libc::fcntl(fd, libc::F_GETFD) != -1 })
            .count()
    };
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            let ctx = ToolContext::new(std::env::temp_dir());
            let baseline = open_fds();
            let mut peak = baseline;
            let mut archives = Vec::new();
            for wave in 0..3 {
                for tty in [false, true] {
                    for index in 0..32 {
                        let text = format!("job-{wave}-{tty}-{index}:中文");
                        let id = ctx.processes.start(&ctx, Launch {
                            command: format!("printf '{text}'; printf ':err' >&2"),
                            cwd: ctx.workspace.clone(), env: BTreeMap::new(),
                            interactive: true, tty, rows: 24, cols: 80,
                        }).await.unwrap();
                        let process = ctx.processes.owned(&ctx, &id).await.unwrap();
                        wait_for_released_handles(&process).await;
                        let mut stdout = text.into_bytes();
                        let mut stderr = b":err".to_vec();
                        if tty { stdout.append(&mut stderr); }
                        archives.push((id, (stdout, stderr)));
                        peak = peak.max(open_fds());
                        assert!(peak <= baseline + 4, "FDs grew: baseline={baseline}, peak={peak}");
                    }
                }
                eprintln!("low-fd wave={} retained_jobs={} open_fds={}", wave + 1, archives.len(), open_fds());
            }
            assert_eq!(ctx.processes.processes.lock().await.len(), 192);
            // Reopen every old archive twice while all process records stay alive.
            for _ in 0..2 {
                for (id, expected) in &archives {
                    assert_eq!(&replay_bytes(&ctx, id, 4).await, expected);
                }
                assert!(open_fds() <= baseline + 4);
            }
            eprintln!("low-fd limit={FD_LIMIT} baseline={baseline} peak_after_release={peak} final={} jobs=192 archives=384 complete_replays=384", open_fds());
        });
}
