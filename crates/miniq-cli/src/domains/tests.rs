use super::*;
use crate::args::{Cli, Commands};
use clap::{CommandFactory, Parser};
use serde_json::json;

fn mapped(arguments: &[&str]) -> anyhow::Result<DomainRequest> {
    let cli = Cli::try_parse_from(std::iter::once("miniq").chain(arguments.iter().copied()))?;
    match cli.command {
        Some(Commands::Domain(command)) => request(command),
        Some(Commands::Skills { command }) => skill_request(command),
        Some(Commands::Plugins { command }) => plugin_request(command),
        _ => panic!("expected a domain command"),
    }
}

#[test]
fn domain_tree_is_valid_with_global_chat_options() {
    Cli::command().debug_assert();
    let request = mapped(&[
        "--model",
        "chat-model",
        "review",
        "start",
        "s",
        "m",
        "review-model",
    ])
    .unwrap();
    assert_eq!(request.params["model"], "review-model");
    let request = mapped(&["--approval", "auto", "approval", "resolve", "a", "approve"]).unwrap();
    assert_eq!(
        request.params,
        json!({"approvalId":"a","decision":"approve"})
    );
}

#[test]
fn common_domain_commands_map_session_paths_and_pagination_without_loss() {
    assert_eq!(
        mapped(&["git", "diff", "s", "src/有 空格.rs", "--staged"]).unwrap(),
        DomainRequest::new(
            "git.diff",
            json!({"sessionId":"s","path":"src/有 空格.rs","staged":true})
        )
    );
    assert_eq!(
        mapped(&[
            "file",
            "read",
            "s",
            "large.txt",
            "--revision",
            "r",
            "--offset",
            "3145728"
        ])
        .unwrap()
        .params,
        json!({"sessionId":"s","path":"large.txt","revision":"r","offset":3145728})
    );
    let cursor = r#"{"at":"2026-10-21T00:00:00Z","id":"a"}"#;
    assert_eq!(
        mapped(&["approval", "inbox", "--before", cursor])
            .unwrap()
            .params,
        json!({"before":{"at":"2026-10-21T00:00:00Z","id":"a"}})
    );
    assert_eq!(
        mapped(&[
            "schedule",
            "runs",
            "task",
            "--cursor",
            "next-page",
            "--limit",
            "100"
        ])
        .unwrap()
        .params,
        json!({"taskId":"task","cursor":"next-page","limit":100})
    );
    assert_eq!(
        mapped(&["terminal", "input", "s", "pty", "echo hello\n"])
            .unwrap()
            .params["data"],
        "echo hello\n"
    );
    assert_eq!(
        mapped(&[
            "terminal",
            "read",
            "s",
            "pty",
            "--offset",
            "9007199254740993"
        ])
        .unwrap()
        .params["offset"],
        9007199254740993_u64
    );
}

