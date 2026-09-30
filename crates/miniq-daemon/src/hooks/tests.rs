use super::*;
use serde_json::json;

fn hook(event: &str, command: &str) -> HookConfig {
    HookConfig {
        event: event.to_string(),
        matcher: None,
        command: command.to_string(),
        timeout_secs: None,
        enabled: None,
    }
}

#[test]
fn config_defaults_and_camel_case_round_trip() {
    let parsed: HookConfig =
        serde_json::from_value(json!({"event": "preToolUse", "command": "true", "timeoutSecs": 5}))
            .unwrap();
    assert!(parsed.is_enabled());
    assert_eq!(parsed.timeout(), Duration::from_secs(5));
    assert_eq!(
        hook("stop", "x").timeout(),
        Duration::from_secs(DEFAULT_TIMEOUT_SECS)
    );
    let value = serde_json::to_value(&parsed).unwrap();
    assert_eq!(value["timeoutSecs"], 5);
    assert!(value.get("matcher").is_none());
}

#[test]
fn validate_accepts_good_config_and_rejects_bad_ones() {
    let mut good = hook("postToolUse", "echo ok");
    good.matcher = Some("file_.*|shell_run".into());
    good.timeout_secs = Some(600);
    assert!(validate(&[good, hook("sessionStart", "true")]).is_ok());
    assert!(validate(&[]).is_ok());

    let error = validate(&[hook("beforeEverything", "true")]).unwrap_err();
    assert!(error.contains("hooks[0].event"), "{error}");
    assert!(error.contains("preToolUse"), "{error}");

    let error = validate(&[hook("stop", "   ")]).unwrap_err();
    assert!(error.contains("command must not be empty"), "{error}");

    for timeout in [0, 601] {
        let mut bad = hook("stop", "true");
        bad.timeout_secs = Some(timeout);
        let error = validate(&[bad]).unwrap_err();
        assert!(error.contains("timeoutSecs"), "{error}");
    }

    let mut bad = hook("preToolUse", "true");
    bad.matcher = Some("file_(".into());
    let error = validate(&[hook("stop", "true"), bad]).unwrap_err();
    assert!(error.contains("hooks[1].matcher"), "{error}");
}

#[test]
fn matcher_supports_all_exact_and_regex() {
    assert!(matcher_matches(None, "shell_run"));
    assert!(matcher_matches(Some("*"), "shell_run"));
    assert!(matcher_matches(Some(""), "shell_run"));
    assert!(matcher_matches(Some("shell_run"), "shell_run"));
    assert!(!matcher_matches(Some("shell_run"), "shell_batch"));
    assert!(matcher_matches(Some("file_.*"), "file_write"));
    assert!(
        !matcher_matches(Some("file"), "file_write"),
        "regex is anchored"
    );
    assert!(matcher_matches(Some("shell_run|file_write"), "file_write"));
    assert!(
        !matcher_matches(Some("file_("), "file_read"),
        "invalid regex never matches"
    );
}

#[test]
fn applies_to_respects_event_enabled_and_matcher() {
    let mut pre = hook("preToolUse", "true");
    pre.matcher = Some("shell_.*".into());
    assert!(pre.applies_to(HookEvent::PreToolUse, Some("shell_run")));
    assert!(!pre.applies_to(HookEvent::PreToolUse, Some("file_read")));
    assert!(!pre.applies_to(HookEvent::PostToolUse, Some("shell_run")));
    pre.enabled = Some(false);
    assert!(!pre.applies_to(HookEvent::PreToolUse, Some("shell_run")));
    assert!(hook("stop", "true").applies_to(HookEvent::Stop, None));
}

#[cfg(unix)]
mod unix {
    use super::*;
    use crate::state::AppState;
    use std::sync::Arc;

    fn fixture(directory: &Path) -> (AppState, HookContext) {
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace(directory.to_str().unwrap(), "hooks")
            .unwrap();
        let session = store.create_session(&workspace.id, "hooks").unwrap();
        let state = AppState::new(
            store,
            "token".to_string(),
            Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
        );
        let context = HookContext::for_session(&state, &session.id).unwrap();
        (state, context)
    }

    fn set_hooks(state: &AppState, hooks: Vec<HookConfig>) {
        state.settings.lock().unwrap().hooks = hooks;
    }

    async fn command(context: &HookContext, script: &str, timeout: Duration) -> CommandResult {
        run_command(
            script,
            &context.cwd,
            br#"{"hello":"world"}"#,
            HookEvent::PreToolUse,
            context,
            timeout,
        )
        .await
    }

