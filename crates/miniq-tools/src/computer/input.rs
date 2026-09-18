use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::{router::parse_input, ToolError};

#[derive(Clone, Copy, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Action {
    Status,
    Screenshot,
    Click,
    DoubleClick,
    Move,
    Drag,
    Scroll,
    Type,
    Key,
    Wait,
    Release,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ComputerInput {
    pub action: Action,
    pub display_id: Option<u32>,
    /// Required for input and wait. Use the most recent screenshot's observationId.
    pub observation_id: Option<String>,
    /// Coordinates relative to the screenshot, including on Retina displays.
    #[schemars(range(min = 0))]
    pub x: Option<f64>,
    #[schemars(range(min = 0))]
    pub y: Option<f64>,
    #[schemars(range(min = 0))]
    pub end_x: Option<f64>,
    #[schemars(range(min = 0))]
    pub end_y: Option<f64>,
    /// Drag waypoints in screenshot pixels, including the supplied start and end.
    #[schemars(length(min = 2))]
    pub path: Option<Vec<Point>>,
    #[serde(default)]
    pub button: Button,
    #[schemars(length(max = 10000))]
    pub text: Option<String>,
    /// A named key or one Unicode character. Use type for text.
    pub key: Option<String>,
    #[serde(default)]
    pub modifiers: Vec<Modifier>,
    /// Scroll wheel steps; positive means right/down.
    #[serde(default)]
    pub scroll_x: i32,
    #[serde(default)]
    pub scroll_y: i32,
    #[serde(default = "wait_default")]
    #[schemars(range(min = 0, max = 5000))]
    pub milliseconds: u64,
}

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct Point {
    #[schemars(range(min = 0))]
    pub x: f64,
    #[schemars(range(min = 0))]
    pub y: f64,
}

#[derive(Clone, Copy, Default, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum Button {
    #[default]
    Left,
    Middle,
    Right,
}

#[derive(Clone, Copy, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub(super) enum Modifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

fn wait_default() -> u64 {
    250
}

impl ComputerInput {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        if value
            .as_object()
            .is_some_and(|fields| fields.values().any(Value::is_null))
        {
            return Err(ToolError::InvalidInput(
                "omit unused parameters instead of passing null".into(),
            ));
        }
        if value
            .get("path")
            .and_then(Value::as_array)
            .is_some_and(|path| path.iter().any(|point| !point.is_object()))
        {
            return Err(ToolError::InvalidInput(
                "path points must be objects with x and y coordinates".into(),
            ));
        }
        let input: Self = parse_input(value)?;
        if input.action != Action::Key && !input.modifiers.is_empty() {
            return Err(ToolError::InvalidInput(
                "modifiers are only supported for key actions".into(),
            ));
        }
        if [input.x, input.y, input.end_x, input.end_y]
            .into_iter()
            .flatten()
            .any(|coordinate| !coordinate.is_finite() || coordinate < 0.)
        {
            return Err(ToolError::InvalidInput(
                "coordinates must be finite and nonnegative".into(),
            ));
        }
        if input.milliseconds > 5000 {
            return Err(ToolError::InvalidInput(
                "milliseconds must be 0..5000".into(),
            ));
        }
        if input
            .text
            .as_ref()
            .is_some_and(|text| text.chars().count() > 10000)
        {
            return Err(ToolError::InvalidInput(
                "text exceeds 10000 characters; send it in separate input calls".into(),
            ));
        }
        let pointer = matches!(
            input.action,
            Action::Click | Action::DoubleClick | Action::Move | Action::Drag | Action::Scroll
        );
        if (pointer && (input.x.is_none() || input.y.is_none()))
            || (input.action == Action::Drag && (input.end_x.is_none() || input.end_y.is_none()))
            || (input.action == Action::Type && input.text.is_none())
            || (input.action == Action::Key && input.key.is_none())
        {
            return Err(ToolError::InvalidInput(
                "action is missing required coordinates, text or key".into(),
            ));
        }
        if !matches!(
            input.action,
            Action::Status | Action::Screenshot | Action::Release
        ) && input.observation_id.is_none()
        {
            return Err(ToolError::InvalidInput(
                "observationId is required for desktop actions".into(),
            ));
        }
        if input.action == Action::Key {
            super::native::parse_key(input.key.as_deref().unwrap_or(""))
                .map_err(ToolError::InvalidInput)?;
        }
        input.validate_path()?;
        Ok(input)
    }

    fn validate_path(&self) -> Result<(), ToolError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        if self.action != Action::Drag || path.len() < 2 {
            return Err(ToolError::InvalidInput(
                "path requires a drag action and at least two points".into(),
            ));
        }
        if path.iter().any(|point| {
            !point.x.is_finite() || !point.y.is_finite() || point.x < 0. || point.y < 0.
        }) {
            return Err(ToolError::InvalidInput(
                "path coordinates must be finite and nonnegative".into(),
            ));
        }
        let first = &path[0];
        let last = &path[path.len() - 1];
        if (Some(first.x), Some(first.y)) != (self.x, self.y)
            || (Some(last.x), Some(last.y)) != (self.end_x, self.end_y)
        {
            return Err(ToolError::InvalidInput(
                "path endpoints must match x/y and endX/endY".into(),
            ));
        }
        Ok(())
    }
}

pub(super) fn schema() -> Value {
    let mut settings = schemars::gen::SchemaSettings::draft07();
    settings.inline_subschemas = true;
    settings.option_add_null_type = false;
    let mut schema = serde_json::to_value(
        settings
            .into_generator()
            .into_root_schema_for::<ComputerInput>(),
    )
    .expect("computer input schema");
    schema["oneOf"] = serde_json::json!([
        {"properties":{"action":{"enum":["status","screenshot","release"]},"modifiers":{"maxItems":0}}},
        {"properties":{"action":{"enum":["click","doubleClick","move","scroll"]},"modifiers":{"maxItems":0}},"required":["observationId","x","y"]},
        {"properties":{"action":{"enum":["drag"]},"modifiers":{"maxItems":0}},"required":["observationId","x","y","endX","endY"]},
        {"properties":{"action":{"enum":["type"]},"modifiers":{"maxItems":0}},"required":["observationId","text"]},
        {"properties":{"action":{"enum":["key"]}},"required":["observationId","key"]},
        {"properties":{"action":{"enum":["wait"]},"modifiers":{"maxItems":0}},"required":["observationId"]}
    ]);
    schema["allOf"] = serde_json::json!([{
        "if": {"required": ["path"]},
        "then": {"properties": {"action": {"const": "drag"}}}
    }]);
    schema
}
