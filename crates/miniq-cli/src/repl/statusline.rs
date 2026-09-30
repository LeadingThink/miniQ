//! User-configurable status line: runs `statusLine.command` from `cli.json` in a
//! background thread and caches its first output line.

use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::prefs::StatusLineConfig;

/// Minimum time between two runs when the inputs have not changed.
const REFRESH: Duration = Duration::from_secs(1);
/// Upper bound on the amount of output kept from the command.
const MAX_OUTPUT: u64 = 64 * 1024;
const MAX_WIDTH_CHARS: usize = 512;

/// Snapshot of REPL state passed to the command as JSON on stdin.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StatusInput {
    pub session_id: String,
    pub session_title: String,
    pub model: String,
    pub effort: String,
    pub approval_mode: String,
    pub cwd: String,
    pub queue_length: usize,
    pub attachments: usize,
    pub running: bool,
}

impl StatusInput {
    pub fn to_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "sessionTitle": self.session_title,
            "model": self.model,
            "effort": self.effort,
            "approvalMode": self.approval_mode,
            "cwd": self.cwd,
            "queueLength": self.queue_length,
            "attachments": self.attachments,
            "running": self.running,
        })
    }
}

type Outcome = Result<String, String>;

/// Cached state of the custom status line.
#[derive(Debug)]
pub struct StatusLine {
    config: Option<StatusLineConfig>,
    pub title: String,
    input: Option<StatusInput>,
    started: Option<Instant>,
    pending: Option<Receiver<Outcome>>,
    /// Latest successful output (already sanitized, may be empty).
    pub output: Option<String>,
    /// Error of the latest run, if it failed.
    pub error: Option<String>,
    pub finished: Option<Instant>,
}

impl StatusLine {
    pub fn new(config: Option<StatusLineConfig>) -> Self {
        Self {
            config,
            title: String::new(),
            input: None,
            started: None,
            pending: None,
            output: None,
            error: None,
            finished: None,
        }
    }

    pub fn config(&self) -> Option<&StatusLineConfig> {
        self.config.as_ref()
    }

    /// Text to show, if the command is configured and its last run succeeded
    /// with non-empty output. `true` in the pair means "replace the built-in line".
    pub fn text(&self) -> Option<(&str, bool)> {
        let config = self.config.as_ref()?;
        if self.error.is_some() {
            return None;
        }
        let text = self.output.as_deref().filter(|t| !t.is_empty())?;
        Some((text, config.replace))
    }

    /// Collect a finished run and start a new one when due. Returns true when the
    /// displayed text may have changed (caller should redraw).
    pub fn poll(&mut self, input: StatusInput) -> bool {
        let Some(config) = self.config.clone() else {
            return false;
        };
        let mut changed = false;
        if let Some(receiver) = &self.pending {
            match receiver.try_recv() {
                Ok(outcome) => {
                    self.pending = None;
                    self.finished = Some(Instant::now());
                    let before = (self.output.clone(), self.error.clone());
                    match outcome {
                        Ok(line) => {
                            self.output = Some(line);
                            self.error = None;
                        }
                        Err(error) => self.error = Some(error),
                    }
                    changed = before != (self.output.clone(), self.error.clone());
                }
                Err(TryRecvError::Empty) => return false,
                Err(TryRecvError::Disconnected) => {
                    self.pending = None;
                    self.error = Some("status line worker exited".into());
                    changed = true;
                }
            }
        }
        let due = self.input.as_ref() != Some(&input)
            || self.started.is_none_or(|at| at.elapsed() >= REFRESH);
        if due && self.pending.is_none() {
            let payload = input.to_json().to_string();
            self.input = Some(input);
            self.started = Some(Instant::now());
            self.pending = Some(spawn(config, payload));
        }
        changed
    }

    /// Human-readable report for `/statusline`.
    pub fn describe(&self, config_path: &std::path::Path) -> String {
        let Some(config) = &self.config else {
            return format!(
                "no status line command configured\nset statusLine.command in {}",
                config_path.display()
            );
        };
        let mut out = format!(
            "command: {}\ntimeout: {} ms · {}\nconfig: {}\n",
            config.command,
            config.timeout_ms,
            if config.replace {
                "replaces the built-in line"
            } else {
                "appended to the built-in line"
            },
            config_path.display()
        );
        match (&self.error, &self.output) {
            (Some(error), _) => out.push_str(&format!("last error: {error}")),
            (None, Some(output)) if output.is_empty() => out.push_str("last result: (empty)"),
            (None, Some(output)) => out.push_str(&format!("last result: {output}")),
            (None, None) if self.pending.is_some() => out.push_str("running…"),
            (None, None) => out.push_str("not run yet"),
        }
        out
    }
}

fn spawn(config: StatusLineConfig, payload: String) -> Receiver<Outcome> {
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let _ = sender.send(run(&config, &payload));
    });
    receiver
}

fn shell(command: &str) -> Command {
    if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(command);
        cmd
    } else {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(command);
        cmd
    }
}

