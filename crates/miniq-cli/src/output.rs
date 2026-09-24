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
            "turn_progress_changed" => {
                if let Some(message) = phase_text(&event["progress"]) {
                    progress(&message);
                }
            }
            "plan_updated" => progress(&plan_text(&event["tasks"])),
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

fn phase_text(value: &Value) -> Option<String> {
    let text = match value["phase"].as_str()? {
        "preparing_context" => "Preparing context",
        "compacting_context" => "Compacting context; task continues",
        "requesting_model" => "Waiting for model",
        "finalizing" => "Saving result",
        "waiting_retry" => {
            let retry = &value["retry"];
            return Some(format!(
                "\n[retry {}/{}] Waiting {} seconds before retrying",
                retry["attempt"],
                retry["maxAttempts"],
                retry["delayMs"].as_u64().unwrap_or(0).div_ceil(1000)
            ));
        }
        // Streaming text already shows progress; avoid printing between deltas.
        _ => return None,
    };
    Some(match value["modelStep"].as_u64() {
        Some(step) => format!("\n[step {step}] {text}"),
        None => format!("\n[{text}]"),
    })
}

fn plan_text(tasks: &Value) -> String {
    let mut text = String::from("\n[plan]");
    for task in tasks.as_array().into_iter().flatten() {
        let marker = match task["status"].as_str() {
            Some("completed") => "x",
            Some("in_progress") => ">",
            _ => " ",
        };
        text.push_str(&format!(
            "\n  [{marker}] {}",
            task["content"].as_str().unwrap_or("")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn progress_distinguishes_work_retry_and_streaming_without_losing_plan_content() {
        let tasks = json!([
            {"status":"completed","content":"Read files"},
            {"status":"in_progress","content":"Compare every candidate"},
            {"status":"pending","content":"Write report"}
        ]);
        assert_eq!(
            plan_text(&tasks),
            "\n[plan]\n  [x] Read files\n  [>] Compare every candidate\n  [ ] Write report"
        );
        assert_eq!(phase_text(&json!({"phase":"waiting_retry","retry":{"attempt":2,"maxAttempts":10,"delayMs":1500}})).unwrap(),
            "\n[retry 2/10] Waiting 2 seconds before retrying");
        assert!(phase_text(&json!({"phase":"receiving_model"})).is_none());
    }
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
