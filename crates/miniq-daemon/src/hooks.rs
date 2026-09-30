//! User-configurable lifecycle hooks (Claude Code style).
//!
//! Hooks are local shell commands declared in `settings.json` under `hooks`.
//! Each receives a JSON description of the event on stdin plus
//! `MINIQ_HOOK_EVENT` / `MINIQ_SESSION_ID` in its environment and runs in the
//! session's workspace directory.
//!
//! Exit codes:
//! - `0`: continue (for `userPromptSubmit` non-empty stdout is recorded);
//! - `2`: block `preToolUse` / `userPromptSubmit` (stderr is the reason),
//!   or append stderr as feedback to a `postToolUse` result;
//! - anything else, spawn errors and timeouts: logged and ignored.
//!
//! Hooks for one event run sequentially in configuration order and the first
//! block wins. The `hooks` feature flag disables all of them at once.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::state::AppState;

/// Default per-hook timeout.
pub const DEFAULT_TIMEOUT_SECS: u64 = 30;
/// Largest accepted `timeoutSecs`.
pub const MAX_TIMEOUT_SECS: u64 = 600;
/// Captured stdout / stderr is truncated to this many bytes each.
pub const OUTPUT_CAP_BYTES: usize = 64 * 1024;
/// Longest accepted hook command.
pub const MAX_COMMAND_CHARS: usize = 4000;
/// Largest accepted number of configured hooks.
pub const MAX_HOOKS: usize = 64;
/// Commands are truncated to this many characters in audit records.
const AUDIT_COMMAND_CHARS: usize = 200;
/// Hook stdout / stderr kept in audit records.
const AUDIT_TEXT_CHARS: usize = 2000;

/// Lifecycle points a hook can attach to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    UserPromptSubmit,
    Stop,
    SessionStart,
}

impl HookEvent {
    pub const ALL: [HookEvent; 5] = [
        HookEvent::PreToolUse,
        HookEvent::PostToolUse,
        HookEvent::UserPromptSubmit,
        HookEvent::Stop,
        HookEvent::SessionStart,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            HookEvent::PreToolUse => "preToolUse",
            HookEvent::PostToolUse => "postToolUse",
            HookEvent::UserPromptSubmit => "userPromptSubmit",
            HookEvent::Stop => "stop",
            HookEvent::SessionStart => "sessionStart",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|event| event.as_str() == value)
    }

    /// Tool events are the only ones that honour `matcher`.
    pub fn is_tool_event(self) -> bool {
        matches!(self, HookEvent::PreToolUse | HookEvent::PostToolUse)
    }
}

/// One configured hook. `event` stays a string so an unknown value in an
/// older/newer `settings.json` never makes the whole file unreadable; it is
/// validated on `settings.update` and ignored at runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookConfig {
    pub event: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matcher: Option<String>,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

impl HookConfig {
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(true)
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_secs(
            self.timeout_secs
                .unwrap_or(DEFAULT_TIMEOUT_SECS)
                .clamp(1, MAX_TIMEOUT_SECS),
        )
    }

    /// Whether this hook applies to `event` (and `tool_name` for tool events).
    pub fn applies_to(&self, event: HookEvent, tool_name: Option<&str>) -> bool {
        if !self.is_enabled() || HookEvent::parse(&self.event) != Some(event) {
            return false;
        }
        if !event.is_tool_event() {
            return true;
        }
        matcher_matches(self.matcher.as_deref(), tool_name.unwrap_or_default())
    }
}

/// `None`, empty and `*` match every tool. Otherwise an exact tool name
/// matches, or the matcher is used as a regex anchored to the whole name
/// (`file_.*`, `shell_run|file_write`). Invalid regexes match nothing.
pub fn matcher_matches(matcher: Option<&str>, tool_name: &str) -> bool {
    let matcher = matcher.map(str::trim).unwrap_or_default();
    if matcher.is_empty() || matcher == "*" || matcher == tool_name {
        return true;
    }
    anchored(matcher)
        .map(|regex| regex.is_match(tool_name))
        .unwrap_or(false)
}

