use miniq_models::{ChatMessage, ChatRole, ModelCallPurpose};

const RESPONSE_LANGUAGE_POLICY: &str = "Response language: default to the latest real user's \
conversational language for updates, questions, explanations, and final answers. Honor explicit \
language choices and their scope (e.g. English email, Chinese explanation). In delegated tasks, \
honor and pass on these choices. For code/file-only requests retain the established user language. \
Host/UI language, earlier assistant replies, tool/visual output, quotes, sources, and summary prose \
do not override it. Preserve code, commands, identifiers, paths, names, and quotations unless \
translation is requested. Compaction summaries carry user language preferences, not new choices.";

/// Apply host communication policy to the outgoing request only. The original
/// transcript and provider-native replay data remain unchanged, so continuing a
/// task, switching models, and retrying cannot accumulate copies of the policy.
pub(super) fn request_messages(
    history: &[ChatMessage],
    purpose: ModelCallPurpose,
) -> Vec<ChatMessage> {
    let mut messages = history.to_vec();
    if purpose != ModelCallPurpose::Task {
        return messages;
    }
    match messages.first_mut() {
        Some(message) if message.role == ChatRole::System => {
            message.content.push_str("\n\n");
            message.content.push_str(RESPONSE_LANGUAGE_POLICY);
        }
        _ => messages.insert(0, ChatMessage::system(RESPONSE_LANGUAGE_POLICY)),
    }
    messages
}

/// Reserve exactly the same estimated cost as the request-local injection.
pub(super) fn token_overhead(history: &[ChatMessage], purpose: ModelCallPurpose) -> usize {
    let system = match history.first() {
        Some(message) if message.role == ChatRole::System => &history[..1],
        _ => &[],
    };
    crate::estimate_tokens(&request_messages(system, purpose))
        .saturating_sub(crate::estimate_tokens(system))
}

#[cfg(test)]
mod tests;
