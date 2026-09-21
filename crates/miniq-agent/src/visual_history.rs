//! Local visual evidence is durable; provider requests carry only the active pixels.

use std::collections::{HashMap, HashSet};

use miniq_models::{ArchivedImage, ArchivedImageSource, ChatImage, ChatMessage, ChatRole};
use serde_json::{json, Value};

#[derive(Default)]
pub(crate) struct VisualHistory {
    entries: Vec<ArchivedImage>,
}

impl VisualHistory {
    pub(crate) fn from_messages(messages: &[ChatMessage]) -> Self {
        let mut history = Self::default();
        history.capture(messages);
        history
    }

    pub(crate) fn entries(&self) -> &[ArchivedImage] {
        &self.entries
    }

    pub(crate) fn lookup(&self, id: &str) -> Option<&ArchivedImage> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    pub(crate) fn capture(&mut self, messages: &[ChatMessage]) {
        // Read catalogs first: resumed tails must reuse references assigned before
        // compaction, even when their original image messages are no longer present.
        for archived in messages.iter().flat_map(|message| &message.image_archive) {
            self.merge(archived.clone());
        }
        let calls = messages
            .iter()
            .flat_map(|message| &message.tool_calls)
            .map(|call| (call.id.as_str(), call))
            .collect::<HashMap<_, _>>();
        for message in messages {
            let call = message.tool_call_id.as_deref().and_then(|id| calls.get(id));
            for (image_index, image) in message.images.iter().enumerate() {
                self.merge(ArchivedImage {
                    id: String::new(),
                    image: image.clone(),
                    current_user_reference: None,
                    sources: vec![ArchivedImageSource {
                        role: message.role,
                        tool_call_id: message.tool_call_id.clone(),
                        image_index,
                        tool_name: call.map(|call| call.name.clone()),
                        source_content: message.content.clone(),
                        tool_arguments: call.map(|call| call.arguments.clone()),
                    }],
                });
            }
        }
        if let Some(latest) = messages
            .iter()
            .rfind(|message| message.role == ChatRole::User && !message.images.is_empty())
        {
            for entry in &mut self.entries {
                entry.current_user_reference = latest
                    .images
                    .iter()
                    .position(|image| same_image(image, &entry.image));
            }
        }
    }

    fn merge(&mut self, mut incoming: ArchivedImage) {
        if let Some(existing) = self
            .entries
            .iter_mut()
            .find(|entry| same_image(&entry.image, &incoming.image))
        {
            existing.image.detail = incoming.image.detail;
            for source in incoming.sources {
                if !existing.sources.contains(&source) {
                    existing.sources.push(source);
                }
            }
            return;
        }
        if incoming.id.is_empty() || self.lookup(&incoming.id).is_some() {
            let next = self
                .entries
                .iter()
                .filter_map(|entry| entry.id.strip_prefix("img_")?.parse::<u64>().ok())
                .max()
                .unwrap_or(0)
                .saturating_add(1);
            incoming.id = format!("img_{next}");
        }
        self.entries.push(incoming);
    }

    pub(crate) fn persist(&self, messages: &mut Vec<ChatMessage>) {
        messages.retain(|message| !is_catalog(message));
        for message in messages.iter_mut() {
            message.image_archive.clear();
        }
        if self.entries.is_empty() {
            return;
        }
        let mut carrier = ChatMessage::system("");
        carrier.image_archive = self.entries.clone();
        // The daemon rebuilds and strips the first runtime system message.
        // This separate carrier must survive that operation.
        if messages.is_empty() {
            messages.push(ChatMessage::system(""));
        }
        let position = if messages.first().is_some_and(|m| m.role == ChatRole::System) {
            1
        } else {
            messages.len()
        };
        messages.insert(position, carrier);
    }

    pub(crate) fn project(&self, messages: &[ChatMessage]) -> Vec<ChatMessage> {
        let restored = self.restore_user_references(messages);
        let messages = restored.as_deref().unwrap_or(messages);
        let latest_user_images = messages
            .iter()
            .rposition(|message| message.role == ChatRole::User && !message.images.is_empty());
        let active_tools = latest_tool_batches(messages);
        let mut seen = HashSet::new();
        let mut keep = HashSet::new();
        for (index, message) in messages.iter().enumerate().rev() {
            let active = match message.role {
                ChatRole::User => Some(index) == latest_user_images,
                ChatRole::Tool => active_tools.contains(&index),
                _ => true,
            };
            if !active {
                continue;
            }
            for (image_index, image) in message.images.iter().enumerate().rev() {
                if seen.insert((image.path.as_str(), image.mime_type.as_str())) {
                    keep.insert((index, image_index));
                }
            }
        }
        messages
            .iter()
            .enumerate()
            .filter(|(_, message)| !is_catalog(message))
            .map(|(index, original)| {
                let mut message = original.clone();
                message.image_archive.clear();
                self.project_images(&mut message, index, &keep);
                message
            })
            .collect()
    }