fn anchored(matcher: &str) -> Result<regex::Regex, regex::Error> {
    regex::Regex::new(&format!("^(?:{matcher})$"))
}

/// Validate hooks before they are saved. Errors name the offending entry.
pub fn validate(hooks: &[HookConfig]) -> Result<(), String> {
    if hooks.len() > MAX_HOOKS {
        return Err(format!("at most {MAX_HOOKS} hooks can be configured"));
    }
    for (index, hook) in hooks.iter().enumerate() {
        let at = format!("hooks[{index}]");
        let Some(event) = HookEvent::parse(&hook.event) else {
            let known: Vec<&str> = HookEvent::ALL.iter().map(|e| e.as_str()).collect();
            return Err(format!(
                "{at}.event `{}` is unknown; expected one of {}",
                hook.event,
                known.join(", ")
            ));
        };
        if hook.command.trim().is_empty() {
            return Err(format!("{at}.command must not be empty"));
        }
        if hook.command.chars().count() > MAX_COMMAND_CHARS {
            return Err(format!(
                "{at}.command is too long (max {MAX_COMMAND_CHARS} characters)"
            ));
        }
        if let Some(timeout) = hook.timeout_secs {
            if !(1..=MAX_TIMEOUT_SECS).contains(&timeout) {
                return Err(format!(
                    "{at}.timeoutSecs must be between 1 and {MAX_TIMEOUT_SECS}, got {timeout}"
                ));
            }
        }
        if let Some(matcher) = hook.matcher.as_deref().map(str::trim) {
            if !matcher.is_empty() && matcher != "*" {
                if !event.is_tool_event() {
                    return Err(format!(
                        "{at}.matcher is only supported for preToolUse and postToolUse hooks"
                    ));
                }
                if let Err(error) = anchored(matcher) {
                    return Err(format!("{at}.matcher is not a valid regex: {error}"));
                }
            }
        }
    }
    Ok(())
}

/// Event-specific data passed to hooks on stdin.
#[derive(Debug, Clone, Default)]
pub struct HookPayload {
    pub tool_name: Option<String>,
    pub tool_input: Option<Value>,
    pub tool_output: Option<Value>,
    pub prompt: Option<String>,
    pub turn_status: Option<String>,
}

/// Combined result of every hook that ran for one event.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HookOutcome {
    /// Set by the first hook exiting 2 on a blocking event (stderr, trimmed).
    pub blocked: Option<String>,
    /// `postToolUse` exit-2 stderr, in order.
    pub feedback: Vec<String>,
    /// Non-empty stdout of hooks that exited 0, in order.
    pub stdout: Vec<String>,
}

/// Raw result of one hook process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandResult {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub spawn_error: Option<String>,
    pub duration_ms: u64,
}

/// Where and for whom hooks of one session run.
#[derive(Debug, Clone)]
pub struct HookContext {
    pub session_id: String,
    pub workspace_id: String,
    pub cwd: PathBuf,
}

impl HookContext {
    pub fn for_session(state: &AppState, session_id: &str) -> Option<Self> {
        let session = state.store.get_session(session_id).ok()?;
        let workspace = state.store.get_workspace(&session.workspace_id).ok()?;
        Some(Self {
            session_id: session.id,
            workspace_id: workspace.id,
            cwd: PathBuf::from(workspace.path),
        })
    }
}

/// Hooks that would run for `event`, honouring the feature flag. Cheap; lets
/// callers skip all hook work (and audit rows) when nothing is configured.
pub fn configured(state: &AppState, event: HookEvent, tool_name: Option<&str>) -> Vec<HookConfig> {
    let settings = state.settings.lock().unwrap();
    if !settings.features.hooks.enabled() {
        return Vec::new();
    }
    settings
        .hooks
        .iter()
        .filter(|hook| hook.applies_to(event, tool_name))
        .cloned()
        .collect()
}

