//! Rich interactive terminal (inline editor, streaming Markdown, cards, status bar).
//!
//! Only used when stdin/stdout are terminals and `TERM` is not `dumb`; every other
//! case keeps the line-mode loop in `monitor::interactive`.

pub mod commands;
pub mod editor;
pub mod keymap;
pub mod prefs;
pub mod render;
pub mod statusline;
pub mod vim;

use std::collections::{HashMap, VecDeque};
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::Result;
use crossterm::event::{
    DisableBracketedPaste, EnableBracketedPaste, Event, EventStream, KeyCode, KeyEvent,
    KeyEventKind, KeyModifiers,
};
use crossterm::{cursor, queue, terminal};
use futures_util::StreamExt;
use serde_json::{json, Value};
use unicode_width::UnicodeWidthStr;

use crate::client::Client;
use crate::output::terminal_text;
use editor::{Action, Editor};
use render::{Markdown, Style};

pub const PROMPT: &str = "miniq> ";
const MODES: [&str; 3] = ["alwaysAsk", "auto", "fullAccess"];
const NOTIFY_AFTER: Duration = Duration::from_secs(10);

/// Whether the rich REPL can drive this terminal.
pub fn supported() -> bool {
    io::stdin().is_terminal()
        && io::stdout().is_terminal()
        && !matches!(std::env::var("TERM").as_deref(), Ok("dumb") | Err(_))
        && !matches!(std::env::var("MINIQ_REPL").as_deref(), Ok("line"))
}

