//! Pending input shared with the desktop and phone. Resolved cards disappear
//! by ID, and a failed RPC leaves the card available for another attempt.

use anyhow::{bail, Result};
use serde_json::{json, Value};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

use super::Repl;
use crate::{client::Client, output::terminal_text};

#[derive(Clone)]
pub(crate) enum Card {
    Approval {
        id: Value,
    },
    Question {
        id: Value,
        options: Vec<String>,
        multi_select: bool,
        deadline: Option<OffsetDateTime>,
    },
}

impl Card {
    fn id(&self) -> &Value {
        match self {
            Self::Approval { id } | Self::Question { id, .. } => id,
        }
    }

    pub(super) fn countdown(&self) -> Option<String> {
        match self {
            Self::Question {
                deadline: Some(deadline),
                ..
            } => {
                let remaining = (*deadline - OffsetDateTime::now_utc())
                    .whole_seconds()
                    .max(0);
                Some(format!(
                    "default answer in {}:{:02}",
                    remaining / 60,
                    remaining % 60
                ))
            }
            _ => None,
        }
    }
}

pub(crate) fn question_answer(answer: &str, options: &[String], multi: bool) -> Result<String> {
    let answer = answer.trim();
    if answer.is_empty() {
        bail!("enter an answer or select an option");
    }
    let indices = answer
        .split([',', ' ', '\n'])
        .filter(|value| !value.is_empty())
        .map(str::parse::<usize>)
        .collect::<std::result::Result<Vec<_>, _>>();
    let Ok(indices) = indices else {
        return Ok(answer.to_owned());
    };
    if options.is_empty() {
        return Ok(answer.to_owned());
    }
    if !multi && indices.len() > 1 {
        bail!("this question accepts one option; enter one number or a custom answer");
    }
    let mut selected = Vec::new();
    for index in indices {
        let option = index
            .checked_sub(1)
            .and_then(|index| options.get(index))
            .ok_or_else(|| anyhow::anyhow!("option {index} is outside 1..={}", options.len()))?;
        if !selected.contains(option) {
            selected.push(option.clone());
        }
    }
    Ok(selected.join("\n"))
}

pub(crate) fn question_text(question: &Value) -> String {
    let mut text = format!("? {}\n", question["prompt"].as_str().unwrap_or("Question"));
    if let Some(header) = question["header"].as_str() {
        text.insert_str(0, &format!("{header}\n"));
    }
    for (index, option) in question["options"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let label = option.as_str().unwrap_or("");
        text.push_str(&format!("  {}. {label}\n", index + 1));
        if let Some(description) = question["optionDescriptions"][label].as_str() {
            text.push_str(&format!("     {description}\n"));
        }
    }
    if let Some(seconds) = question["autoContinueAfterSeconds"].as_u64() {
        let default = question["defaultAnswer"]
            .as_str()
            .unwrap_or("the default plan");
        text.push_str(&format!(
            "Auto-continue after {seconds}s from creation using: {default}\n"
        ));
    }
    text.push_str(if question["multiSelect"] == true {
        "Enter option numbers separated by commas, or a custom answer."
    } else {
        "Enter an option number, or a custom answer."
    });
    terminal_text(&text)
}

pub(crate) fn approval_text(event: &Value) -> String {
    let approval = &event["approval"];
    let tool = event["toolName"].as_str().unwrap_or("tool");
    let risk = event["riskLevel"]
        .as_str()
        .or(approval["riskLevel"].as_str())
        .unwrap_or("unknown");
    let input = event.get("input").unwrap_or(&Value::Null);
    let reason = approval["reason"].as_str().unwrap_or("");
    terminal_text(&format!("Approval needed: {tool} · risk {risk}\n{reason}\n{}\n1 approve once · 2 approve for session · 3 always allow · 4 reject (y/n)",
        serde_json::to_string_pretty(input).unwrap_or_default()))
}

