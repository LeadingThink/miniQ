use super::*;
use miniq_models::{ApiProtocol, ImageDetail, ProviderContext, ToolCallRequest};
use serde_json::{json, Value};

fn image(name: &str) -> ChatImage {
    ChatImage {
        path: format!("/private/observations/{name}.png"),
        mime_type: "image/png".into(),
        detail: ImageDetail::High,
    }
}

fn user(content: &str, names: &[&str]) -> ChatMessage {
    let mut message = ChatMessage::user(content);
    message.images = names.iter().map(|name| image(name)).collect();
    message
}

fn tool_batch(history: &mut Vec<ChatMessage>, name: &str, counts: &[usize]) {
    let mut assistant = ChatMessage::assistant("inspect evidence");
    assistant.tool_calls = counts
        .iter()
        .enumerate()
        .map(|(index, _)| ToolCallRequest {
            id: format!("{name}_{index}"),
            name: "view_pdf".into(),
            arguments: json!({"path":format!("{name}_{index}.pdf")}),
        })
        .collect();
    let calls = assistant.tool_calls.clone();
    history.push(assistant);
    for (index, count) in counts.iter().enumerate() {
        let mut result = ChatMessage::tool_result(
            calls[index].id.clone(),
            json!({"path":format!("{name}_{index}.pdf"),"pageCount":count}).to_string(),
        );
        result.images = (0..*count)
            .map(|page| image(&format!("{name}_{index}_{page}")))
            .collect();
        history.push(result);
    }
}

fn image_count(messages: &[ChatMessage]) -> usize {
    messages.iter().map(|message| message.images.len()).sum()
}

#[test]
fn retains_two_complete_tool_batches_and_latest_user_attachment_batch() {
    let mut messages = vec![
        ChatMessage::system("runtime"),
        user("old reference", &["old_1", "old_2"]),
        user("current reference", &["user_1", "user_2", "user_3"]),
    ];
    tool_batch(&mut messages, "old", &[2, 3]);
    tool_batch(&mut messages, "recent", &[2, 2, 1]);
    tool_batch(&mut messages, "latest", &[10]);
    messages.push(ChatMessage::user("Continue comparing the references"));
    let catalog = VisualHistory::from_messages(&messages);
    let before = serde_json::to_value(&messages).unwrap();
    let projected = catalog.project(&messages);
    assert_eq!(image_count(&projected), 18);
    assert_eq!(catalog.entries().len(), 25);
    assert!(projected[1].images.is_empty());
    assert_eq!(projected[2].images.len(), 3);
    assert_eq!(projected[4].images.len(), 0);
    assert!(projected[1].content.contains("img_1"));
    assert_eq!(serde_json::to_value(&messages).unwrap(), before);
    assert_eq!(
        serde_json::to_value(catalog.project(&messages)).unwrap(),
        serde_json::to_value(&projected).unwrap()
    );
}

#[test]
fn catalog_survives_compaction_restart_and_repeated_persistence() {
    let mut messages = vec![ChatMessage::system("runtime"), user("one", &["one"])];
    let mut catalog = VisualHistory::from_messages(&messages);
    catalog.persist(&mut messages);
    catalog.persist(&mut messages);
    assert_eq!(
        messages
            .iter()
            .filter(|message| is_catalog(message))
            .count(),
        1
    );
    assert!(is_catalog(&messages[1]));
    let mut compacted = vec![
        messages[0].clone(),
        messages[1].clone(),
        ChatMessage::system("summary"),
        user("two", &["two", "three"]),
    ];
    catalog.capture(&compacted);
    catalog.persist(&mut compacted);
    let encoded = serde_json::to_string(&compacted).unwrap();
    let decoded: Vec<ChatMessage> = serde_json::from_str(&encoded).unwrap();
    let resumed = VisualHistory::from_messages(&decoded);
    assert_eq!(resumed.entries().len(), 3);
    for (index, name) in ["one", "two", "three"].iter().enumerate() {
        assert_eq!(
            resumed.lookup(&format!("img_{}", index + 1)).unwrap().image,
            image(name)
        );
    }
    assert!(resumed
        .project(&decoded)
        .iter()
        .all(|message| message.image_archive.is_empty()));
    assert!(resumed.lookup("img_1").unwrap().sources[0].source_content == "one");
}

#[test]
fn one_image_reference_keeps_distinct_lossless_sources_and_latest_detail() {
    let first = user("reference", &["same"]);
    let mut later = ChatMessage::tool_result("tool", "complete metadata including page 37");
    later.images.push(image("same"));
    later.images[0].detail = ImageDetail::Auto;
    let mut assistant = ChatMessage::assistant("");
    assistant.tool_calls.push(ToolCallRequest {
        id: "tool".into(),
        name: "view_image".into(),
        arguments: json!({"path":"/workspace/source.png"}),
    });
    let messages = vec![first, assistant, later];
    let mut catalog = VisualHistory::from_messages(&messages);
    catalog.capture(&messages);
    assert_eq!(catalog.entries().len(), 1);
    let entry = catalog.lookup("img_1").unwrap();
    assert_eq!(entry.image.detail, ImageDetail::Auto);
    assert_eq!(entry.sources.len(), 2);
    assert_eq!(entry.sources[1].tool_name.as_deref(), Some("view_image"));
    assert_eq!(
        entry.sources[1].tool_arguments,
        Some(json!({"path":"/workspace/source.png"}))
    );
    assert_eq!(
        entry.sources[1].source_content,
        "complete metadata including page 37"
    );
}