/// A pending approval or question that the user must answer.
pub(crate) enum Card {
    Approval { id: Value },
    Question { id: Value, options: Vec<String> },
}

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
    markdown: Markdown,
    streamed: String,
    tools: HashMap<String, String>,
    keys: Option<EventStream>,
    /// Physical rows between the top of the prompt area and the cursor, when drawn.
    drawn: Option<usize>,
    raw: bool,
    last_interrupt: Option<Instant>,
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
            markdown: Markdown::default(),
            streamed: String::new(),
            tools: HashMap::new(),
            keys: None,
            drawn: None,
            raw: false,
            last_interrupt: None,
            prefs_dir: PathBuf::new(),
            statusline: statusline::StatusLine::new(None),
        }
    }

    /// Print text above the prompt area. `\n` is translated for raw mode.
    pub fn emit(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.hide();
        let mut out = io::stdout();
        let text = if self.raw {
            text.replace('\n', "\r\n")
        } else {
            text.to_owned()
        };
        let _ = out.write_all(text.as_bytes());
        if !text.ends_with('\n') {
            let _ = out.write_all(if self.raw { b"\r\n" } else { b"\n" });
        }
        let _ = out.flush();
    }

    /// Print a dim informational line.
    pub fn info(&mut self, text: &str) {
        let line = self.style.dim(&terminal_text(text));
        self.emit(&line);
    }

    pub fn error(&mut self, text: &str) {
        let line = self.style.red(&terminal_text(text));
        self.emit(&line);
    }

    fn hide(&mut self) {
        if let Some(rows) = self.drawn.take() {
            let mut out = io::stdout();
            let _ = queue!(out, cursor::MoveToColumn(0));
            if rows > 0 {
                let _ = queue!(out, cursor::MoveUp(rows as u16));
            }
            let _ = queue!(out, terminal::Clear(terminal::ClearType::FromCursorDown));
            let _ = out.flush();
        }
    }

    fn prompt(&self) -> &'static str {
        match self.cards.front() {
            Some(Card::Approval { .. }) => "approve [1-4]> ",
            Some(Card::Question { .. }) => "answer> ",
            None => PROMPT,
        }
    }

    fn status_line(&self, editor: &Editor) -> String {
        let mut parts = vec![
            self.model.clone(),
            format!("effort {}", self.effort),
            self.mode.clone(),
        ];
        if let Some(percent) = self.context_percent {
            parts.push(format!("ctx {percent:.0}%"));
        }
        if !self.files.is_empty() {
            parts.push(format!("{} attachment(s)", self.files.len()));
        }
        if !self.queue.is_empty() {
            parts.push(format!("{} queued", self.queue.len()));
        }
        if self.running {
            let elapsed = self.started.map(|s| s.elapsed()).unwrap_or_default();
            let phase = if self.phase.is_empty() {
                "working"
            } else {
                &self.phase
            };
            parts.push(format!(
                "{phase} {}s · Esc to interrupt · Enter queues · Tab steers",
                elapsed.as_secs()
            ));
        } else if editor.searching() {
            parts.push("Ctrl+R next match · Esc cancel".into());
        } else if !self.notice.is_empty() {
            parts.push(self.notice.clone());
        } else {
            parts.push("/ commands · @ files · ! shell · Shift+Tab mode".into());
        }
        if let Some((text, replace)) = self.statusline.text() {
            if replace {
                // Keep the transient hint (last part), drop the built-in fields.
                let hint = parts.pop().unwrap_or_default();
                parts = vec![text.to_owned(), hint];
            } else {
                parts.push(text.to_owned());
            }
        }
        if let Some(indicator) = editor.mode_indicator() {
            parts.insert(0, indicator.to_owned());
        }
        parts.join(" · ")
    }

    /// Inputs passed to the custom status line command.
    fn status_input(&self) -> statusline::StatusInput {
        statusline::StatusInput {
            session_id: self.session.clone(),
            session_title: self.statusline.title.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            approval_mode: self.mode.clone(),
            cwd: self.working_directory().display().to_string(),
            queue_length: self.queue.len(),
            attachments: self.files.len(),
            running: self.running,
        }
    }

    /// Draw prompt, completion menu and status bar below the scrollback.
    fn draw(&mut self, editor: &Editor) {
        if !self.raw {
            return;
        }
        let input = self.status_input();
        self.statusline.poll(input);
        self.hide();
        let columns = terminal::size()
            .map(|(c, _)| c.max(10) as usize)
            .unwrap_or(80);
        let view = editor.view(self.prompt());
        let rows_of = |line: &str| UnicodeWidthStr::width(line).max(1).div_ceil(columns);
        let mut out = String::new();
        let mut total = 0usize;
        let mut cursor_row = 0usize;
        let mut cursor_col = 0usize;
        for (index, line) in view.lines.iter().enumerate() {
            if index == view.cursor.0 {
                cursor_row = total + view.cursor.1 / columns;
                cursor_col = view.cursor.1 % columns;
            }
            total += rows_of(line);
            if index > 0 {
                out.push_str("\r\n");
            }
            out.push_str(&terminal_text(line));
        }
        let mut extra = Vec::new();
        if let Some(menu) = &editor.menu {
            for (index, (item, description)) in menu.items.iter().enumerate().take(8) {
                let text = render::truncate(&format!("  {item}  {description}"), columns - 1);
                extra.push(if index == menu.selected {
                    self.style.cyan(&text)
                } else {
                    self.style.dim(&text)
                });
            }
        }
        extra.push(self.style.dim(&render::truncate(
            &terminal_text(&self.status_line(editor)),
            columns - 1,
        )));
        for line in &extra {
            out.push_str("\r\n");
            out.push_str(line);
            total += 1;
        }
        let mut stdout = io::stdout();
        let _ = stdout.write_all(out.as_bytes());
        let up = total.saturating_sub(1).saturating_sub(cursor_row);
        if up > 0 {
            let _ = queue!(stdout, cursor::MoveUp(up as u16));
        }
        let _ = queue!(stdout, cursor::MoveToColumn(cursor_col as u16));
        let _ = stdout.flush();
        self.drawn = Some(cursor_row);
    }

    fn enter_raw(&mut self) -> Result<()> {
        terminal::enable_raw_mode()?;
        let _ = crossterm::execute!(io::stdout(), EnableBracketedPaste);
        self.raw = true;
        self.keys = Some(EventStream::new());
        Ok(())
    }

    /// Leave raw mode (and stop reading keys) before rustyline, pickers or child processes.
    pub fn suspend(&mut self) {
        self.hide();
        self.keys = None;
        if self.raw {
            let _ = crossterm::execute!(io::stdout(), DisableBracketedPaste);
            let _ = terminal::disable_raw_mode();
            self.raw = false;
        }
    }

    pub fn resume(&mut self) -> Result<()> {
        if !self.raw {
            self.enter_raw()?;
        }
        Ok(())
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

    fn card(&mut self, event: &Value) {
        let style = self.style;
        if event["type"] == "approval_requested" {
            let approval = &event["approval"];
            let tool = event["toolName"]
                .as_str()
                .or(approval["toolName"].as_str())
                .unwrap_or("tool");
            let input = if event["input"].is_null() {
                &approval["input"]
            } else {
                &event["input"]
            };
            let risk = event["riskLevel"]
                .as_str()
                .or(approval["riskLevel"].as_str())
                .unwrap_or("unknown");
            let mut text = format!(
                "{} {}\n",
                style.yellow("╭ Approval needed"),
                style.dim(&format!("· risk {}", terminal_text(risk)))
            );
            text.push_str(&format!(
                "{} {}\n",
                style.yellow("│"),
                style.bold(&terminal_text(&render::tool_request(tool, input)))
            ));
            let detail = serde_json::to_string_pretty(input).unwrap_or_default();
            for line in detail.lines().take(8) {
                text.push_str(&format!(
                    "{} {}\n",
                    style.yellow("│"),
                    style.dim(&render::truncate(&terminal_text(line), 160))
                ));
            }
            text.push_str(&format!(
                "{} 1 approve once · 2 approve for session · 3 always allow {} · 4 reject (y/n)",
                style.yellow("╰"),
                terminal_text(tool)
            ));
            self.emit(&text);
            self.cards.push_back(Card::Approval {
                id: approval["id"].clone(),
            });
        } else {
            let question = &event["question"];
            let mut text = format!(
                "{} {}\n",
                style.magenta("? "),
                style.bold(&terminal_text(
                    question["prompt"].as_str().unwrap_or("Question")
                ))
            );
            let options: Vec<String> = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|option| {
                    option
                        .as_str()
                        .or(option["label"].as_str())
                        .unwrap_or("")
                        .to_owned()
                })
                .collect();
            for (index, option) in options.iter().enumerate() {
                text.push_str(&format!("  {}. {}\n", index + 1, terminal_text(option)));
            }
            text.push_str(&style.dim("Type an answer (or an option number) and press Enter."));
            self.emit(&text);
            self.cards.push_back(Card::Question {
                id: question["id"].clone(),
                options,
            });
        }
    }

    fn flush_markdown(&mut self) {
        let rest = self.markdown.finish(self.style);
        self.emit(&rest);
    }

    /// Render one daemon event. Returns true when a reconnect is required.
    fn event(&mut self, event: &Value) -> bool {
        let style = self.style;
        match event["type"].as_str().unwrap_or("") {
            "remote_resync" => return true,
            "assistant_delta" => {
                self.mark_running();
                let delta = event["delta"].as_str().unwrap_or("");
                self.streamed.push_str(delta);
                let lines = self.markdown.push(delta, style);
                self.emit(&lines);
            }
            "assistant_replaced" => {
                self.markdown = Markdown::default();
                if !self.streamed.is_empty() {
                    self.info("[provider retry: partial stream replaced]");
                }
                self.streamed.clear();
            }
            "message_created" if event["message"]["role"] == "assistant" => {
                let content = event["message"]["content"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let rest = match content.strip_prefix(self.streamed.as_str()) {
                    Some(rest) => rest.to_owned(),
                    None => {
                        self.markdown = Markdown::default();
                        content.clone()
                    }
                };
                let lines = self.markdown.push(&rest, style);
                self.emit(&lines);
                self.flush_markdown();
                self.streamed.clear();
                self.last_answer = content;
            }
            "tool_call_started" => {
                self.mark_running();
                self.flush_markdown();
                let name = event["toolName"].as_str().unwrap_or("tool");
                let id = event["toolCallId"].as_str().unwrap_or("").to_owned();
                self.tools.insert(id, name.to_owned());
                let line = render::tool_started(name, &event["input"], style);
                self.phase = format!("running {}", terminal_text(name));
                self.emit(&line);
            }
            "tool_call_finished" => {
                let id = event["toolCallId"].as_str().unwrap_or("");
                self.tools.remove(id);
                let line = render::tool_finished(
                    event["status"].as_str().unwrap_or("completed"),
                    event.get("output"),
                    6,
                    style,
                );
                self.phase = "thinking".into();
                self.emit(&line);
            }
            "approval_requested" | "question_requested" => {
                self.flush_markdown();
                self.card(event);
                let _ = io::stdout().write_all(b"\x07");
            }
            "plan_updated" => {
                let text = render::plan(&event["tasks"], style);
                self.emit(&text);
            }
            "turn_progress_changed" => {
                let progress = &event["progress"];
                if let Some(phase) = progress["phase"].as_str().or(progress.as_str()) {
                    self.phase = terminal_text(phase);
                }
            }
            "context_compacted" => {
                let before = event["estimatedTokensBefore"].as_u64().unwrap_or(0);
                let after = event["estimatedTokensAfter"].as_u64().unwrap_or(0);
                self.info(&format!("[context compacted: ~{before} → ~{after} tokens]"));
                self.context_stale = true;
            }
            "session_rewritten" => self.context_stale = true,
            "artifact_created" => {
                let name = event["artifact"]["name"]
                    .as_str()
                    .or(event["artifact"]["path"].as_str())
                    .unwrap_or("artifact")
                    .to_owned();
                self.info(&format!("[artifact] {name}"));
            }
            "queue_changed" => {
                self.queue = event["queue"].as_array().cloned().unwrap_or_default();
            }
            "session_renamed" => {
                let title = event["title"]
                    .as_str()
                    .or(event["session"]["title"].as_str())
                    .unwrap_or("")
                    .to_owned();
                self.info(&format!("Session renamed: {title}"));
            }
            "session_approval_changed" => {
                if let Some(mode) = event["effective"].as_str().or(event["mode"].as_str()) {
                    self.mode = mode.to_owned();
                }
            }
            "session_status_changed" => {
                let status = event["status"]
                    .as_str()
                    .or(event["session"]["status"].as_str())
                    .unwrap_or("");
                if status == "running" {
                    self.mark_running();
                }
            }
            "turn_completed" => {
                self.flush_markdown();
                let elapsed = self.started.map(|s| s.elapsed()).unwrap_or_default();
                let line = render::turn_summary(event.get("summary"), elapsed, style);
                self.emit(&line);
                self.finish_turn(elapsed, "completed");
            }
            "turn_failed" => {
                self.flush_markdown();
                let elapsed = self.started.map(|s| s.elapsed()).unwrap_or_default();
                let error = event["error"].as_str().unwrap_or("task failed");
                if error == "cancelled" {
                    self.info("Interrupted. What should miniQ do instead?");
                } else {
                    self.error(&format!("✗ {error}"));
                }
                self.finish_turn(elapsed, "failed");
            }
            _ => {}
        }
        false
    }

    fn mark_running(&mut self) {
        if !self.running {
            self.running = true;
            self.started = Some(Instant::now());
            self.phase = "thinking".into();
        }
    }

    fn finish_turn(&mut self, elapsed: Duration, status: &str) {
        self.context_stale = true;
        self.running = false;
        self.started = None;
        self.phase.clear();
        self.cards.clear();
        self.streamed.clear();
        self.tools.clear();
        if elapsed >= NOTIFY_AFTER {
            // Bell plus OSC 9 desktop notification (ignored by terminals without support).
            let _ = write!(io::stdout(), "\x07\x1b]9;miniQ: turn {status}\x07");
            let _ = io::stdout().flush();
        }
    }

    /// Send a user message; while a turn runs it is queued (and optionally steered).
    pub async fn send(&mut self, client: &mut Client, text: &str, steer: bool) -> Result<()> {
        let mut files = self.files.clone();
        for path in mentioned_files(text, &self.working_directory()) {
            if !files.contains(&path) {
                files.push(path);
            }
        }
        if !self.running {
            crate::sessions::send(client, &self.session, text, &files).await?;
            self.files.clear();
            self.mark_running();
            self.markdown = Markdown::default();
            self.streamed.clear();
            return Ok(());
        }
        let mut params = json!({"sessionId":self.session, "rejectIfBusy":false,
            "message":{"role":"user","content":text,
            "attachments":crate::sessions::attachments(&files)?}});
        if let Some(limit) = client.max_turns {
            params["maxTurns"] = json!(limit);
        }
        let result = client.call("session.sendMessage", params).await?;
        self.files.clear();
        let queued = [
            &result["queued"]["id"],
            &result["queuedMessage"]["id"],
            &result["queued"],
            &result["queuedMessageId"],
        ]
        .into_iter()
        .find_map(|v| v.as_str().map(str::to_owned));
        match (steer, queued) {
            (true, Some(id)) => {
                client
                    .call("session.queueSteer", json!({"queuedMessageId":id}))
                    .await?;
                self.info("↳ Steering the running turn with this message.");
            }
            (true, None) => {
                self.info("↳ Sent; the daemon did not report a queued message to steer.")
            }
            (false, _) => self.info(&format!(
                "↳ Queued; it runs after the current turn ({} queued). Tab steers instead.",
                self.queue.len() + 1
            )),
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

    async fn resolve(&mut self, client: &mut Client, answer: &str) -> Result<()> {
        let Some(card) = self.cards.pop_front() else {
            return Ok(());
        };
        match card {
            Card::Approval { id } => {
                let decision = match answer {
                    "1" | "y" | "Y" => "approve",
                    "2" => "approve_for_session",
                    "3" => "always_allow_tool",
                    _ => "reject",
                };
                client
                    .call(
                        "approval.resolve",
                        json!({"approvalId":id,"decision":decision}),
                    )
                    .await?;
                self.info(&format!("→ {}", decision.replace('_', " ")));
            }
            Card::Question { id, options } => {
                let answer = answer
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .and_then(|n| options.get(n.wrapping_sub(1)).cloned())
                    .unwrap_or_else(|| answer.to_owned());
                client
                    .call("question.resolve", json!({"questionId":id,"answer":answer}))
                    .await?;
                self.info(&format!("→ {answer}"));
            }
        }
        Ok(())
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

fn history_path(client: &Client) -> Option<PathBuf> {
    if std::env::var_os("MINIQ_NO_HISTORY").is_some_and(|v| !v.is_empty() && v != "0") {
        return None;
    }
    Some(client.directory.join("cli_history"))
}

enum Input {
    Terminal(Option<io::Result<Event>>),
    Daemon(Result<Value>),
    Tick,
}

async fn next_key(keys: &mut Option<EventStream>) -> Option<io::Result<Event>> {
    match keys {
        Some(keys) => keys.next().await,
        None => std::future::pending().await,
    }
}

struct Restore;

impl Drop for Restore {
    fn drop(&mut self) {
        let _ = crossterm::execute!(io::stdout(), DisableBracketedPaste);
        let _ = terminal::disable_raw_mode();
    }
}

pub async fn run(
    client: &mut Client,
    session: &str,
    initial: Option<String>,
    options: &crate::args::ChatOptions,
) -> Result<u8> {
    let mut repl = Repl::new(session, options);
    let style = repl.style;
    let prefs = prefs::Prefs::load_reporting(&client.directory);
    let (keymap, warnings) = keymap::Keymap::new(&prefs.keybindings);
    for warning in warnings {
        eprintln!("miniq: warning: {warning}");
    }
    repl.prefs_dir = client.directory.clone();
    repl.statusline = statusline::StatusLine::new(prefs.status_line.clone());
    repl.refresh(client).await;
    println!(
        "{} {}\n{}",
        style.bold(&format!("miniQ {}", env!("CARGO_PKG_VERSION"))),
        style.dim(&format!("· Session: {session} · {}", repl.working_directory().display())),
        style.dim(&format!(
            "Model: {} · reasoning: {} · permissions: {}\n/help for commands · Esc interrupts · Ctrl+C twice exits · later: miniq resume {session}",
            terminal_text(&repl.model),
            terminal_text(&repl.effort),
            repl.mode
        ))
    );
    let snapshot = client
        .call("session.open", json!({"sessionId":session}))
        .await?;
    let _restore = Restore;
    repl.enter_raw()?;
    repl.restore(&snapshot);
    if let Some(title) = snapshot["session"]["title"].as_str() {
        repl.statusline.title = title.to_owned();
    }
    if repl.running {
        repl.info("This session is already running; following its output.");
    }
    let root = repl.working_directory();
    let mut editor = Editor::new(commands::list(), root)
        .with_history(history_path(client))
        .with_keymap(keymap);
    editor.set_vim(prefs.editor_mode == prefs::EditorMode::Vim);
    if let Some(prompt) = initial {
        if let Some(code) = submit(&mut repl, &mut editor, client, prompt).await? {
            repl.suspend();
            return Ok(code);
        }
    }
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let code = loop {
        repl.draw(&editor);
        let input = tokio::select! {
            key = next_key(&mut repl.keys) => Input::Terminal(key),
            event = client.next_event() => Input::Daemon(event),
            _ = tick.tick(), if repl.running || repl.statusline.config().is_some() => Input::Tick,
        };
        let flow = match input {
            Input::Tick => None,
            Input::Terminal(None) | Input::Terminal(Some(Err(_))) => Some(0),
            Input::Terminal(Some(Ok(event))) => {
                terminal_event(&mut repl, &mut editor, client, event).await?
            }
            Input::Daemon(event) => {
                let resync = match &event {
                    Ok(event) => repl.event(event),
                    Err(_) => true,
                };
                if resync {
                    repl.info("Reconnecting to the same session; no prompt will be resent.");
                    let snapshot = client.reconnect(&repl.session).await?;
                    repl.restore(&snapshot);
                }
                None
            }
        };
        if let Some(code) = flow {
            break code;
        }
        if repl.context_stale && !repl.running {
            repl.refresh_context(client).await;
        }
    };
    repl.hide();
    repl.suspend();
    println!(
        "{}",
        style.dim(&format!(
            "Session kept. Continue with: miniq resume {}",
            repl.session
        ))
    );
    Ok(code)
}

async fn terminal_event(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    event: Event,
) -> Result<Option<u8>> {
    match event {
        Event::Paste(text) => {
            editor.insert(&text);
            Ok(None)
        }
        Event::Resize(..) => {
            repl.drawn = None;
            let _ = queue!(
                io::stdout(),
                cursor::MoveToColumn(0),
                terminal::Clear(terminal::ClearType::FromCursorDown)
            );
            Ok(None)
        }
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            key_event(repl, editor, client, key).await
        }
        _ => Ok(None),
    }
}

async fn key_event(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    mut key: KeyEvent,
) -> Result<Option<u8>> {
    // In raw mode a bare LF (scripts, some terminals) arrives as Ctrl+J: treat it as Enter
    // unless the user rebound Ctrl+J.
    if key.code == KeyCode::Char('j')
        && key.modifiers == KeyModifiers::CONTROL
        && editor.keymap().lookup(&key) == Some(keymap::Command::Submit)
    {
        key = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    }
    repl.notice.clear();
    if matches!(repl.cards.front(), Some(Card::Approval { .. })) && editor.is_empty() {
        if let KeyCode::Char(c @ ('1' | '2' | '3' | '4' | 'y' | 'Y' | 'n' | 'N')) = key.code {
            if let Err(error) = repl.resolve(client, &c.to_string()).await {
                repl.error(&format!("{error:#}"));
            }
            return Ok(None);
        }
    }
    if key.code != KeyCode::Char('c') || !key.modifiers.contains(KeyModifiers::CONTROL) {
        repl.last_interrupt = None;
    }
    match editor.key(key) {
        Action::Redraw => Ok(None),
        Action::Submit(text) => {
            if repl
                .cards
                .front()
                .is_some_and(|c| matches!(c, Card::Question { .. }))
            {
                editor.remember(&text);
                if let Err(error) = repl.resolve(client, &text).await {
                    repl.error(&format!("{error:#}"));
                }
                return Ok(None);
            }
            submit(repl, editor, client, text).await
        }
        Action::Tab => {
            let text = editor.buffer().to_owned();
            if repl.running && !text.trim().is_empty() {
                editor.remember(&text);
                editor.clear();
                echo(repl, &text);
                if let Err(error) = repl.send(client, &text, true).await {
                    repl.error(&format!("{error:#}"));
                }
            }
            Ok(None)
        }
        Action::BackTab => {
            repl.cycle_mode(client).await;
            Ok(None)
        }
        Action::Escape => {
            if repl.running {
                repl.cancel(client).await;
            }
            Ok(None)
        }
        Action::Interrupt => {
            if repl.running {
                repl.cancel(client).await;
            } else if !editor.is_empty() {
                editor.clear();
            } else if repl
                .last_interrupt
                .is_some_and(|at| at.elapsed() < Duration::from_secs(2))
            {
                return Ok(Some(0));
            } else {
                repl.last_interrupt = Some(Instant::now());
                repl.notice = "Press Ctrl+C again to exit".into();
            }
            Ok(None)
        }
        Action::Eof => Ok(Some(0)),
        Action::ClearScreen => {
            repl.drawn = None;
            let _ = queue!(
                io::stdout(),
                terminal::Clear(terminal::ClearType::All),
                cursor::MoveTo(0, 0)
            );
            Ok(None)
        }
        Action::External => {
            match external_editor(repl, editor.buffer()) {
                Ok(text) => editor.set_buffer(&text),
                Err(error) => repl.error(&format!("{error:#}")),
            }
            Ok(None)
        }
    }
}

/// Echo a submitted prompt into the scrollback.
fn echo(repl: &mut Repl, text: &str) {
    let style = repl.style;
    let mut out = String::new();
    for (index, line) in text.split('\n').enumerate() {
        let lead = if index == 0 { "› " } else { "  " };
        out.push_str(&style.bold(&format!("{lead}{}", terminal_text(line))));
        out.push('\n');
    }
    repl.emit(&out);
}

async fn submit(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    text: String,
) -> Result<Option<u8>> {
    let trimmed = text.trim();
    if trimmed.is_empty() && repl.files.is_empty() {
        return Ok(None);
    }
    editor.remember(&text);
    echo(repl, &text);
    if let Some(command) = trimmed.strip_prefix('!') {
        shell(repl, command.trim());
        return Ok(None);
    }
    if trimmed.starts_with('/') {
        return match commands::run(repl, editor, client, trimmed).await {
            Ok(flow) => Ok(flow),
            Err(error) => {
                let _ = repl.resume();
                repl.error(&format!("{error:#}"));
                Ok(None)
            }
        };
    }
    if let Err(error) = repl.send(client, &text, false).await {
        repl.error(&format!("{error:#}"));
    }
    Ok(None)
}

/// `!cmd` runs locally in the working directory; output stays on screen and is not sent.
fn shell(repl: &mut Repl, command: &str) {
    if command.is_empty() {
        repl.info("Usage: !COMMAND runs a local shell command (not sent to the model).");
        return;
    }
    repl.suspend();
    let status = std::process::Command::new(std::env::var("SHELL").unwrap_or_else(|_| "sh".into()))
        .arg("-c")
        .arg(command)
        .current_dir(repl.working_directory())
        .status();
    let _ = repl.resume();
    match status {
        Ok(status) if status.success() => {}
        Ok(status) => repl.error(&format!("exit status {}", status.code().unwrap_or(-1))),
        Err(error) => repl.error(&format!("{error}")),
    }
}

fn external_editor(repl: &mut Repl, text: &str) -> Result<String> {
    let path = std::env::temp_dir().join(format!("miniq-prompt-{}.md", std::process::id()));
    std::fs::write(&path, text)?;
    let editor = std::env::var("VISUAL")
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| "vi".into());
    repl.suspend();
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(format!("{editor} \"$1\""))
        .arg("sh")
        .arg(&path)
        .status();
    let _ = repl.resume();
    let result = std::fs::read_to_string(&path);
    let _ = std::fs::remove_file(&path);
    if !status?.success() {
        anyhow::bail!("editor exited with an error; prompt unchanged");
    }
    Ok(result?.trim_end_matches('\n').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_attach_existing_files_only() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        let files = mentioned_files("look at @a.rs, @src/ and @missing.md @a.rs", dir.path());
        assert_eq!(files, vec![dir.path().join("a.rs")]);
    }

    #[test]
    fn card_prompts_replace_the_default_prompt() {
        let mut repl = Repl::new("s", &Default::default());
        repl.style = Style::plain();
        assert_eq!(repl.prompt(), PROMPT);
        repl.cards.push_back(Card::Approval { id: json!("a") });
        assert!(repl.prompt().starts_with("approve"));
    }

    #[test]
    fn streamed_answer_is_not_printed_twice() {
        let mut repl = Repl::new("s", &Default::default());
        repl.style = Style::plain();
        repl.event(&json!({"type":"assistant_delta","delta":"hello "}));
        assert_eq!(repl.streamed, "hello ");
        repl.event(&json!({"type":"message_created","message":{"role":"assistant","content":"hello world"}}));
        assert_eq!(repl.last_answer, "hello world");
        assert!(repl.streamed.is_empty());
        repl.event(&json!({"type":"turn_completed"}));
        assert!(!repl.running);
    }
}