impl Repl {
    pub(super) fn card(&mut self, event: &Value) {
        let (card, text) = if event["type"] == "approval_requested" {
            let approval = &event["approval"];
            (
                Card::Approval {
                    id: approval["id"].clone(),
                },
                approval_text(event),
            )
        } else {
            let question = &event["question"];
            let deadline = question["createdAt"]
                .as_str()
                .and_then(|created| OffsetDateTime::parse(created, &Rfc3339).ok())
                .zip(question["autoContinueAfterSeconds"].as_i64())
                .and_then(|(created, seconds)| {
                    created.checked_add(time::Duration::seconds(seconds))
                });
            let options = question["options"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            (
                Card::Question {
                    id: question["id"].clone(),
                    options,
                    multi_select: question["multiSelect"] == true,
                    deadline,
                },
                question_text(question),
            )
        };
        if !self.cards.iter().any(|pending| pending.id() == card.id()) {
            self.emit(&text);
            self.cards.push_back(card);
        }
    }

    pub(super) fn resolved_card(&mut self, event: &Value) {
        self.cards
            .retain(|card| match (event["type"].as_str(), card) {
                (Some("approval_resolved"), Card::Approval { id }) => {
                    *id != event["approval"]["id"]
                }
                (Some("question_resolved"), Card::Question { id, .. }) => {
                    *id != event["questionId"]
                }
                _ => true,
            });
    }

    pub(super) async fn resolve(&mut self, client: &mut Client, answer: &str) -> Result<()> {
        let Some(card) = self.cards.front().cloned() else {
            return Ok(());
        };
        let (method, params, notice) = match &card {
            Card::Approval { id } => {
                let decision = match answer {
                    "1" | "y" | "Y" => "approve",
                    "2" => "approve_for_session",
                    "3" => "always_allow_tool",
                    "4" | "n" | "N" => "reject",
                    _ => bail!("select 1, 2, 3 or 4"),
                };
                (
                    "approval.resolve",
                    json!({"approvalId":id,"decision":decision}),
                    decision.replace('_', " "),
                )
            }
            Card::Question {
                id,
                options,
                multi_select,
                ..
            } => {
                let answer = question_answer(answer, options, *multi_select)?;
                (
                    "question.resolve",
                    json!({"questionId":id,"answer":answer}),
                    answer,
                )
            }
        };
        client.call(method, params).await?;
        self.cards.retain(|pending| pending.id() != card.id());
        self.info(&format!("→ {notice}"));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn questions_support_multiple_choices_and_complete_descriptions() {
        let options = vec!["first".into(), "second".into(), "third".into()];
        assert_eq!(
            question_answer("1,3,1", &options, true).unwrap(),
            "first\nthird"
        );
        assert!(question_answer("1,3", &options, false).is_err());
        assert!(question_answer("4", &options, true).is_err());
        assert_eq!(
            question_answer("my own answer", &options, false).unwrap(),
            "my own answer"
        );
        let detail = "完整说明".repeat(200);
        let text = question_text(&json!({"prompt":"choose","options":["first"],
            "optionDescriptions":{"first":detail},"multiSelect":true,
            "autoContinueAfterSeconds":60,"defaultAnswer":"first"}));
        assert!(text.contains(&detail));
        assert!(text.contains("60s") && text.contains("using: first"));
    }

    #[test]
    fn approval_decisions_show_the_complete_reason_risk_and_input() {
        let reason = "需要审批的完整原因".repeat(200);
        let content = "完整命令内容".repeat(500);
        let text = approval_text(&json!({"type":"approval_requested",
            "approval":{"id":"a","riskLevel":"high","reason":reason},
            "toolName":"shell","input":{"command":content}}));
        assert!(text.contains(&reason) && text.contains(&content));
        assert!(text.contains("risk high") && text.contains("shell"));
        assert!(text.contains("always allow") && text.contains("4 reject"));
    }

    #[test]
    fn remote_resolution_removes_only_the_matching_card() {
        let mut repl = Repl::new("s", &Default::default());
        repl.cards.push_back(Card::Approval { id: json!("a") });
        repl.cards.push_back(Card::Approval { id: json!("b") });
        repl.cards.push_back(Card::Question {
            id: json!("q"),
            options: vec![],
            multi_select: false,
            deadline: None,
        });
        repl.resolved_card(&json!({"type":"approval_resolved","approval":{"id":"b"}}));
        assert_eq!(repl.cards.len(), 2);
        assert_eq!(repl.cards.front().unwrap().id(), "a");
        repl.resolved_card(&json!({"type":"question_resolved","questionId":"q"}));
        assert_eq!(repl.cards.len(), 1);
    }
}