    #[tokio::test]
    async fn run_command_reports_exit_codes_stdin_env_and_cwd() {
        let directory = tempfile::tempdir().unwrap();
        let (_state, context) = fixture(directory.path());
        let ok = command(
            &context,
            r#"cat; printf ' %s %s ' "$MINIQ_HOOK_EVENT" "$MINIQ_SESSION_ID"; pwd"#,
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(ok.exit_code, Some(0));
        assert!(
            ok.stdout.starts_with(r#"{"hello":"world"} preToolUse "#),
            "{}",
            ok.stdout
        );
        assert!(ok.stdout.contains(&context.session_id));
        let cwd = std::fs::canonicalize(directory.path()).unwrap();
        assert!(
            ok.stdout.trim_end().ends_with(cwd.to_str().unwrap()),
            "{}",
            ok.stdout
        );

        let blocked = command(&context, "echo nope >&2; exit 2", Duration::from_secs(10)).await;
        assert_eq!(blocked.exit_code, Some(2));
        assert_eq!(blocked.stderr.trim(), "nope");

        let other = command(&context, "exit 7", Duration::from_secs(10)).await;
        assert_eq!(other.exit_code, Some(7));
        assert!(!other.timed_out);
    }

    #[tokio::test]
    async fn run_command_kills_on_timeout_and_caps_output() {
        let directory = tempfile::tempdir().unwrap();
        let (_state, context) = fixture(directory.path());
        let started = Instant::now();
        let slow = command(&context, "sleep 30", Duration::from_millis(300)).await;
        assert!(slow.timed_out);
        assert!(started.elapsed() < Duration::from_secs(10));

        let noisy = command(
            &context,
            "head -c 200000 /dev/zero | tr '\\0' a",
            Duration::from_secs(10),
        )
        .await;
        assert_eq!(noisy.exit_code, Some(0));
        assert!(noisy.stdout.len() <= OUTPUT_CAP_BYTES + 64);
        assert!(noisy.stdout.ends_with("[output truncated]"));
    }

    #[tokio::test]
    async fn run_event_semantics_for_block_feedback_and_errors() {
        let directory = tempfile::tempdir().unwrap();
        let (state, context) = fixture(directory.path());
        let session = context.session_id.clone();

        // No hooks: nothing runs and nothing is audited.
        let outcome = run_event(&state, &context, HookEvent::Stop, HookPayload::default()).await;
        assert_eq!(outcome, HookOutcome::default());
        assert_eq!(state.store.count_audit_events(&session).unwrap(), 0);

        // First block wins; later hooks do not run.
        set_hooks(
            &state,
            vec![
                hook("preToolUse", "exit 7"),
                hook("preToolUse", "echo first >&2; exit 2"),
                hook("preToolUse", "touch never-run"),
            ],
        );
        let payload = HookPayload {
            tool_name: Some("shell_run".into()),
            ..Default::default()
        };
        let outcome = run_event(&state, &context, HookEvent::PreToolUse, payload.clone()).await;
        assert_eq!(outcome.blocked.as_deref(), Some("first"));
        assert!(!directory.path().join("never-run").exists());
        assert_eq!(state.store.count_audit_events(&session).unwrap(), 2);

        // postToolUse exit 2 is feedback, not a block.
        set_hooks(
            &state,
            vec![hook("postToolUse", "echo check lint >&2; exit 2")],
        );
        let outcome = run_event(&state, &context, HookEvent::PostToolUse, payload).await;
        assert!(outcome.blocked.is_none());
        assert_eq!(outcome.feedback, vec!["check lint".to_string()]);

        // userPromptSubmit stdout is recorded.
        set_hooks(&state, vec![hook("userPromptSubmit", "echo context")]);
        let outcome = run_event(
            &state,
            &context,
            HookEvent::UserPromptSubmit,
            HookPayload {
                prompt: Some("hi".into()),
                ..Default::default()
            },
        )
        .await;
        assert_eq!(outcome.stdout, vec!["context".to_string()]);

        // Feature flag off: nothing runs.
        state.settings.lock().unwrap().features.hooks = crate::features::FeatureStage::Off;
        set_hooks(&state, vec![hook("stop", "touch flag-off")]);
        let outcome = run_event(&state, &context, HookEvent::Stop, HookPayload::default()).await;
        assert_eq!(outcome, HookOutcome::default());
        assert!(!directory.path().join("flag-off").exists());
        assert!(configured(&state, HookEvent::Stop, None).is_empty());
        assert_eq!(list_view(&state)["enabled"], false);
    }
}
