use super::*;
use tokio::io::AsyncReadExt;

impl Fixture {
    /// BSD script provides a real controlling terminal, including hidden Key input.
    async fn run_terminal(&self, args: &[&str], steps: &[(&str, &str)]) -> String {
        self.run_terminal_with_term(args, steps, "dumb").await
    }

    async fn run_terminal_with_term(
        &self,
        args: &[&str],
        steps: &[(&str, &str)],
        term: &str,
    ) -> String {
        let mut child = tokio::process::Command::new("/usr/bin/script")
            .args([
                "-q",
                "/dev/null",
                env!("CARGO_BIN_EXE_miniq"),
                "--no-start",
                "--data-dir",
            ])
            .arg(self.dir.path())
            .arg("-C")
            .arg(self.dir.path())
            .args(args)
            .env_remove("MINIQ_API_KEY")
            .env_remove("MINIQ_DAEMON_PATH")
            .env("TERM", term)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut transcript = Vec::new();
        let mut start = 0;
        for (prompt, answer) in steps {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !String::from_utf8_lossy(&transcript[start..]).contains(prompt) {
                    let mut bytes = [0; 4096];
                    let length = stdout.read(&mut bytes).await.unwrap();
                    assert!(
                        length > 0,
                        "terminal closed before {prompt}: {}",
                        String::from_utf8_lossy(&transcript)
                    );
                    transcript.extend_from_slice(&bytes[..length]);
                }
                // rpassword prints its prompt before disabling terminal echo.
                tokio::time::sleep(Duration::from_millis(40)).await;
                start = transcript.len();
                stdin.write_all(answer.as_bytes()).await.unwrap();
                stdin.flush().await.unwrap();
            })
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "missing prompt {prompt}: {}",
                    String::from_utf8_lossy(&transcript)
                )
            });
        }
        drop(stdin);
        tokio::time::timeout(Duration::from_secs(10), stdout.read_to_end(&mut transcript))
            .await
            .unwrap()
            .unwrap();
        let status = child.wait().await.unwrap();
        assert!(status.success(), "{}", String::from_utf8_lossy(&transcript));
        String::from_utf8_lossy(&transcript).into_owned()
    }
}

#[tokio::test]
async fn up_arrow_recalls_previous_prompt_in_session() {
    let fixture = Fixture::new("success").await;
    fixture
        .run_terminal_with_term(
            &[],
            &[
                ("miniq>", "Review the project\n"),
                ("miniq>", "\x1b[A\n"),
                ("miniq>", "/exit\n"),
            ],
            "xterm-256color",
        )
        .await;
    let requests = fixture.requests.lock().unwrap();
    let prompts = requests
        .iter()
        .filter(|request| request["method"] == "session.sendMessage")
        .map(|request| request["params"]["message"]["content"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(prompts, vec!["Review the project", "Review the project"]);
}

#[tokio::test]
async fn guided_setup_hides_key_searches_models_then_starts_chat() {
    let fixture = Fixture::new("unconfigured").await;
    let transcript = fixture
        .run_terminal(
            &[],
            &[
                ("API Key (hidden", "fixture-private-key\n"),
                ("Select/search>", "gemini\n"),
                ("Select/search>", "1\n"),
                ("miniq>", "/exit\n"),
            ],
        )
        .await;
    assert!(!transcript.contains("fixture-private-key"));
    assert!(transcript.contains("1 match(es)"));
    let requests = fixture.requests.lock().unwrap();
    let update = requests
        .iter()
        .find(|request| request["method"] == "settings.update")
        .unwrap();
    assert_eq!(update["params"]["provider"]["model"], "gemini-3.8-flash");
    assert_eq!(
        update["params"]["provider"]["apiKey"],
        "fixture-private-key"
    );
    let config_position = requests
        .iter()
        .position(|request| request["method"] == "settings.update")
        .unwrap();
    let session_position = requests
        .iter()
        .position(|request| request["method"] == "session.create")
        .unwrap();
    assert!(config_position < session_position);
    assert!(!requests
        .iter()
        .any(|request| request["method"] == "session.sendMessage"));
}

#[tokio::test]
async fn cancelled_setup_does_not_save_key_or_create_empty_session() {
    let fixture = Fixture::new("unconfigured").await;
    let transcript = fixture
        .run_terminal(
            &[],
            &[
                ("API Key (hidden", "fixture-private-key\n"),
                ("Select/search>", "/cancel\n"),
            ],
        )
        .await;
    assert!(!transcript.contains("fixture-private-key"));
    let requests = fixture.requests.lock().unwrap();
    assert!(!requests.iter().any(|request| matches!(
        request["method"].as_str(),
        Some("settings.update" | "workspace.open" | "session.create")
    )));
}

#[tokio::test]
async fn resume_search_and_model_picker_update_only_the_selected_session() {
    let fixture = Fixture::new("success").await;
    let transcript = fixture
        .run_terminal(
            &["resume"],
            &[
                ("Select/search>", "中文\n"),
                ("Select/search>", "1\n"),
                ("miniq>", "/model\n"),
                ("Select/search>", "opus\n"),
                ("Select/search>", "1\n"),
                ("miniq>", "/effort\n"),
                ("Select/search>", "high\n"),
                ("miniq>", "/exit\n"),
            ],
        )
        .await;
    assert!(transcript.contains("saved for this session only"));
    let requests = fixture.requests.lock().unwrap();
    let updates = requests
        .iter()
        .filter(|request| request["method"] == "session.modelUpdate")
        .collect::<Vec<_>>();
    assert_eq!(updates.len(), 2);
    assert!(updates
        .iter()
        .all(|request| request["params"]["sessionId"] == "session-1"));
    assert_eq!(updates[0]["params"]["settings"]["model"], "claude-opus");
    assert_eq!(updates[1]["params"]["settings"]["reasoningEffort"], "high");
    assert!(!requests.iter().any(|request| matches!(
        request["method"].as_str(),
        Some("settings.update" | "session.create" | "session.sendMessage")
    )));
}
