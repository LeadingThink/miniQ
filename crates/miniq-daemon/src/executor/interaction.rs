use std::time::Duration;

use miniq_agent::AgentError;
use miniq_models::ToolCallRequest;
use miniq_protocol::{Event, SessionStatus};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::SessionToolExecutor;

const UNATTENDED_QUESTION_TIMEOUT_SECS: u64 = 180;

pub(super) fn unattended_default(call: &ToolCallRequest, options: &[String]) -> String {
    call.arguments
        .get("default")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .or_else(|| options.first().cloned())
        .unwrap_or_else(|| {
            "请根据现有上下文选择最合理且可逆的默认方案继续，不要等待用户。".to_string()
        })
}

pub(super) async fn wait_for_question_answer(
    receiver: tokio::sync::oneshot::Receiver<String>,
    cancel: &CancellationToken,
    unattended: Option<(Duration, String)>,
) -> Result<(String, bool), AgentError> {
    if let Some((timeout, default_answer)) = unattended {
        tokio::select! {
            _ = cancel.cancelled() => Err(AgentError::Cancelled),
            answer = receiver => Ok((answer.unwrap_or(default_answer.clone()), false)),
            _ = tokio::time::sleep(timeout) => Ok((default_answer, true)),
        }
    } else {
        tokio::select! {
            _ = cancel.cancelled() => Err(AgentError::Cancelled),
            answer = receiver => Ok((answer.unwrap_or_default(), false)),
        }
    }
}

impl SessionToolExecutor {
    async fn ask_one_question(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
    ) -> Result<Value, AgentError> {
        let prompt = call.arguments["prompt"].as_str().unwrap_or("").to_string();
        if prompt.trim().is_empty() {
            return Ok(json!({"error": "ask_user requires a non-empty prompt"}));
        }
        let options = call
            .arguments
            .get("options")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let unattended = self.state.settings.lock().unwrap().approval_mode
            == crate::state::ApprovalMode::FullAccess;
        let default_answer = unattended.then(|| unattended_default(call, &options));
        let question = self.build_question(call, tool_call_id, options, default_answer.clone());
        let receiver = self.state.register_question(&question);
        self.emit_question(&question);

        let unattended_wait = default_answer.map(|answer| {
            (
                Duration::from_secs(UNATTENDED_QUESTION_TIMEOUT_SECS),
                answer,
            )
        });
        let result = wait_for_question_answer(receiver, &self.cancel, unattended_wait).await;
        let (answer, automatically_continued) = match result {
            Ok(answer) => answer,
            Err(error) => {
                self.state.finish_question(&question.id);
                return Err(error);
            }
        };
        self.resolve_question(&question, &answer, automatically_continued);
        Ok(json!({"answer": answer}))
    }

    fn build_question(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
        options: Vec<String>,
        default_answer: Option<String>,
    ) -> miniq_protocol::Question {
        miniq_protocol::Question {
            id: miniq_memory::new_id("q"),
            session_id: self.session_id.clone(),
            tool_call_id: tool_call_id.to_string(),
            prompt: call.arguments["prompt"].as_str().unwrap_or("").to_string(),
            header: call
                .arguments
                .get("header")
                .and_then(Value::as_str)
                .map(str::to_string),
            options,
            option_descriptions: call
                .arguments
                .get("optionDescriptions")
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default(),
            multi_select: call
                .arguments
                .get("multiSelect")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            created_at: miniq_memory::now_iso(),
            auto_continue_after_seconds: default_answer
                .as_ref()
                .map(|_| UNATTENDED_QUESTION_TIMEOUT_SECS),
            default_answer,
        }
    }

    fn emit_question(&self, question: &miniq_protocol::Question) {
        let _ = self
            .state
            .store
            .update_session_status(&self.session_id, SessionStatus::WaitingApproval);
        self.state.emit(Event::SessionStatusChanged {
            session_id: self.session_id.clone(),
            status: SessionStatus::WaitingApproval,
        });
        self.state.emit(Event::QuestionRequested {
            session_id: self.session_id.clone(),
            question: question.clone(),
        });
        self.audit(
            "question",
            json!({"questionId": question.id, "prompt": question.prompt}),
        );
    }

    fn resolve_question(
        &self,
        question: &miniq_protocol::Question,
        answer: &str,
        automatically_continued: bool,
    ) {
        self.state.finish_question(&question.id);
        self.state.emit(Event::QuestionResolved {
            session_id: self.session_id.clone(),
            question_id: question.id.clone(),
            answer: answer.to_string(),
        });
        if automatically_continued {
            self.audit(
                "question_auto_resolved",
                json!({"questionId": question.id, "answer": answer}),
            );
        }
        let _ = self
            .state
            .store
            .update_session_status(&self.session_id, SessionStatus::Running);
        self.state.emit(Event::SessionStatusChanged {
            session_id: self.session_id.clone(),
            status: SessionStatus::Running,
        });
    }

    pub(super) async fn ask_user(
        &self,
        call: &ToolCallRequest,
        tool_call_id: &str,
    ) -> Result<Value, AgentError> {
        let Some(questions) = call.arguments.get("questions").and_then(Value::as_array) else {
            return self.ask_one_question(call, tool_call_id).await;
        };
        if questions.is_empty() {
            return Ok(json!({"error": "ask_user questions must not be empty"}));
        }

        let mut answers = serde_json::Map::new();
        for (index, arguments) in questions.iter().enumerate() {
            let Some(prompt) = arguments.get("prompt").and_then(Value::as_str) else {
                return Ok(json!({"error": format!("question {index} requires a prompt")}));
            };
            let question_call = ToolCallRequest {
                id: call.id.clone(),
                name: "ask_user".into(),
                arguments: arguments.clone(),
            };
            let output = self.ask_one_question(&question_call, tool_call_id).await?;
            answers.insert(prompt.to_string(), output["answer"].clone());
        }
        Ok(json!({"answers": answers}))
    }
}
