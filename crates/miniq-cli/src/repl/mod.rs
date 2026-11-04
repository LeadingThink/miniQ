//! Full-screen interactive client for the shared miniQ daemon.
//!
//! Only used when stdin/stdout are terminals and `TERM` is not `dumb`; every other
//! case keeps the line-mode loop in `monitor::interactive`.

mod cards;
mod dialogs;
mod events;
mod navigation;
mod picker;
mod presentation;
mod standalone;
mod terminal_surface;
pub(crate) use standalone::choose;
#[cfg(test)]
mod live_preview;
mod runtime;
mod screen;
#[cfg(test)]
mod tests;
mod text;
mod transcript;

pub(crate) use runtime::run;
pub mod commands;
pub mod editor;
pub mod keymap;
pub(crate) mod management;
pub mod prefs;
pub mod render;
pub mod statusline;
pub mod vim;

use std::collections::VecDeque;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::client::Client;
use crate::output::terminal_text;
use editor::{Action, Editor};
use render::Style;

const MODES: [&str; 3] = ["alwaysAsk", "auto", "fullAccess"];
const NOTIFY_AFTER: Duration = Duration::from_secs(10);

/// Whether the rich REPL can drive this terminal.
pub fn supported() -> bool {
    io::stdin().is_terminal()
        && io::stdout().is_terminal()
        && !matches!(std::env::var("TERM").as_deref(), Ok("dumb") | Err(_))
        && !matches!(std::env::var("MINIQ_REPL").as_deref(), Ok("line"))
}

use cards::Card;
pub(crate) use cards::{approval_text, question_answer, question_text};

pub(crate) struct Repl {
    pub session: String,
    pub options: crate::args::ChatOptions,
    pub files: Vec<PathBuf>,
    pub style: Style,
    pub model: String,
    pub effort: String,
    pub mode: String,
    pub running: bool,
    pub started: Option<Instant>,
    pub queue: Vec<Value>,
    pub phase: String,
    pub last_answer: String,
    pub cards: VecDeque<Card>,
    pub notice: String,
    /// Latest `session.contextUsage` percentage, when the daemon reports one.
    pub context_percent: Option<f64>,
    /// Context usage must be re-read once the session is idle.
    pub context_stale: bool,
    history_stale: bool,
    keys: Option<EventStream>,
    terminal: Option<terminal_surface::Surface>,
    ui: screen::Screen,
    last_interrupt: Option<Instant>,
    leader: Option<Instant>,
    /// Directory holding `cli.json` (the daemon data directory).
    pub prefs_dir: PathBuf,
    pub statusline: statusline::StatusLine,
}

impl Repl {
    fn new(session: &str, options: &crate::args::ChatOptions) -> Self {
        Self {
            session: session.to_owned(),
            options: copy_options(options),
            files: options.attachments.clone(),
            style: Style::detect(),
            model: "default".into(),
            effort: "default".into(),
            mode: "alwaysAsk".into(),
            running: false,
            started: None,
            queue: Vec::new(),
            phase: String::new(),
            last_answer: String::new(),
            cards: VecDeque::new(),
            notice: String::new(),
            context_percent: None,
            context_stale: true,
            history_stale: false,
            keys: None,
            terminal: None,
            ui: screen::Screen::default(),
            last_interrupt: None,
            leader: None,
            prefs_dir: PathBuf::new(),
            statusline: statusline::StatusLine::new(None),
        }
    }

    pub fn working_directory(&self) -> PathBuf {
        crate::sessions::working_directory(&self.options)
            .map(PathBuf::from)
            .or_else(|_| std::env::current_dir())
            .unwrap_or_else(|_| PathBuf::from("."))
    }

    /// Reload model and approval mode for the current session.
    pub async fn refresh(&mut self, client: &mut Client) {
        if let Ok(state) = client
            .call("session.modelGet", json!({"sessionId":self.session}))
            .await
        {
            self.model = state["effective"]["model"]
                .as_str()
                .unwrap_or("default")
                .to_owned();
            self.effort = state["effective"]["reasoningEffort"]
                .as_str()
                .unwrap_or("default")
                .to_owned();
        }
        if let Ok(state) = client
            .call("session.approval.get", json!({"sessionId":self.session}))
            .await
        {
            if let Some(mode) = state["effective"].as_str().or(state["mode"].as_str()) {
                self.mode = mode.to_owned();
            }
        }
    }

    /// Re-read the estimated context occupancy (older daemons: silently none).
    pub async fn refresh_context(&mut self, client: &mut Client) {
        self.context_stale = false;
        self.context_percent = client
            .call("session.contextUsage", json!({"sessionId":self.session}))
            .await
            .ok()
            .and_then(|usage| usage["percentUsed"].as_f64());
    }

