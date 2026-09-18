use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{router::parse_input, ToolError};

#[derive(Clone, Copy, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Action {
    Open,
    Navigate,
    Snapshot,
    Screenshot,
    Status,
    CurrentUrl,
    Tabs,
    NewTab,
    SwitchTab,
    CloseTab,
    Click,
    DoubleClick,
    Move,
    Drag,
    Type,
    Press,
    Scroll,
    Select,
    Back,
    Forward,
    Reload,
    Stop,
    SetVisible,
    Resize,
    Wait,
    Close,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BrowserInput {
    pub action: Action,
    /// Attach visual evidence to the model. Leave false for text-only models;
    /// action=screenshot always attaches the image. The UI can preview either mode.
    #[serde(default)]
    pub include_screenshot: bool,
    pub url: Option<String>,
    pub tab_id: Option<String>,
    /// Required for all page interactions, copied from the latest observation.
    pub observation_id: Option<String>,
    /// Exact target returned by snapshot; arbitrary CSS selectors are not accepted.
    pub target: Option<String>,
    #[schemars(length(max = 10000))]
    pub text: Option<String>,
    /// Values for a multi-select. `text` remains the shorthand for one value
    /// and for text inputs; keeping the two fields explicit prevents an array
    /// from being accepted by the runtime while the generated schema says it
    /// is a string.
    #[serde(default)]
    #[schemars(length(max = 100))]
    pub values: Option<Vec<String>>,
    pub key: Option<String>,
    #[serde(default)]
    pub modifiers: Vec<Modifier>,
    #[serde(default = "yes")]
    pub clear: bool,
    #[serde(default)]
    pub submit: bool,
    /// CSS viewport coordinates, never guessed from an unseen page.
    #[schemars(range(min = 0))]
    pub x: Option<f64>,
    #[schemars(range(min = 0))]
    pub y: Option<f64>,
    #[schemars(range(min = 0))]
    pub end_x: Option<f64>,
    #[schemars(range(min = 0))]
    pub end_y: Option<f64>,
    #[schemars(range(min = 1))]
    pub width: Option<f64>,
    #[schemars(range(min = 1))]
    pub height: Option<f64>,
    pub visible: Option<bool>,
    #[serde(default)]
    pub button: MouseButton,
    #[serde(default)]
    pub delta_x: i32,
    #[serde(default = "scroll_default")]
    pub delta_y: i32,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_default")]
    #[schemars(range(min = 1, max = 500))]
    pub limit: usize,
    #[serde(default = "wait_default")]
    #[schemars(range(min = 0, max = 5000))]
    pub milliseconds: u64,
}

#[derive(Clone, Copy, Default, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Clone, Copy, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum Modifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

fn yes() -> bool {
    true
}
fn scroll_default() -> i32 {
    640
}
fn page_default() -> usize {
    100
}
fn wait_default() -> u64 {
    250
}

impl BrowserInput {
    pub fn produces_observation(&self) -> bool {
        !matches!(self.action, Action::Close | Action::Tabs | Action::CloseTab)
    }

    pub fn requires_observation(&self) -> bool {
        matches!(
            self.action,
            Action::Click
                | Action::DoubleClick
                | Action::Move
                | Action::Drag
                | Action::Type
                | Action::Select
                | Action::Press
                | Action::Scroll
                | Action::Back
                | Action::Forward
                | Action::Reload
        )
    }

