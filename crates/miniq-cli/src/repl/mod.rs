//! Full-screen interactive client for the shared miniQ daemon.
//!
//! Only used when stdin/stdout are terminals and `TERM` is not `dumb`; every other
//! case keeps the line-mode loop in `monitor::interactive`.

mod agent_panel;
mod attachments;
mod cards;
mod connection;
mod dialogs;
mod drafts;
mod events;
mod forms;
mod image_preview;
mod jobs;
mod message_panel;
mod mouse;
mod navigation;
mod panel_actions;
mod panel_keys;
mod panels;
mod picker;
mod platform;
mod presentation;
mod processes;
mod progress;
mod reader;
mod requests;
mod result_views;
mod results;
mod standalone;
mod terminal_surface;
mod theme;
mod tool_view;
pub(crate) use standalone::choose;
#[cfg(test)]
mod interaction_tests;
#[cfg(test)]
mod lifecycle_tests;
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

use std::collections::{BTreeMap, HashMap, VecDeque};
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
        && terminal_capable(std::env::var("TERM").ok().as_deref(), cfg!(windows))
        && !matches!(std::env::var("MINIQ_REPL").as_deref(), Ok("line"))
}

fn terminal_capable(term: Option<&str>, windows: bool) -> bool {
    match term {
        Some("dumb") => false,
        Some(_) => true,
        None => windows,
    }
}

use cards::Card;
pub(crate) use cards::{approval_text, question_answer, question_text};

pub(crate) struct Repl {
    pub session: String,
    pub workspace: Option<String>,
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
    pub preferences: prefs::Prefs,
    pub statusline: statusline::StatusLine,
    jobs: jobs::Jobs,
    pending_labels: BTreeMap<u64, String>,
    drafts: HashMap<String, drafts::Draft>,
    switch_request: Option<u64>,
    refresh_request: Option<u64>,
    snapshot_events: Vec<Value>,
    processes: processes::Processes,
    progress: Option<miniq_protocol::TurnProgress>,
    catalogs: HashMap<picker::Purpose, Value>,
    panel_target: String,
    confirmation: Option<forms::Confirmation>,
    form_retries: HashMap<u64, forms::Form>,
    form_sequence: u64,
    resolving_cards: Vec<Value>,
}

impl Repl {
    fn new(session: &str, options: &crate::args::ChatOptions) -> Self {
        Self {
            session: session.to_owned(),
            workspace: None,
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
            preferences: prefs::Prefs::default(),
            statusline: statusline::StatusLine::new(None),
            jobs: jobs::Jobs::default(),
            pending_labels: BTreeMap::new(),
            drafts: HashMap::new(),
            switch_request: None,
            refresh_request: None,
            snapshot_events: vec![],
            processes: processes::Processes::default(),
            progress: None,
            catalogs: HashMap::new(),
            panel_target: String::new(),
            confirmation: None,
            form_retries: HashMap::new(),
            form_sequence: 0,
            resolving_cards: vec![],
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

    /// Apply a `session.open` snapshot (startup, reconnect, resume, fork).
    pub fn restore(&mut self, snapshot: &Value) {
        self.workspace = snapshot["session"]["workspaceId"]
            .as_str()
            .map(str::to_owned);
        if let Some(path) = snapshot["session"]["workingDirectory"].as_str() {
            self.options.directory = Some(path.into());
        }
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
            .rfind(|message| crate::output::is_answer(message) || message["role"] == "user")
            .filter(|message| crate::output::is_answer(message));
        self.last_answer = last
            .and_then(|message| message["content"].as_str())
            .unwrap_or("")
            .to_owned();
        let status = snapshot["session"]["status"].as_str().unwrap_or("idle");
        let running = !matches!(status, "idle" | "failed");
        if running && !self.running {
            self.started = Some(Instant::now());
        }
        self.running = running;
        self.progress = serde_json::from_value(snapshot["turnProgress"].clone()).ok();
        if let Some(progress) = &self.progress {
            self.phase = progress::label(&progress.phase).into();
        } else if running {
            self.phase = "Thinking".into();
        } else {
            self.phase.clear();
            self.started = None;
        }
        if running {
            if let Some(at) = snapshot["latestTurnTiming"]["timing"]["startedAt"]
                .as_str()
                .or(snapshot["turnProgress"]["startedAt"].as_str())
            {
                self.started = Instant::now().checked_sub(progress::elapsed(at));
            }
        }
        if !running {
            if let Some(reason) = crate::session_outcome::failure(snapshot) {
                self.error(&format!("Execution failed: {reason}"));
            } else if crate::session_outcome::paused(snapshot) {
                self.info("Turn paused. /resume-turn continues it.");
            }
        }
        self.queue = snapshot["queue"].as_array().cloned().unwrap_or_default();
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
    pub async fn send(&mut self, _client: &mut Client, text: &str, steer: bool) -> Result<()> {
        let mut files = self.files.clone();
        for path in mentioned_files(text, &self.working_directory()) {
            if !files.contains(&path) {
                files.push(path);
            }
        }
        crate::sessions::attachments(&files)?;
        self.request(
            "Sending message",
            jobs::Effect::Sent {
                files: files.clone(),
                text: text.into(),
            },
            requests::Request::Send {
                text: text.into(),
                files,
                steer,
            },
        );
        self.files.clear();
        Ok(())
    }

    async fn cancel(&mut self, _client: &mut Client) {
        if self.processes.cancel(&self.session) {
            self.notice = "Interrupting local command…".into();
            return;
        }
        self.rpc(
            "Interrupting",
            jobs::Effect::Notice("Cancellation requested…".into()),
            "session.cancel",
            json!({"sessionId":self.session}),
        );
    }

    async fn cycle_mode(&mut self, _client: &mut Client) {
        let index = MODES
            .iter()
            .position(|m| *m == self.mode)
            .map_or(0, |i| i + 1);
        let mode = MODES[index % MODES.len()];
        self.rpc(
            "Updating permissions",
            jobs::Effect::Permissions,
            "session.approval.update",
            json!({"sessionId":self.session,"mode":mode}),
        );
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
    for mention in attachments::mentions(text) {
        if mention.path.is_empty() {
            continue;
        }
        let exact = root.join(mention.path);
        let candidate = if exact.is_file() {
            exact
        } else {
            root.join(
                mention
                    .path
                    .trim_end_matches([',', '.', ';', ':', ')', '?', '!']),
            )
        };
        if candidate.is_file() && !files.contains(&candidate) {
            files.push(candidate);
        }
    }
    files
}
