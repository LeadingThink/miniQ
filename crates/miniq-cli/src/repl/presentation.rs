//! Alternate-screen lifecycle and the bridge from session state to widgets.
use super::*;

impl Repl {
    pub fn emit(&mut self, text: &str) {
        self.ui.transcript.notice(text);
    }

    pub fn info(&mut self, text: &str) {
        self.emit(&self.style.dim(&terminal_text(text)));
    }

    pub fn error(&mut self, text: &str) {
        self.emit(&self.style.red(&terminal_text(text)));
    }

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

    fn screen_status(&self) -> screen::Status {
        let process = self.processes.active(&self.session);
        let phase = super::progress::phase(self.progress.as_ref(), &self.phase);
        let card = self.cards.front().map(|card| {
            let choices = match card {
                Card::Approval { .. } => {
                    vec!["Allow once", "This session", "Always allow tool", "Reject"]
                        .into_iter()
                        .map(str::to_owned)
                        .collect()
                }
                Card::Question {
                    options,
                    multi_select,
                    ..
                } => {
                    if *multi_select {
                        options
                            .iter()
                            .enumerate()
                            .map(|(index, option)| {
                                format!(
                                    "{} {option}",
                                    if self.ui.card_checked.contains(&index) {
                                        "☑"
                                    } else {
                                        "☐"
                                    }
                                )
                            })
                            .chain(std::iter::once("Submit selection".into()))
                            .collect()
                    } else {
                        options.clone()
                    }
                }
            };
            let mut body = terminal_text(card.body());
            if let Some(countdown) = card.countdown() {
                body.push_str(&format!("\n{countdown}"));
            }
            (body, choices)
        });
        screen::Status {
            title: terminal_text(&self.statusline.title),
            model: terminal_text(&self.model),
            effort: terminal_text(&self.effort),
            mode: self.mode.clone(),
            cwd: terminal_text(&self.working_directory().display().to_string()),
            running: self.running || process.is_some(),
            phase: terminal_text(if process.is_some() {
                "Running local command"
            } else if self.phase.is_empty() {
                "Thinking"
            } else {
                &phase
            }),
            elapsed: process
                .map(|p| p.started.elapsed())
                .or_else(|| self.started.map(|s| s.elapsed()))
                .unwrap_or_default(),
            context: self.context_percent,
            queue: self.queue.len(),
            files: self
                .files
                .iter()
                .map(|p| terminal_text(&p.display().to_string()))
                .collect(),
            notice: terminal_text(&if self.notice.is_empty() {
                self.pending_labels
                    .values()
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" · ")
            } else {
                self.notice.clone()
            }),
            custom: self.statusline.text().map(|(s, b)| (s.to_owned(), b)),
            card,
            color: self.style.color,
            theme: self.preferences.theme.clone(),
            animations: self.preferences.animations,
        }
    }

    pub(super) fn draw(&mut self, editor: &Editor) -> Result<()> {
        let input = self.status_input();
        self.statusline.poll(input);
        let status = self.screen_status();
        if let Some(terminal) = self.terminal.as_mut() {
            terminal
                .terminal
                .draw(|frame| self.ui.draw(frame, editor, &status))?;
        }
        Ok(())
    }

    pub(super) fn enter_raw(&mut self) -> Result<()> {
        self.terminal = Some(terminal_surface::Surface::enter()?);
        self.keys = Some(EventStream::new());
        Ok(())
    }

    /// Hand the real terminal to external editors or shell management commands.
    pub fn suspend(&mut self) {
        self.keys = None;
        self.terminal = None;
    }

    pub fn resume(&mut self) -> Result<()> {
        if self.terminal.is_none() {
            self.enter_raw()?;
        }
        Ok(())
    }

    pub(super) fn return_from_command(&mut self) -> Result<()> {
        let _ = crate::monitor::line("Press Enter to return to miniQ… ")?;
        self.resume()
    }
}

impl Drop for Repl {
    fn drop(&mut self) {
        self.suspend();
    }
}