#[test]
fn projection_keeps_native_context_and_uncatalogued_pixels_unchanged() {
    let mut messages = vec![user("reference", &["reference"])];
    tool_batch(&mut messages, "old", &[1]);
    messages[1].provider_context = Some(ProviderContext {
        protocol: ApiProtocol::Responses,
        data: json!([{"type":"reasoning","encrypted_content":"signed-original"}]),
    });
    tool_batch(&mut messages, "second", &[1]);
    tool_batch(&mut messages, "third", &[1]);
    let catalog = VisualHistory::from_messages(&messages);
    messages[2].images.push(image("not-captured"));
    let projected = catalog.project(&messages);
    assert_eq!(projected[1].provider_context, messages[1].provider_context);
    assert_eq!(projected[2].images, vec![image("not-captured")]);
    assert_eq!(projected[0].images, messages[0].images);
}

#[test]
fn old_checkpoints_deserialize_without_archive_fields() {
    let message: ChatMessage = serde_json::from_value(json!({
        "role":"user", "content":"legacy", "images":[{
            "path":"/local/image.png", "mime_type":"image/png"
        }]
    }))
    .unwrap();
    assert!(message.image_archive.is_empty());
    let mut messages = vec![ChatMessage::system("runtime"), message];
    let catalog = VisualHistory::from_messages(&messages);
    catalog.persist(&mut messages);
    let outgoing: Value = serde_json::to_value(catalog.project(&messages)).unwrap();
    assert!(!outgoing.to_string().contains("image_archive"));
}

#[test]
fn compacted_user_references_restore_the_latest_whole_batch_in_its_original_order() {
    let mut messages = vec![
        ChatMessage::system("runtime"),
        user("old", &["a", "b", "c"]),
        user("compare first against second", &["b", "a"]),
    ];
    let catalog = VisualHistory::from_messages(&messages);
    catalog.persist(&mut messages);
    let compacted = vec![
        messages[0].clone(),
        messages[1].clone(),
        ChatMessage::system("summary of the task"),
        ChatMessage::user("continue the task"),
    ];
    let resumed = VisualHistory::from_messages(&compacted);
    let projected = resumed.project(&compacted);
    assert_eq!(projected[2].images, vec![image("b"), image("a")]);
    assert!(projected[2].content.contains("not a new user request"));
    assert_eq!(projected[3].content, "continue the task");
    assert!(resumed
        .lookup("img_3")
        .unwrap()
        .current_user_reference
        .is_none());
    assert_eq!(resumed.entries().len(), 3);
}

#[test]
fn active_duplicates_are_sent_once_with_reference_annotations_on_all_occurrences() {
    let mut messages = vec![ChatMessage::system("runtime"), user("source", &["same"])];
    let mut first = ChatMessage::tool_result("one", r#"{"kind":"inspection"}"#);
    first.images = vec![image("same"), image("different")];
    let mut last = ChatMessage::tool_result("two", r#"{"kind":"inspection"}"#);
    last.images = vec![image("same")];
    messages.extend([first, last]);
    let catalog = VisualHistory::from_messages(&messages);
    let projected = catalog.project(&messages);
    assert_eq!(image_count(&projected), 2);
    assert!(projected[1].images.is_empty());
    assert_eq!(projected[2].images, vec![image("different")]);
    assert_eq!(projected[3].images, vec![image("same")]);
    for message in &projected[1..] {
        assert!(message.content.contains("img_1"));
    }
}

#[test]
fn computer_metadata_stays_valid_json_when_old_pixels_are_archived() {
    let mut messages = vec![ChatMessage::system("runtime")];
    tool_batch(&mut messages, "first", &[1]);
    messages[2].content = json!({
        "observationId":"observation-1",
        "screenshot":{"id":"observation-1","width":800,"height":600},
        "action":"snapshot"
    })
    .to_string();
    tool_batch(&mut messages, "second", &[1]);
    tool_batch(&mut messages, "third", &[1]);
    let catalog = VisualHistory::from_messages(&messages);
    let projected = catalog.project(&messages);
    let output: Value = serde_json::from_str(&projected[2].content).unwrap();
    assert_eq!(output["observationId"], "observation-1");
    assert_eq!(output["screenshot"]["id"], "observation-1");
    assert_eq!(output["visualHistory"]["images"][0]["included"], false);
    assert!(projected[2].images.is_empty());
    let latest: Value = serde_json::from_str(&projected[6].content).unwrap();
    assert_eq!(latest["visualHistory"]["images"][0]["included"], true);
    assert_eq!(latest["visualHistory"]["images"][0]["id"], "img_3");
}
