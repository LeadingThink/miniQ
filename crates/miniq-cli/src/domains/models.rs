//! Shapes still private to daemon gateway modules. Business validation stays in the daemon.
#![allow(dead_code)] // These models validate input; the original JSON is sent without losing fields.
use miniq_protocol::ScheduledTaskMode;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScheduleContent {
    name: String,
    prompt: String,
    schedule: Value,
    #[serde(default)]
    mode: ScheduledTaskMode,
    #[serde(default)]
    target_session_id: Option<String>,
    #[serde(default)]
    memory: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScheduleCreate {
    workspace_id: String,
    #[serde(flatten)]
    content: ScheduleContent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ScheduleUpdate {
    id: String,
    #[serde(default)]
    workspace_id: Option<String>,
    #[serde(flatten)]
    content: ScheduleContent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillCreate {
    goal: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    deadline_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillDistill {
    session_id: String,
    #[serde(default)]
    deadline_ms: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillRefine {
    name: String,
    #[serde(flatten)]
    source: SkillDistill,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SkillSave {
    content: String,
    #[serde(default)]
    force: bool,
}

#[derive(Deserialize)]
pub(super) struct SkillContent {
    content: String,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub(super) enum SkillJob {
    Create(SkillCreate),
    Distill(SkillDistill),
    Refine(SkillRefine),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Transcribe {
    audio_base64: String,
    #[serde(default = "default_filename")]
    filename: String,
    #[serde(default)]
    preview: bool,
    #[serde(default)]
    transcribe_model: Option<String>,
}

fn default_filename() -> String {
    "record.wav".into()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Speak {
    text: String,
    #[serde(default)]
    voice: Option<String>,
    #[serde(default)]
    response_format: Option<String>,
}