#[test]
fn domain_operations_route_to_the_expected_daemon_capabilities() {
    let cases: &[(&[&str], &str)] = &[
        (&["git", "status", "s"], "git.status"),
        (&["terminal", "create", "s"], "terminal.create"),
        (
            &["terminal", "resize", "s", "t", "40", "100"],
            "terminal.resize",
        ),
        (&["terminal", "close", "s", "t"], "terminal.close"),
        (&["file", "list", "s"], "file.list"),
        (&["file", "describe", "s", "x"], "file.describe"),
        (&["tool", "list"], "tool.list"),
        (&["tool", "detail", "s", "call"], "tool.detail"),
        (&["approval", "rules"], "approval.rules.list"),
        (&["approval", "revoke", "rule"], "approval.rules.revoke"),
        (&["review", "list", "s"], "review.list"),
        (&["review", "get", "s", "r"], "review.get"),
        (&["review", "cancel", "s", "r"], "review.cancel"),
        (&["schedule", "list"], "schedule.list"),
        (&["schedule", "enable", "task"], "schedule.toggle"),
        (&["schedule", "disable", "task"], "schedule.toggle"),
        (&["schedule", "delete", "task"], "schedule.delete"),
        (&["schedule", "run", "task"], "schedule.runNow"),
        (&["external", "scan"], "externalSession.scan"),
        (
            &["external", "scan-status", "job"],
            "externalSession.scanStatus",
        ),
        (
            &["external", "import-status", "job"],
            "externalSession.importStatus",
        ),
        (&["workspace", "list"], "workspace.list"),
        (&["workspace", "open", "/tmp/project"], "workspace.open"),
        (&["workspace", "create", "project"], "workspace.create"),
        (
            &["workspace", "rename", "w", "new name"],
            "workspace.rename",
        ),
        (&["workspace", "delete", "w"], "workspace.delete"),
        (&["workspace", "model-get", "w"], "workspace.modelGet"),
        (&["host", "list"], "host.list"),
        (&["host", "save", "server"], "host.save"),
        (&["ssh", "create", "server"], "host.save"),
        (&["host", "remove", "server"], "host.remove"),
        (&["host", "connect", "server"], "host.connect"),
        (&["host", "disconnect", "server"], "host.disconnect"),
        (&["voice", "capabilities"], "voice.capabilities"),
        (&["computer", "permissions"], "computer.permissions"),
        (
            &["computer", "request", "accessibility"],
            "computer.requestPermission",
        ),
        (&["skills", "list", "--workspace", "w"], "skill.list"),
        (&["skills", "read", "skill"], "skill.read"),
        (&["skills", "enable", "skill"], "skill.setEnabled"),
        (&["skills", "disable", "skill"], "skill.setEnabled"),
        (&["skills", "delete", "skill"], "skill.delete"),
        (&["skills", "import", "/tmp/skill"], "skill.import"),
        (&["skills", "job", "list"], "skill.job.list"),
        (
            &["skills", "job", "get", "job", "--session", "s"],
            "skill.job.get",
        ),
        (&["skills", "job", "cancel", "job"], "skill.job.cancel"),
        (&["plugins", "list", "--json"], "plugin.list"),
        (
            &["plugins", "install", "/tmp/plugin", "--update"],
            "plugin.install",
        ),
        (&["plugins", "uninstall", "p"], "plugin.uninstall"),
        (&["plugins", "reload", "p"], "plugin.reload"),
        (
            &["plugins", "enable", "p", "--trust-code"],
            "plugin.setEnabled",
        ),
        (&["plugins", "disable", "p"], "plugin.setEnabled"),
        (&["plugins", "diagnostics", "p"], "plugin.getDiagnostics"),
    ];
    for (arguments, method) in cases {
        assert_eq!(mapped(arguments).unwrap().method, *method, "{arguments:?}");
    }
    assert_eq!(
        mapped(&["plugins", "enable", "p", "--trust-code"])
            .unwrap()
            .params["confirmTrustedCode"],
        true
    );
    assert_eq!(
        mapped(&["schedule", "disable", "task"]).unwrap().params["enabled"],
        false
    );
}