    pub fn parse(value: Value) -> Result<Self, ToolError> {
        if value
            .as_object()
            .is_some_and(|fields| fields.values().any(Value::is_null))
        {
            return Err(ToolError::InvalidInput(
                "omit unused parameters instead of passing null".into(),
            ));
        }
        let input: Self = parse_input(value)?;
        if [input.x, input.y, input.end_x, input.end_y]
            .into_iter()
            .flatten()
            .any(|coordinate| !coordinate.is_finite() || coordinate < 0.)
        {
            return Err(ToolError::InvalidInput(
                "coordinates must be finite and nonnegative".into(),
            ));
        }
        if [input.width, input.height]
            .into_iter()
            .flatten()
            .any(|dimension| !dimension.is_finite() || dimension < 1.)
        {
            return Err(ToolError::InvalidInput(
                "browser dimensions must be finite and at least 1".into(),
            ));
        }
        if !(1..=500).contains(&input.limit) || input.milliseconds > 5000 {
            return Err(ToolError::InvalidInput(
                "limit must be 1..500; milliseconds must be 0..5000".into(),
            ));
        }
        if input
            .text
            .as_ref()
            .is_some_and(|text| text.chars().count() > 10000)
        {
            return Err(ToolError::InvalidInput(
                "text exceeds 10000 characters; use multiple type calls".into(),
            ));
        }
        let pointer = matches!(
            input.action,
            Action::DoubleClick | Action::Move | Action::Drag | Action::Scroll
        ) || (input.action == Action::Click && input.target.is_none());
        if (pointer && (input.x.is_none() || input.y.is_none()))
            || (input.action == Action::Drag && (input.end_x.is_none() || input.end_y.is_none()))
            || (input.action == Action::Type && (input.text.is_none() || input.target.is_none()))
            || (input.action == Action::Select
                && (input.target.is_none()
                    || (input.text.is_none() && input.values.as_ref().is_none_or(Vec::is_empty))))
            || (input.action == Action::Press && input.key.is_none())
            || (matches!(
                input.action,
                Action::Open | Action::Navigate | Action::NewTab
            ) && input.url.is_none())
            || (matches!(input.action, Action::SwitchTab | Action::CloseTab)
                && input.tab_id.is_none())
            || (input.action == Action::Resize && (input.width.is_none() || input.height.is_none()))
            || (input.action == Action::SetVisible && input.visible.is_none())
        {
            return Err(ToolError::InvalidInput(
                "action is missing a required URL, target, coordinates, text, key or tabId".into(),
            ));
        }
        if matches!(
            input.action,
            Action::Click
                | Action::DoubleClick
                | Action::Move
                | Action::Drag
                | Action::Type
                | Action::Select
                | Action::Press
                | Action::Scroll
                | Action::Back
                | Action::Forward
                | Action::Reload
        ) && input.observation_id.is_none()
        {
            return Err(ToolError::InvalidInput(
                "observationId is required for browser interactions".into(),
            ));
        }
        Ok(input)
    }
}

impl Action {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Navigate => "navigate",
            Self::Snapshot => "snapshot",
            Self::Screenshot => "screenshot",
            Self::Status => "status",
            Self::CurrentUrl => "currentUrl",
            Self::Tabs => "tabs",
            Self::NewTab => "newTab",
            Self::SwitchTab => "switchTab",
            Self::CloseTab => "closeTab",
            Self::Click => "click",
            Self::DoubleClick => "doubleClick",
            Self::Move => "move",
            Self::Drag => "drag",
            Self::Type => "type",
            Self::Press => "press",
            Self::Scroll => "scroll",
            Self::Select => "select",
            Self::Back => "back",
            Self::Forward => "forward",
            Self::Reload => "reload",
            Self::Stop => "stop",
            Self::SetVisible => "setVisible",
            Self::Resize => "resize",
            Self::Wait => "wait",
            Self::Close => "close",
        }
    }
}

pub(super) fn schema() -> Value {
    let mut settings = schemars::gen::SchemaSettings::draft07();
    settings.inline_subschemas = true;
    settings.option_add_null_type = false;
    let mut schema = serde_json::to_value(
        settings
            .into_generator()
            .into_root_schema_for::<BrowserInput>(),
    )
    .expect("browser input schema");
    schema["oneOf"] = serde_json::json!([
        {"properties":{"action":{"enum":["snapshot","screenshot","status","currentUrl","tabs","stop","wait","close"]}}},
        {"properties":{"action":{"enum":["open","navigate","newTab"]}},"required":["url"]},
        {"properties":{"action":{"enum":["switchTab","closeTab"]}},"required":["tabId"]},
        {"properties":{"action":{"enum":["click"]}},"required":["observationId"],"anyOf":[{"required":["target"]},{"required":["x","y"]}]},
        {"properties":{"action":{"enum":["doubleClick","move","scroll"]}},"required":["observationId","x","y"]},
        {"properties":{"action":{"enum":["drag"]}},"required":["observationId","x","y","endX","endY"]},
        {"properties":{"action":{"enum":["type"]}},"required":["observationId","target","text"]},
        {"properties":{"action":{"enum":["select"]}},"required":["observationId","target"],"anyOf":[{"required":["text"]},{"required":["values"]}]},
        {"properties":{"action":{"enum":["press"]}},"required":["observationId","key"]},
        {"properties":{"action":{"enum":["back","forward","reload"]}},"required":["observationId"]},
        {"properties":{"action":{"enum":["setVisible"]}},"required":["visible"]},
        {"properties":{"action":{"enum":["resize"]}},"required":["width","height"]}
    ]);
    schema
}
