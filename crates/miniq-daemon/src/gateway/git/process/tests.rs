use super::*;

#[cfg(unix)]
fn sleeping_command(marker: &std::path::Path) -> Command {
    let mut command = Command::new("sh");
    command.args(["-c", "printf '%s' \"$$\" > \"$1\"; exec sleep 30", "sh"]);
    command.arg(marker);
    command
}

#[cfg(windows)]
fn sleeping_command(marker: &std::path::Path) -> Command {
    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-NonInteractive", "-Command",
            "[IO.File]::WriteAllText($env:MINIQ_GIT_TEST_PID_FILE, [string]$PID); Start-Sleep -Seconds 30"])
        .env("MINIQ_GIT_TEST_PID_FILE", marker)
        .creation_flags(0x08000000);
    command
}

#[cfg(unix)]
fn process_exists(pid: &str) -> bool {
    std::process::Command::new("kill")
        .args(["-0", pid])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap()
        .success()
}

#[cfg(windows)]
fn process_exists(pid: &str) -> bool {
    use std::os::windows::process::CommandExt;
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout).contains(&format!("\"{pid}\""))
}

fn execution_timeout() -> Duration {
    // Windows PowerShell startup must complete before exercising the timeout.
    Duration::from_secs(if cfg!(windows) { 5 } else { 1 })
}

#[tokio::test]
async fn bounds_all_requests_and_reaps_cancelled_children_before_releasing_slots() {
    let directory = tempfile::tempdir().unwrap();
    let executor = Arc::new(Executor {
        slots: Arc::new(Semaphore::new(2)),
        timeout: Duration::from_secs(10),
    });
    let mut requests = Vec::new();
    for number in 0..20 {
        let executor = executor.clone();
        let command = sleeping_command(&directory.path().join(format!("pid-{number}")));
        requests.push(tokio::spawn(async move {
            executor.run(command, Vec::new(), None).await
        }));
    }
    tokio::time::timeout(Duration::from_secs(5), async {
        while std::fs::read_dir(directory.path()).unwrap().count() < 2 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    assert_eq!(executor.slots.available_permits(), 0);
    let pids = std::fs::read_dir(directory.path())
        .unwrap()
        .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
        .collect::<Vec<_>>();
    for request in &requests {
        request.abort();
    }
    for request in requests {
        let _ = request.await;
    }
    let _permits = tokio::time::timeout(
        Duration::from_secs(5),
        executor.slots.clone().acquire_many_owned(2),
    )
    .await
    .unwrap()
    .unwrap();
    for pid in pids {
        assert!(
            !process_exists(&pid),
            "cancelled Git child {pid} was not reaped"
        );
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[tokio::test]
async fn timeout_kills_and_reaps_child_and_keeps_executor_usable() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("pid");
    let mut executor = Executor {
        slots: Arc::new(Semaphore::new(1)),
        timeout: execution_timeout(),
    };
    let error = executor
        .run(sleeping_command(&marker), Vec::new(), None)
        .await
        .unwrap_err();
    assert_eq!(error.message, "git command timed out");
    let pid = std::fs::read_to_string(marker).unwrap();
    assert!(
        !process_exists(&pid),
        "timed-out Git child {pid} was not reaped"
    );
    assert_eq!(executor.slots.available_permits(), 1);
    executor.timeout = Duration::from_secs(5);
    let mut command = Command::new("git");
    command.arg("--version");
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    assert!(executor
        .run(command, Vec::new(), None)
        .await
        .unwrap()
        .stdout
        .starts_with(b"git version "));
}

#[tokio::test]
async fn deadline_includes_time_queued_without_spawning_a_child() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("pid");
    let executor = Executor {
        slots: Arc::new(Semaphore::new(1)),
        timeout: Duration::from_millis(50),
    };
    let _permit = executor.slots.acquire().await.unwrap();
    let error = executor
        .run(sleeping_command(&marker), Vec::new(), None)
        .await
        .unwrap_err();
    assert!(error.message.contains("waiting for a process slot"));
    assert!(!marker.exists());
}

fn filtered_diff(directory: &std::path::Path, marker: &std::path::Path) -> Command {
    #[cfg(unix)]
    let filter =
        "sh -c 'sleep 30 & printf \"%s\\n%s\" \"$$\" \"$!\" > \"$MINIQ_GIT_FILTER_PIDS\"; wait'"
            .to_owned();
    #[cfg(windows)]
    let filter = {
        let script = directory.join("filter.ps1");
        std::fs::write(&script, r#"
$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 30') -WindowStyle Hidden -PassThru
[IO.File]::WriteAllText($env:MINIQ_GIT_FILTER_PIDS, "$PID`n$($child.Id)")
$child.WaitForExit()
"#).unwrap();
        format!(
            "powershell.exe -NoProfile -NonInteractive -File '{}'",
            script.to_string_lossy().replace('\\', "/")
        )
    };
    for args in [
        vec!["init", "--quiet"],
        vec!["config", "filter.slow.clean", &filter],
    ] {
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(args)
            .status()
            .unwrap()
            .success());
    }
    std::fs::write(directory.join("filtered.txt"), "one\ntwo\n").unwrap();
    assert!(std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["add", "--intent-to-add", "filtered.txt"])
        .status()
        .unwrap()
        .success());
    std::fs::write(directory.join(".gitattributes"), "*.txt filter=slow\n").unwrap();
    let mut command = super::super::git(&directory.to_path_buf());
    command.args(["diff", "--numstat", "--no-textconv", "--no-ext-diff"]);
    command.env("MINIQ_GIT_FILTER_PIDS", marker);
    command
}

#[tokio::test]
async fn cancellation_and_timeout_kill_git_clean_filter_process_trees() {
    for cancel in [true, false] {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("pids");
        let command = filtered_diff(directory.path(), &marker);
        let executor = Arc::new(Executor {
            slots: Arc::new(Semaphore::new(1)),
            timeout: if cancel {
                Duration::from_secs(10)
            } else {
                execution_timeout()
            },
        });
        let executing = executor.clone();
        let request = tokio::spawn(async move { executing.run(command, Vec::new(), None).await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while !std::fs::read_to_string(&marker).is_ok_and(|pids| pids.lines().count() == 2) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        let pids = std::fs::read_to_string(&marker).unwrap();
        if cancel {
            request.abort();
            let _ = request.await;
        } else {
            assert_eq!(
                request.await.unwrap().unwrap_err().message,
                "git command timed out"
            );
        }
        let _permit = tokio::time::timeout(Duration::from_secs(5), executor.slots.acquire())
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while pids.lines().any(process_exists) {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("Git filter descendants survived cancellation/timeout");
    }
}