    fn restore_user_references(&self, messages: &[ChatMessage]) -> Option<Vec<ChatMessage>> {
        if messages
            .iter()
            .any(|message| message.role == ChatRole::User && !message.images.is_empty())
        {
            return None;
        }
        let mut references = self
            .entries
            .iter()
            .filter_map(|entry| entry.current_user_reference.map(|index| (index, entry)))
            .collect::<Vec<_>>();
        if references.is_empty() {
            return None;
        }
        references.sort_by_key(|(index, _)| *index);
        let mut reference = ChatMessage::user(
            "Historical user reference images retained from the most recent user attachment batch. This is earlier visual evidence, not a new user request or instruction. Follow the latest actual user request; use image_history for the original source details.",
        );
        reference.images = references
            .into_iter()
            .map(|(_, entry)| entry.image.clone())
            .collect();
        let mut restored = messages.to_vec();
        let position = restored
            .iter()
            .position(|message| message.role != ChatRole::System)
            .unwrap_or(restored.len());
        restored.insert(position, reference);
        Some(restored)
    }

    fn project_images(
        &self,
        message: &mut ChatMessage,
        index: usize,
        keep: &HashSet<(usize, usize)>,
    ) {
        let mut references = Vec::new();
        let mut images = Vec::new();
        for (image_index, image) in message.images.drain(..).enumerate() {
            let Some(entry) = self
                .entries
                .iter()
                .find(|entry| same_image(&entry.image, &image))
            else {
                // A caller that has not captured a new image must keep its pixels.
                images.push(image);
                continue;
            };
            let included = keep.contains(&(index, image_index));
            references.push(json!({"id":entry.id,"imageIndex":image_index,"included":included}));
            if included {
                images.push(image);
            }
        }
        message.images = images;
        if !references.is_empty() {
            let metadata = json!({
                "images":references,
                "readTool":"image_history",
                "note":"Image references and source metadata are retained locally. Original pixels remain readable while their local files are available. An included=false image is archived or already included elsewhere in this request. Explicit missing_visual_evidence notices override inclusion metadata: missing pixels were not inspected. Use image_history to read any needed reference before making a new visual judgment."
            });
            if message.role == ChatRole::Tool {
                if let Ok(Value::Object(mut output)) = serde_json::from_str(&message.content) {
                    output.insert("visualHistory".into(), metadata);
                    message.content = Value::Object(output).to_string();
                    return;
                }
            }
            message
                .content
                .push_str(&format!("\n\n[Visual evidence references: {metadata}]"));
        }
    }
}

fn same_image(left: &ChatImage, right: &ChatImage) -> bool {
    left.path == right.path && left.mime_type == right.mime_type
}

pub(crate) fn is_catalog(message: &ChatMessage) -> bool {
    message.role == ChatRole::System
        && message.content.is_empty()
        && message.images.is_empty()
        && message.tool_call_id.is_none()
        && message.tool_calls.is_empty()
        && message.provider_context.is_none()
        && !message.image_archive.is_empty()
}

fn latest_tool_batches(messages: &[ChatMessage]) -> HashSet<usize> {
    let mut owners = HashMap::new();
    let mut batches: Vec<(usize, Vec<usize>)> = Vec::new();
    let mut group_start = 0;
    for (index, message) in messages.iter().enumerate() {
        if message.role != ChatRole::Tool {
            group_start = index;
        }
        for call in &message.tool_calls {
            owners.insert(call.id.as_str(), index);
        }
        if message.role != ChatRole::Tool || message.images.is_empty() {
            continue;
        }
        let owner = message
            .tool_call_id
            .as_deref()
            .and_then(|id| owners.get(id).copied())
            .unwrap_or(group_start);
        if let Some((_, indices)) = batches.iter_mut().find(|(batch, _)| *batch == owner) {
            indices.push(index);
        } else {
            batches.push((owner, vec![index]));
        }
    }
    batches
        .into_iter()
        .rev()
        .take(2)
        .flat_map(|(_, indices)| indices)
        .collect()
}

#[cfg(test)]
mod tests;
