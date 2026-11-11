//! Daemon events update the interactive session and transcript.
use super::*;

impl Repl {
    /// Render one daemon event. Returns true when a reconnect is required.
    pub(super) fn event(&mut self, event: &Value) -> bool {
        let style = self.style;
        self.ui.transcript.event(event);
        match event["type"].as_str().unwrap_or("") {
            "remote_resync" => return true,
            "assistant_delta" => {
                self.mark_running();
                self.progress = None;
                self.phase = "Responding".into();
            }
            "message_created" if event["message"]["role"] == "assistant" => {
                if crate::output::is_answer(&event["message"]) {
                    self.last_answer = event["message"]["content"]
                        .as_str()
                        .unwrap_or("")
                        .to_owned();
                }
            }
            "tool_call_started" => {
                self.mark_running();
                self.progress = None;
                self.phase = format!(
                    "Running {}",
                    terminal_text(event["toolName"].as_str().unwrap_or("tool"))
                );
            }
            "tool_call_finished" => self.phase = "Thinking".into(),
            "approval_requested" | "question_requested" => {
                self.card(event);
                let _ = io::stdout().write_all(b"\x07");
            }
            "approval_resolved" | "question_resolved" => self.resolved_card(event),
            "plan_updated" => {
                self.ui.plan = event["tasks"].clone();
                let text = render::plan(&event["tasks"], style);
                self.emit(&text);
            }
            "turn_progress_changed" => {
                let progress = &event["progress"];
                self.progress = serde_json::from_value(progress.clone()).ok();
                if let Some(progress) = &self.progress {
                    self.phase = progress::label(&progress.phase).into();
                }
            }
            "context_compacted" => {
                let before = event["estimatedTokensBefore"].as_u64().unwrap_or(0);
                let after = event["estimatedTokensAfter"].as_u64().unwrap_or(0);
                self.info(&format!("[context compacted: ~{before} → ~{after} tokens]"));
                self.context_stale = true;
            }
            "session_rewritten" | "session_restored" => {
                self.context_stale = true;
                self.history_stale = true;
            }
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
                self.statusline.title = title;
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
                } else if matches!(status, "idle" | "failed") {
                    self.running = false;
                    self.phase.clear();
                    self.progress = None;
                }
            }
            "turn_completed" => {
                let elapsed = self.started.map(|s| s.elapsed()).unwrap_or_default();
                let line = render::turn_summary(event.get("summary"), elapsed, style);
                self.emit(&line);
                self.finish_turn(elapsed, "completed");
            }
            "turn_failed" => {
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

    pub(super) fn mark_running(&mut self) {
        if !self.running {
            self.running = true;
            self.started = Some(Instant::now());
            self.phase = "Thinking".into();
        }
    }

    pub(super) fn finish_turn(&mut self, elapsed: Duration, status: &str) {
        self.context_stale = true;
        self.running = false;
        self.started = None;
        self.phase.clear();
        self.progress = None;
        self.cards.clear();
        if elapsed >= NOTIFY_AFTER {
            // Bell plus OSC 9 desktop notification (ignored by terminals without support).
            let _ = write!(io::stdout(), "\x07\x1b]9;miniQ: turn {status}\x07");
            let _ = io::stdout().flush();
        }
    }
}