    /// Apply a `session.open` snapshot (startup, reconnect, resume, fork).
    pub fn restore(&mut self, snapshot: &Value) {
        self.ui.transcript.restore(snapshot);
        self.ui.scroll = None;
        self.ui.plan = snapshot["plan"].clone();
        self.statusline.title = snapshot["session"]["title"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let last = snapshot["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .rfind(|message| message["role"] == "assistant");
        if let Some(message) = last {
            self.last_answer = message["content"].as_str().unwrap_or("").to_owned();
        }
        let status = snapshot["session"]["status"].as_str().unwrap_or("idle");
        let running = !matches!(status, "idle" | "failed");
        if running && !self.running {
            self.started = Some(Instant::now());
        }
        self.running = running;
        if !running {
            if let Some(reason) = crate::session_outcome::failure(snapshot) {
                self.error(&format!("Execution failed: {reason}"));
            } else if crate::session_outcome::paused(snapshot) {
                self.info("Turn paused. /resume-turn continues it.");
            }
        }
        if let Some(queue) = snapshot["queue"].as_array() {
            self.queue = queue.clone();
        }
        self.cards.clear();
        for approval in snapshot["approvals"].as_array().into_iter().flatten() {
            let mut event = approval.clone();
            event["type"] = json!("approval_requested");
            self.card(&event);
        }
        for question in snapshot["questions"].as_array().into_iter().flatten() {
            self.card(&json!({"type":"question_requested","question":question}));
        }
    }

    /// Enter queues a follow-up; Tab explicitly steers the queued message.
    pub async fn send(&mut self, client: &mut Client, text: &str, steer: bool) -> Result<()> {
        let mut files = self.files.clone();
        for path in mentioned_files(text, &self.working_directory()) {
            if !files.contains(&path) {
                files.push(path);
            }
        }
        let outcome = crate::sessions::send_with_policy(
            client,
            &self.session,
            text,
            &files,
            Some(crate::busy_policy::BusyPolicy::Queue),
        )
        .await?;
        match outcome {
            crate::sessions::SendOutcome::Started => {
                self.files.clear();
                self.mark_running();
                self.ui.scroll = None;
            }
            crate::sessions::SendOutcome::Queued { id } => {
                self.files.clear();
                self.mark_running();
                if steer {
                    client
                        .call("session.queueSteer", json!({"queuedMessageId":id}))
                        .await?;
                    self.info("↳ Steering the running turn with this message.");
                } else {
                    self.info(&format!(
                        "↳ Queued as {id}; it runs after the current turn. Tab steers instead."
                    ));
                }
            }
            crate::sessions::SendOutcome::Cancelled => {}
        }
        Ok(())
    }

    async fn cancel(&mut self, client: &mut Client) {
        match client
            .call("session.cancel", json!({"sessionId":self.session}))
            .await
        {
            Ok(_) => self.info("Cancellation requested…"),
            Err(error) => self.error(&format!("{error:#}")),
        }
    }

    async fn cycle_mode(&mut self, client: &mut Client) {
        let index = MODES
            .iter()
            .position(|m| *m == self.mode)
            .map_or(0, |i| i + 1);
        let mode = MODES[index % MODES.len()];
        match client
            .call(
                "session.approval.update",
                json!({"sessionId":self.session,"mode":mode}),
            )
            .await
        {
            Ok(state) => {
                self.mode = state["effective"].as_str().unwrap_or(mode).to_owned();
                self.notice = format!("permissions: {}", self.mode);
            }
            Err(error) => self.error(&format!("{error:#}")),
        }
    }
}

fn copy_options(options: &crate::args::ChatOptions) -> crate::args::ChatOptions {
    crate::args::ChatOptions {
        directory: options.directory.clone(),
        add_dir: options.add_dir.clone(),
        model: None,
        effort: None,
        protocol: options.protocol.clone(),
        attachments: Vec::new(),
        approval: options.approval,
        full_auto: options.full_auto,
        dangerously_bypass_approvals: options.dangerously_bypass_approvals,
        max_turns: options.max_turns,
    }
}

/// `@path` tokens naming existing regular files become attachments (text is kept as-is).
pub fn mentioned_files(text: &str, root: &std::path::Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for token in text.split_whitespace() {
        let Some(path) = token.strip_prefix('@') else {
            continue;
        };
        let path = path.trim_end_matches([',', '.', ';', ':', ')', '?', '!']);
        if path.is_empty() {
            continue;
        }
        let candidate = root.join(path);
        if candidate.is_file() && !files.contains(&candidate) {
            files.push(candidate);
        }
    }
    files
}
