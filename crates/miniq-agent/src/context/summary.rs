use futures_util::StreamExt;
use miniq_models::{ChatDelta, ChatMessage, CompletionRequest, ModelProvider, ProviderError};
use tokio_util::sync::CancellationToken;

use crate::{retry::ModelRetries, AgentError, AgentEvent};

pub(super) async fn summarize_batch(
    provider: &dyn ModelProvider,
    messages: &[ChatMessage],
    max_model_retries: usize,
    events: &tokio::sync::mpsc::Sender<AgentEvent>,
    cancel: &CancellationToken,
) -> Result<String, AgentError> {
    let transcript = serde_json::to_string(messages)
        .map_err(|error| ProviderError::InvalidResponse(error.to_string()))?;
    let request = CompletionRequest {
        messages: vec![
            ChatMessage::system(
                "Compress the conversation into a precise working-memory handoff. Preserve user goals, decisions, constraints, file paths, commands, errors, completed work, pending work, and facts needed to continue. Omit pleasantries and repeated tool output. Do not invent anything.",
            ),
            ChatMessage::user(transcript),
        ],
        tools: Vec::new(),
        // Thinking models may reject explicit temperatures other than 1.
        temperature: None,
        max_output_tokens: None,
    };
    let mut retries = ModelRetries::new(max_model_retries);
    loop {
        if retries.attempts > 0 {
            let _ = events
                .send(AgentEvent::ModelRequestStarted { step: 0 })
                .await;
        }
        let stream = tokio::select! {
            _ = cancel.cancelled() => return Err(AgentError::Cancelled),
            stream = provider.stream_complete(request.clone()) => stream,
        };
        let mut stream = match stream {
            Ok(stream) => stream,
            Err(error) => {
                if retries.wait(&error, 0, events, cancel).await? {
                    continue;
                }
                return Err(error.into());
            }
        };
        let mut summary = String::new();
        let mut saw_context = false;
        let error = loop {
            let delta = tokio::select! {
                _ = cancel.cancelled() => return Err(AgentError::Cancelled),
                delta = stream.next() => delta,
            };
            match delta {
                Some(Ok(ChatDelta::Text(text))) => summary.push_str(&text),
                Some(Ok(ChatDelta::Context(_))) => saw_context = true,
                Some(Ok(ChatDelta::ToolCall(_))) => {
                    return Err(ProviderError::InvalidResponse(
                        "context compaction attempted a tool call".into(),
                    )
                    .into())
                }
                Some(Err(error)) => break error,
                Some(Ok(ChatDelta::Finished)) | None => {
                    if !summary.trim().is_empty() {
                        return Ok(summary);
                    }
                    break ProviderError::EmptyResponse;
                }
            }
        };
        if !summary.is_empty() || saw_context || !retries.wait(&error, 0, events, cancel).await? {
            return Err(error.into());
        }
    }
}
