use super::*;

async fn read_until(
    manager: &ProcessManager,
    cwd: &std::path::Path,
    id: &str,
    offset: &mut u64,
    expected: &str,
) -> String {
    let mut text = String::new();
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let page = manager
                .terminal_output(
                    "owner",
                    cwd.into(),
                    id,
                    TerminalOutputRequest {
                        stdout_offset: Some(*offset),
                        max_bytes: 4096,
                        wait: Duration::from_millis(100),
                    },
                )
                .await
                .unwrap();
            text.push_str(page["stdout"].as_str().unwrap());
            *offset = page["stdoutPage"]["nextOffset"].as_u64().unwrap();
            if text.contains(expected) {
                break;
            }
            assert_eq!(page["status"], "running", "{text:?}");
        }
    })
    .await;
    assert!(result.is_ok(), "missing {expected:?} in {text:?}");
    text
}

#[tokio::test]
async fn embedded_terminal_declares_xterm_capabilities() {
    let manager = ProcessManager::default();
    let dir = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    let command = "printf 'TERM=%s COLOR=%s\\n' \"$TERM\" \"$COLORTERM\"";
    #[cfg(windows)]
    let command = "Write-Output ('TERM=' + $env:TERM + ' COLOR=' + $env:COLORTERM)";
    let id = manager
        .terminal_start(
            "owner",
            TerminalLaunch {
                command: command.into(),
                cwd: dir.path().into(),
                rows: 24,
                cols: 80,
            },
        )
        .await
        .unwrap();
    read_until(
        &manager,
        dir.path(),
        &id,
        &mut 0,
        "TERM=xterm-256color COLOR=truecolor",
    )
    .await;
    manager.shutdown().await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn embedded_terminal_backspace_edits_input_and_resize_reaches_pty() {
    let manager = ProcessManager::default();
    let dir = tempfile::tempdir().unwrap();
    let id = manager
        .terminal_start(
            "owner",
            TerminalLaunch {
                command:
                    "printf 'ready\\n'; read value; printf '\\nvalue:%s\\n' \"$value\"; stty size"
                        .into(),
                cwd: dir.path().into(),
                rows: 24,
                cols: 80,
            },
        )
        .await
        .unwrap();
    let mut offset = 0;
    read_until(&manager, dir.path(), &id, &mut offset, "ready").await;
    manager
        .terminal_resize("owner", dir.path().into(), &id, 40, 120)
        .await
        .unwrap();
    manager
        .terminal_input("owner", dir.path().into(), &id, "abx\u{7f}c\r".into())
        .await
        .unwrap();
    let output = read_until(&manager, dir.path(), &id, &mut offset, "40 120").await;
    assert!(output.contains("value:abc"), "{output:?}");
    manager.shutdown().await.unwrap();
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn macos_zsh_backspace_and_arrow_keys_edit_the_current_command() {
    let manager = ProcessManager::default();
    let dir = tempfile::tempdir().unwrap();
    let id = manager
        .terminal_start(
            "owner",
            TerminalLaunch {
                command: "exec /bin/zsh -f -i".into(),
                cwd: dir.path().into(),
                rows: 24,
                cols: 80,
            },
        )
        .await
        .unwrap();
    let mut offset = 0;
    manager
        .terminal_input(
            "owner",
            dir.path().into(),
            &id,
            "printf '__READY__\\n'\r".into(),
        )
        .await
        .unwrap();
    read_until(&manager, dir.path(), &id, &mut offset, "\r\n__READY__\r\n").await;
    // Delete x, type c, move left and insert z: the executed argument is abzc.
    manager
        .terminal_input(
            "owner",
            dir.path().into(),
            &id,
            "printf '<%s>\\n' abx\u{7f}c\u{1b}[Dz\r".into(),
        )
        .await
        .unwrap();
    read_until(&manager, dir.path(), &id, &mut offset, "<abzc>").await;
    manager.shutdown().await.unwrap();
}