#[test]
fn json_operations_validate_shapes_without_dropping_large_contents() {
    let content = "完整技能内容\n".repeat(2000);
    let input = json!({"content":content,"force":true}).to_string();
    assert_eq!(
        mapped(&["skills", "save", &input]).unwrap().params["content"],
        content
    );
    let cases: &[(&[&str], &str)] = &[
        (
            &[
                "schedule",
                "create",
                r#"{"workspaceId":"w","name":"daily","prompt":"task","schedule":{"kind":"once","at":"2026-10-22T00:00:00Z"}}"#,
            ],
            "schedule.create",
        ),
        (
            &[
                "schedule",
                "update",
                r#"{"id":"t","name":"daily","prompt":"task","schedule":{}}"#,
            ],
            "schedule.update",
        ),
        (
            &[
                "memory",
                "list",
                r#"{"target":{"scope":"global"},"limit":100}"#,
            ],
            "memory.list",
        ),
        (
            &[
                "memory",
                "delete",
                r#"{"target":{"scope":"global"},"id":"m","expectedUpdatedAt":"now","expectedContent":"text"}"#,
            ],
            "memory.delete",
        ),
        (
            &[
                "external",
                "import",
                r#"{"sessions":[{"provider":"codex","externalId":"s","sourcePath":"/tmp/source"}]}"#,
            ],
            "externalSession.import",
        ),
        (
            &[
                "workspace",
                "roots",
                r#"{"workspaceId":"w","paths":["/one","/two"]}"#,
            ],
            "workspace.updateRoots",
        ),
        (
            &[
                "workspace",
                "model-set",
                r#"{"workspaceId":"w","settings":{"model":"m","reasoningEffort":"high"}}"#,
            ],
            "workspace.modelUpdate",
        ),
        (
            &[
                "voice",
                "transcribe",
                r#"{"audioBase64":"dGVzdA==","preview":true}"#,
            ],
            "voice.transcribe",
        ),
        (
            &["voice", "speak", r#"{"text":"Hello","voice":"eve"}"#],
            "voice.speak",
        ),
        (
            &["skills", "create", r#"{"goal":"create a skill"}"#],
            "skill.create",
        ),
        (
            &["skills", "validate", r#"{"content":"draft"}"#],
            "skill.validate",
        ),
        (
            &[
                "skills",
                "distill",
                r#"{"sessionId":"s","deadlineMs":1000}"#,
            ],
            "skill.distill",
        ),
        (
            &["skills", "refine", r#"{"sessionId":"s","name":"skill"}"#],
            "skill.refine",
        ),
        (
            &[
                "skills",
                "job",
                "start",
                r#"{"kind":"refine","sessionId":"s","name":"skill"}"#,
            ],
            "skill.job.start",
        ),
    ];
    for (arguments, method) in cases {
        assert_eq!(mapped(arguments).unwrap().method, *method, "{arguments:?}");
    }
}

#[test]
fn typed_json_rejects_invalid_input_before_dispatch() {
    for arguments in [
        vec!["memory", "list", r#"{"target":{"scope":"workspace"}}"#],
        vec![
            "memory",
            "list",
            r#"{"target":{"scope":"global"},"limit":101}"#,
        ],
        vec![
            "memory",
            "delete",
            r#"{"target":{"scope":"global"},"id":"m"}"#,
        ],
        vec![
            "external",
            "import",
            r#"{"sessions":[{"provider":"unknown"}]}"#,
        ],
        vec!["skills", "job", "start", r#"{"kind":"unknown"}"#],
        vec!["skills", "refine", r#"{"sessionId":"s"}"#],
        vec!["voice", "transcribe", r#"{"audioBase64":123}"#],
        vec!["voice", "speak", r#"{"text":"Hello","voice":false}"#],
        vec![
            "schedule",
            "create",
            r#"{"name":"task","prompt":"run","schedule":{}}"#,
        ],
        vec![
            "workspace",
            "model-set",
            r#"{"workspaceId":"w","settings":{"reasoningEffort":"invalid"}}"#,
        ],
    ] {
        assert!(mapped(&arguments).is_err(), "{arguments:?}");
    }
    assert!(Cli::try_parse_from(["miniq", "terminal", "create", "s", "--rows", "1001"]).is_err());
    assert!(
        Cli::try_parse_from(["miniq", "terminal", "read", "s", "t", "--wait-ms", "30001"]).is_err()
    );
}

#[test]
fn json_file_input_preserves_complete_lists_and_cursor_values() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("memory request.json");
    let value = json!({"target":{"scope":"workspace","workspaceId":"w"},"before":{"updatedAt":"timestamp","id":"cursor"},"limit":100});
    std::fs::write(&path, value.to_string()).unwrap();
    let source = format!("@{}", path.display());
    assert_eq!(mapped(&["memory", "list", &source]).unwrap().params, value);
    let selections = (0..250).map(|index| json!({"provider":"codex","externalId":format!("s-{index}"),"sourcePath":"/tmp/source"})).collect::<Vec<_>>();
    let source = json!({"sessions":selections}).to_string();
    assert_eq!(
        mapped(&["external", "import", &source]).unwrap().params["sessions"]
            .as_array()
            .unwrap()
            .len(),
        250
    );
}