/// Run every matching hook for `event` sequentially and fold the results.
pub async fn run_event(
    state: &AppState,
    context: &HookContext,
    event: HookEvent,
    payload: HookPayload,
) -> HookOutcome {
    let hooks = configured(state, event, payload.tool_name.as_deref());
    let mut outcome = HookOutcome::default();
    if hooks.is_empty() {
        return outcome;
    }
    let stdin = stdin_json(context, event, &payload);
    for hook in hooks {
        let result = run_command(
            &hook.command,
            &context.cwd,
            &stdin,
            event,
            context,
            hook.timeout(),
        )
        .await;
        let mut blocked = false;
        match (result.exit_code, result.timed_out) {
            (_, true) => tracing::warn!(
                session_id = %context.session_id,
                event = event.as_str(),
                timeout_secs = hook.timeout().as_secs(),
                "hook timed out and was killed"
            ),
            (Some(0), _) => {
                let stdout = result.stdout.trim();
                if !stdout.is_empty() {
                    outcome.stdout.push(stdout.to_string());
                }
            }
            (Some(2), _) => match event {
                HookEvent::PreToolUse | HookEvent::UserPromptSubmit => {
                    blocked = true;
                    outcome.blocked = Some(block_reason(&result.stderr));
                }
                HookEvent::PostToolUse => {
                    let stderr = result.stderr.trim();
                    if !stderr.is_empty() {
                        outcome.feedback.push(stderr.to_string());
                    }
                }
                HookEvent::Stop | HookEvent::SessionStart => tracing::warn!(
                    session_id = %context.session_id,
                    event = event.as_str(),
                    "hook exited 2 on a non-blocking event; ignored"
                ),
            },
            (code, _) => tracing::warn!(
                session_id = %context.session_id,
                event = event.as_str(),
                ?code,
                error = result.spawn_error.as_deref().unwrap_or(""),
                stderr = %truncate_chars(result.stderr.trim(), 500),
                "hook failed; continuing"
            ),
        }
        audit(state, context, event, &hook, &payload, &result, blocked);
        if blocked {
            break;
        }
    }
    outcome
}

/// Fire-and-forget variant for non-blocking events (`stop`, `sessionStart`).
pub fn spawn_event(state: &AppState, session_id: &str, event: HookEvent, payload: HookPayload) {
    if configured(state, event, payload.tool_name.as_deref()).is_empty() {
        return;
    }
    let Some(context) = HookContext::for_session(state, session_id) else {
        return;
    };
    let state = state.clone();
    tokio::spawn(async move {
        run_event(&state, &context, event, payload).await;
    });
}

fn block_reason(stderr: &str) -> String {
    let stderr = stderr.trim();
    if stderr.is_empty() {
        "no reason given".to_string()
    } else {
        stderr.to_string()
    }
}

fn stdin_json(context: &HookContext, event: HookEvent, payload: &HookPayload) -> Vec<u8> {
    let mut value = json!({
        "hookEvent": event.as_str(),
        "sessionId": context.session_id,
        "cwd": context.cwd.to_string_lossy(),
        "workspaceId": context.workspace_id,
    });
    let fields = [
        ("toolName", payload.tool_name.clone().map(Value::String)),
        ("toolInput", payload.tool_input.clone()),
        ("toolOutput", payload.tool_output.clone()),
        ("prompt", payload.prompt.clone().map(Value::String)),
        ("turnStatus", payload.turn_status.clone().map(Value::String)),
    ];
    for (key, field) in fields {
        if let Some(field) = field {
            value[key] = field;
        }
    }
    serde_json::to_vec(&value).unwrap_or_default()
}