/// Run the command with `payload` on stdin; return its sanitized first line.
pub fn run(config: &StatusLineConfig, payload: &str) -> Outcome {
    let timeout = Duration::from_millis(config.timeout_ms);
    let deadline = Instant::now() + timeout;
    let mut child = shell(&config.command)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to start: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        let payload = payload.to_owned();
        // Written from a thread so a command that never reads stdin cannot block us.
        thread::spawn(move || {
            let _ = stdin.write_all(payload.as_bytes());
        });
    }
    let (line_tx, line_rx) = mpsc::channel();
    if let Some(stdout) = child.stdout.take() {
        thread::spawn(move || {
            let mut line = Vec::new();
            let mut reader = BufReader::new(stdout.take(MAX_OUTPUT));
            let result = reader
                .read_until(b'\n', &mut line)
                .map(|_| String::from_utf8_lossy(&line).into_owned());
            let _ = line_tx.send(result);
            // Keep draining so a command that prints more lines does not die
            // with SIGPIPE (and fail) once we have what we need.
            let _ = std::io::copy(&mut reader.into_inner().into_inner(), &mut std::io::sink());
        });
    }
    let (err_tx, err_rx) = mpsc::channel();
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let mut text = String::new();
            let mut limited = stderr.take(MAX_OUTPUT);
            let _ = limited.read_to_string(&mut text);
            let _ = std::io::copy(&mut limited.into_inner(), &mut std::io::sink());
            let _ = err_tx.send(text);
        });
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("timed out after {} ms", config.timeout_ms));
            }
            Ok(None) => thread::sleep(Duration::from_millis(10)),
            Err(error) => return Err(format!("wait failed: {error}")),
        }
    };
    let remaining = deadline
        .saturating_duration_since(Instant::now())
        .max(Duration::from_millis(50));
    if !status.success() {
        let stderr = err_rx.recv_timeout(remaining).unwrap_or_default();
        let detail = sanitize(stderr.lines().find(|l| !l.trim().is_empty()).unwrap_or(""));
        return Err(if detail.is_empty() {
            format!("exited with {status}")
        } else {
            format!("exited with {status}: {detail}")
        });
    }
    match line_rx.recv_timeout(remaining) {
        Ok(Ok(line)) => Ok(sanitize(&line)),
        Ok(Err(error)) => Err(format!("reading output failed: {error}")),
        Err(_) => Err("output not closed in time".into()),
    }
}

/// Keep one line of printable text: drops control chars (including ANSI escape
/// introducers) and trims surrounding whitespace.
pub fn sanitize(text: &str) -> String {
    let line = text.split(['\n', '\r']).next().unwrap_or("");
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // Skip a CSI/OSC sequence body rather than leaving `[31m` behind.
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for c in chars.by_ref() {
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(c) = chars.next() {
                        if c == '\u{7}' || (c == '\u{1b}' && chars.next_if_eq(&'\\').is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            }
            continue;
        }
        if c == '\t' {
            out.push(' ');
        } else if !c.is_control() {
            out.push(c);
        }
    }
    out.trim().chars().take(MAX_WIDTH_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(command: &str, timeout_ms: u64) -> StatusLineConfig {
        StatusLineConfig {
            command: command.into(),
            timeout_ms,
            replace: false,
        }
    }

    #[test]
    fn sanitize_strips_controls_and_escapes() {
        assert_eq!(sanitize("  hi\tthere \n second"), "hi there");
        assert_eq!(sanitize("\u{1b}[31mred\u{1b}[0m\u{7}!"), "red!");
        assert_eq!(sanitize("\u{1b}]0;title\u{7}ok"), "ok");
        assert_eq!(sanitize("a\rb"), "a");
        assert_eq!(sanitize(""), "");
    }

    #[test]
    fn status_input_json_shape() {
        let input = StatusInput {
            session_id: "s1".into(),
            queue_length: 2,
            running: true,
            ..StatusInput::default()
        };
        let value = input.to_json();
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["queueLength"], 2);
        assert_eq!(value["running"], true);
        for key in [
            "sessionTitle",
            "model",
            "effort",
            "approvalMode",
            "cwd",
            "attachments",
        ] {
            assert!(value.get(key).is_some(), "{key}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn runs_command_with_stdin_json() {
        let result = run(
            &config("read line; echo \"got $line\"; echo second", 5000),
            "{\"a\":1}",
        );
        assert_eq!(result.unwrap(), "got {\"a\":1}");
    }

    #[cfg(unix)]
    #[test]
    fn long_output_after_first_line_is_not_a_failure() {
        // More than a pipe buffer after the first line: closing stdout early
        // used to kill the command with SIGPIPE.
        let result = run(&config("echo first; head -c 200000 /dev/zero", 5000), "{}");
        assert_eq!(result.unwrap(), "first");
    }

    #[cfg(unix)]
    #[test]
    fn failures_and_timeouts_are_errors() {
        let error = run(&config("echo boom >&2; exit 3", 5000), "{}").unwrap_err();
        assert!(error.contains("boom"), "{error}");
        let error = run(&config("sleep 5", 100), "{}").unwrap_err();
        assert!(error.contains("timed out"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn poll_caches_and_throttles() {
        let mut line = StatusLine::new(Some(config("echo hello", 5000)));
        assert!(line.text().is_none());
        let input = StatusInput::default();
        line.poll(input.clone());
        let deadline = Instant::now() + Duration::from_secs(5);
        while line.output.is_none() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
            line.poll(input.clone());
        }
        assert_eq!(line.text(), Some(("hello", false)));
        // Unchanged inputs within a second do not start another run.
        line.poll(input.clone());
        assert!(line.pending.is_none());
        // Changed inputs do.
        line.poll(StatusInput {
            running: true,
            ..input
        });
        assert!(line.pending.is_some());
    }

    #[test]
    fn unconfigured_is_inert() {
        let mut line = StatusLine::new(None);
        assert!(!line.poll(StatusInput::default()));
        assert!(line.text().is_none());
        assert!(line
            .describe(std::path::Path::new("/x/cli.json"))
            .contains("no status line"));
    }
}
