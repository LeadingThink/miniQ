use anyhow::Result;
use serde_json::{json, Value};
use std::io::{self, IsTerminal, Write};

pub struct Output {
    pub json: bool,
    pub final_text: String,
}

/// Untrusted model/file text must not inject terminal escape sequences.
pub fn terminal_text(text: &str) -> String {
    text.chars()
        .filter(|ch| !ch.is_control() || matches!(ch, '\n' | '\t'))
        .collect()
}

pub fn progress(text: &str) {
    eprintln!("{}", terminal_text(text));
}

impl Output {
    pub fn new(json: bool) -> Self {
        Self {
            json,
            final_text: String::new(),
        }
    }

    pub fn event(&mut self, event: &Value) -> Result<()> {
        if self.json {
            println!("{}", event);
        }
        let kind = event["type"].as_str().unwrap_or("");
        if kind == "message_created" && event["message"]["role"] == "assistant" {
            self.final_text = event["message"]["content"]
                .as_str()
                .unwrap_or("")
                .to_owned();
        }
        if self.json {
            return Ok(());
        }
        match kind {
            "assistant_delta" => {
                eprint!("{}", terminal_text(event["delta"].as_str().unwrap_or("")));
                io::stderr().flush()?;
            }
            "assistant_replaced" => progress(
                "\n[provider retry: partial stream replaced; final output remains authoritative]",
            ),
            "tool_call_started" => progress(&format!(
                "\n[tool {}] {}",
                event["toolCallId"].as_str().unwrap_or(""),
                event["toolName"].as_str().unwrap_or("")
            )),
            "tool_call_finished" => progress(&format!(
                "[tool {}] {}",
                event["toolCallId"].as_str().unwrap_or(""),
                event["status"].as_str().unwrap_or("")
            )),
            "turn_progress_changed" if event["progress"]["phase"] == "waiting_retry" => {
                progress(&format!("\n[retry] {}", event["progress"]["retry"]))
            }
            "plan_updated" => progress(&format!("\n[plan] {}", event["tasks"])),
            "context_compacted" => progress("\n[context compacted]"),
            "artifact_created" => progress(&format!("\n[artifact] {}", event["artifact"])),
            _ => {}
        }
        Ok(())
    }

    pub fn finish(&self, session: &str, code: u8, error: Option<&str>) {
        if self.json {
            println!(
                "{}",
                json!({"type":"cli_result", "sessionId":session,
                "exitCode":code,"status":if code == 0 {"completed"} else {"incomplete"},
                "text":self.final_text, "error":error})
            );
        } else if code == 0 {
            let text = if io::stdout().is_terminal() {
                terminal_text(&self.final_text)
            } else {
                self.final_text.clone()
            };
            println!("{text}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escape_sequences_cannot_control_the_terminal() {
        assert_eq!(terminal_text("hello\x1b[2J\x07\r\n世界"), "hello[2J\n世界");
    }
    #[test]
    fn authoritative_message_replaces_partial_output() {
        let mut output = Output::new(false);
        output
            .event(
                &json!({"type":"message_created","message":{"role":"assistant","content":"final"}}),
            )
            .unwrap();
        assert_eq!(output.final_text, "final");
    }
}
