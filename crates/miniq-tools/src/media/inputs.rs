use schemars::JsonSchema;
use serde::Deserialize;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ImageInput {
    pub(super) prompt: String,
    #[serde(default)]
    pub(super) model: Option<String>,
    /// Accepted for compatibility. The Codex image route uses prompt guidance
    /// for composition and size, so this value is added to the prompt.
    #[serde(default)]
    pub(super) size: Option<String>,
    /// Accepted for compatibility. The Codex image route does not apply this
    /// as a wire parameter; describe the requested quality in the prompt.
    #[serde(default)]
    pub(super) quality: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct EditInput {
    pub(super) prompt: String,
    pub(super) image_path: String,
    #[serde(default)]
    pub(super) model: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct VideoInput {
    pub(super) prompt: String,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) duration: Option<u32>,
    #[serde(default)]
    pub(super) resolution: Option<String>,
    #[serde(default)]
    pub(super) aspect_ratio: Option<String>,
    #[serde(default)]
    pub(super) image_path: Option<String>,
    #[serde(default)]
    #[schemars(length(max = 7))]
    pub(super) reference_images: Option<Vec<String>>,
    #[serde(default)]
    #[schemars(length(max = 3))]
    pub(super) reference_videos: Option<Vec<String>>,
    #[serde(default)]
    #[schemars(length(max = 3))]
    pub(super) reference_audios: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct SpeechInput {
    pub(super) input: String,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) voice: Option<String>,
    #[serde(default)]
    pub(super) response_format: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct TranscribeInput {
    pub(super) path: String,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) language: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct MusicInput {
    #[serde(default)]
    pub(super) prompt: String,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) mode: Option<String>,
    #[serde(default)]
    pub(super) instrumental: bool,
    #[serde(default)]
    pub(super) style: Option<String>,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) negative_style: Option<String>,
    #[serde(default)]
    pub(super) vocal_gender: Option<String>,
    #[serde(default)]
    pub(super) style_weight: Option<f64>,
    #[serde(default)]
    pub(super) weirdness: Option<f64>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct MusicGenerationQueryInput {
    /// A clip identifier returned in the `clips` array from `generate_music`.
    #[schemars(regex(pattern = r"^[A-Za-z0-9_-]+$"))]
    pub(super) clip_id: String,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct VideoGenerationQueryInput {
    /// The `request_id` returned by `generate_video`.
    #[schemars(regex(pattern = r"^[A-Za-z0-9_-]+$"))]
    pub(super) request_id: String,
    /// The model returned by generate_video. Saved H3 tasks restore it when omitted.
    #[serde(default)]
    pub(super) model: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct MusicClipsQueryInput {
    /// Up to 20 clip identifiers returned by `generate_music`.
    #[schemars(length(min = 1, max = 20))]
    pub(super) clip_ids: Vec<String>,
}