fn audit(
    state: &AppState,
    context: &HookContext,
    event: HookEvent,
    hook: &HookConfig,
    payload: &HookPayload,
    result: &CommandResult,
    blocked: bool,
) {
    let mut record = json!({
        "event": event.as_str(),
        "command": truncate_chars(&hook.command, AUDIT_COMMAND_CHARS),
        "exitCode": result.exit_code,
        "durationMs": result.duration_ms,
        "blocked": blocked,
        "timedOut": result.timed_out,
    });
    if let Some(tool_name) = &payload.tool_name {
        record["toolName"] = json!(tool_name);
    }
    if let Some(error) = &result.spawn_error {
        record["error"] = json!(error);
    }
    if event == HookEvent::UserPromptSubmit && result.exit_code == Some(0) {
        let stdout = result.stdout.trim();
        if !stdout.is_empty() {
            record["stdout"] = json!(truncate_chars(stdout, AUDIT_TEXT_CHARS));
        }
    }
    if result.exit_code == Some(2) {
        record["stderr"] = json!(truncate_chars(result.stderr.trim(), AUDIT_TEXT_CHARS));
    }
    let record = crate::security::redacted(record);
    if let Err(error) = state
        .store
        .append_audit_event(Some(&context.session_id), "hook", &record)
    {
        tracing::error!("hook audit write failed: {error}");
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    match value.char_indices().nth(max) {
        Some((end, _)) => format!("{}…", &value[..end]),
        None => value.to_string(),
    }
}

/// Run one hook command with `stdin`, killing it after `timeout`.
pub async fn run_command(
    command: &str,
    cwd: &Path,
    stdin: &[u8],
    event: HookEvent,
    context: &HookContext,
    timeout: Duration,
) -> CommandResult {
    let started = Instant::now();
    let finish = |exit_code, stdout, stderr, timed_out, spawn_error| CommandResult {
        exit_code,
        stdout,
        stderr,
        timed_out,
        spawn_error,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    };

    #[cfg(windows)]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("powershell.exe");
        cmd.args(["-NoProfile", "-NonInteractive", "-Command", command]);
        cmd
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("sh");
        cmd.args(["-lc", command]);
        // Own process group so a timeout can kill grandchildren too.
        cmd.process_group(0);
        cmd
    };
    if cwd.is_dir() {
        cmd.current_dir(cwd);
    }
    cmd.env("MINIQ_HOOK_EVENT", event.as_str())
        .env("MINIQ_SESSION_ID", &context.session_id)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return finish(
                None,
                String::new(),
                String::new(),
                false,
                Some(error.to_string()),
            )
        }
    };
    let pid = child.id();
    let mut child_stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let input = stdin.to_vec();

    let work = async {
        let write = async {
            if let Some(mut pipe) = child_stdin.take() {
                // A hook that ignores stdin closes the pipe early; that is fine.
                let _ = pipe.write_all(&input).await;
                let _ = pipe.shutdown().await;
            }
        };
        let (_, out, err, status) = tokio::join!(
            write,
            read_capped(stdout),
            read_capped(stderr),
            child.wait()
        );
        (out, err, status)
    };
    let completed = tokio::time::timeout(timeout, work).await;
    match completed {
        Ok((out, err, status)) => match status {
            Ok(status) => finish(status.code(), out, err, false, None),
            Err(error) => finish(None, out, err, false, Some(error.to_string())),
        },
        Err(_) => {
            kill_tree(pid);
            let _ = child.start_kill();
            let _ = child.wait().await;
            finish(None, String::new(), String::new(), true, None)
        }
    }
}

#[cfg(not(windows))]
fn kill_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        // The hook leads its own process group (see `process_group(0)`).
        let _ = std::process::Command::new("kill")
            .args(["-KILL", "--", &format!("-{pid}")])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(windows)]
fn kill_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Read a pipe to the end, keeping at most [`OUTPUT_CAP_BYTES`]. The rest is
/// drained so a chatty hook never blocks on a full pipe.
async fn read_capped<R: AsyncRead + Unpin>(pipe: Option<R>) -> String {
    let Some(mut pipe) = pipe else {
        return String::new();
    };
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    let mut truncated = false;
    loop {
        match pipe.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let room = OUTPUT_CAP_BYTES.saturating_sub(kept.len());
                if n > room {
                    truncated = true;
                }
                kept.extend_from_slice(&buf[..n.min(room)]);
            }
        }
    }
    let mut text = String::from_utf8_lossy(&kept).into_owned();
    if truncated {
        text.push_str("\n[output truncated]");
    }
    text
}

/// `hooks.list` view: configured hooks plus the feature flag.
pub fn list_view(state: &AppState) -> Value {
    let settings = state.settings.lock().unwrap();
    json!({
        "enabled": settings.features.hooks.enabled(),
        "hooks": settings.hooks,
    })
}

#[cfg(test)]
mod tests;
