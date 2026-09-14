use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{router::parse_input, ToolError};

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum Action {
    Status,
    Windows,
    Inspect,
    Screenshot,
    Invoke,
    Select,
    SetValue,
    Key,
    Type,
    Click,
    Scroll,
    Release,
}

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(super) enum Modifier {
    Alt,
    Ctrl,
    Meta,
    Shift,
}

#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(untagged, deny_unknown_fields)]
pub(super) enum AxValue {
    Text {
        #[schemars(length(max = 10000))]
        text: String,
    },
    Number {
        number: f64,
    },
    Boolean {
        boolean: bool,
    },
}

impl AxValue {
    #[cfg(target_os = "macos")]
    pub fn scalar(&self) -> Value {
        match self {
            Self::Text { text } => json!(text),
            Self::Number { number } => json!(number),
            Self::Boolean { boolean } => json!(boolean),
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AppInput {
    pub action: Action,
    /// Use the exact windowId and pid returned by windows, including for release.
    pub window_id: Option<u32>,
    #[schemars(range(min = 1))]
    pub pid: Option<i32>,
    /// Required for input and subsequent windows/inspect pages. Omit to start a
    /// fresh list/inspect. Window-list pages must retain the same optional pid filter.
    #[schemars(length(min = 1))]
    pub observation_id: Option<String>,
    /// An element ID from this observation. invoke uses an advertised AX action,
    /// select selects an observed row/item, and setValue writes a scalar AXValue.
    #[schemars(length(min = 1))]
    pub element_id: Option<String>,
    /// Exact name from this element's observed actions, such as AXPress, AXOpen,
    /// or AXScrollRightByPage. AXRaise is excluded because it takes the foreground.
    #[schemars(length(min = 1))]
    pub ax_action: Option<String>,
    /// Value for setValue. Supply exactly one field: {text:"..."}, {number:0.5},
    /// or {boolean:true}. Numbers must fit the observed minValue/maxValue.
    pub value: Option<AxValue>,
    /// Expand children, AXBrowser columns and AXScrollArea contents.
    /// childrenSources identifies the relationships; omit for the window root.
    #[schemars(length(min = 1))]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    #[schemars(range(min = 1, max = 100))]
    pub limit: usize,
    #[schemars(length(max = 10000))]
    pub text: Option<String>,
    /// Enter, Tab, Space, Escape, Backspace, Delete, arrows, Home/End, PageUp/Down,
    /// F1..F12 or one ASCII letter/digit/punctuation key. Use type for Unicode text.
    #[schemars(regex(
        pattern = "^(Enter|Return|Tab|Space|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|F([1-9]|1[0-2])|[ -~])$"
    ))]
    pub key: Option<String>,
    #[serde(default)]
    pub modifiers: Vec<Modifier>,
    /// Coordinates in the latest target screenshot's pixels. Never global coordinates.
    #[schemars(range(min = 0))]
    pub x: Option<f64>,
    #[schemars(range(min = 0))]
    pub y: Option<f64>,
    /// Scroll wheel steps; positive means right/down.
    #[serde(default)]
    #[schemars(range(min = -2147483647))]
    pub scroll_x: i32,
    #[serde(default)]
    #[schemars(range(min = -2147483647))]
    pub scroll_y: i32,
    /// Capture the target window with the result. AX-only operations need no Screen Recording.
    #[serde(default)]
    pub include_screenshot: bool,
}

fn page_size() -> usize {
    40
}

impl AppInput {
    pub fn parse(value: Value) -> Result<Self, ToolError> {
        if value
            .as_object()
            .is_some_and(|v| v.values().any(Value::is_null))
        {
            return Err(invalid("omit unused parameters instead of null"));
        }
        let input: Self = parse_input(value)?;
        input.validate_values()?;
        input.validate_action()?;
        Ok(input)
    }

    fn validate_values(&self) -> Result<(), ToolError> {
        let input = self;
        if [
            &input.observation_id,
            &input.element_id,
            &input.parent_id,
            &input.ax_action,
        ]
        .into_iter()
        .flatten()
        .any(|s| s.is_empty())
        {
            return Err(invalid(
                "observationId, elementId, parentId and axAction must be nonempty when provided",
            ));
        }
        if input.pid.is_some_and(|pid| pid <= 0) || !(1..=100).contains(&input.limit) {
            return Err(invalid("pid must be positive and limit must be 1..100"));
        }
        if input.scroll_x == i32::MIN || input.scroll_y == i32::MIN {
            return Err(invalid(
                "scroll steps must be between -2147483647 and 2147483647",
            ));
        }
        if input
            .text
            .as_ref()
            .is_some_and(|s| s.chars().count() > 10000)
            || matches!(&input.value, Some(AxValue::Text { text }) if text.chars().count() > 10000)
        {
            return Err(invalid(
                "text/value exceeds 10000 characters; use separate input calls",
            ));
        }
        if matches!(&input.value, Some(AxValue::Number { number }) if !number.is_finite()) {
            return Err(invalid("numeric value must be finite"));
        }
        if [input.x, input.y]
            .into_iter()
            .flatten()
            .any(|n| !n.is_finite() || n < 0.)
        {
            return Err(invalid("coordinates must be finite and nonnegative"));
        }
        if input.key.as_deref().is_some_and(|key| !valid_key(key)) {
            return Err(invalid(
                "use a named key or one ASCII key, with separate modifiers",
            ));
        }
        if input.ax_action.as_deref() == Some("AXRaise") {
            return Err(invalid(
                "AXRaise takes the foreground and is unavailable in background control",
            ));
        }
        Ok(())
    }

    fn validate_action(&self) -> Result<(), ToolError> {
        let input = self;
        if !matches!(input.action, Action::Status | Action::Windows)
            && (input.window_id.is_none() || input.pid.is_none())
        {
            return Err(invalid("windowId and pid from windows are required"));
        }
        if input.is_input() && input.observation_id.as_deref().is_none_or(str::is_empty) {
            return Err(invalid("input requires the latest observationId"));
        }
        if matches!(
            input.action,
            Action::Invoke | Action::Select | Action::SetValue
        ) && input.element_id.as_deref().is_none_or(str::is_empty)
        {
            return Err(invalid(
                "invoke, select and setValue require an observed elementId",
            ));
        }
        if input.action == Action::Invoke && input.ax_action.is_none() {
            return Err(invalid(
                "invoke requires axAction from the observed element's actions",
            ));
        }
        if input.action == Action::SetValue && input.value.is_none() {
            return Err(invalid(
                "setValue requires value with exactly one text, number or boolean field",
            ));
        }
        if input.action == Action::Type && input.text.is_none() {
            return Err(invalid("type requires text"));
        }
        if input.action == Action::Key && input.key.is_none() {
            return Err(invalid(
                "use a named key or one ASCII key, with separate modifiers",
            ));
        }
        if matches!(input.action, Action::Click | Action::Scroll)
            && (input.x.is_none() || input.y.is_none())
        {
            return Err(invalid(
                "click and scroll require x and y in screenshot pixels",
            ));
        }
        if matches!(
            input.action,
            Action::Inspect | Action::Screenshot | Action::Windows
        ) && (input.parent_id.is_some() || input.offset > 0)
            && input.observation_id.is_none()
        {
            return Err(invalid("pagination requires its observationId"));
        }
        Ok(())
    }

    pub fn is_input(&self) -> bool {
        matches!(
            self.action,
            Action::Invoke
                | Action::Select
                | Action::SetValue
                | Action::Type
                | Action::Key
                | Action::Click
                | Action::Scroll
        )
    }
}

fn invalid(message: &str) -> ToolError {
    ToolError::InvalidInput(message.into())
}

fn valid_key(key: &str) -> bool {
    matches!(
        key,
        "Enter"
            | "Return"
            | "Tab"
            | "Space"
            | "Escape"
            | "Backspace"
            | "Delete"
            | "ArrowLeft"
            | "ArrowRight"
            | "ArrowUp"
            | "ArrowDown"
            | "Home"
            | "End"
            | "PageUp"
            | "PageDown"
    ) || matches!(
        key,
        "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
    ) || (key.len() == 1 && key.is_ascii() && !key.as_bytes()[0].is_ascii_control())
}

pub(super) fn schema() -> Value {
    let mut settings = schemars::gen::SchemaSettings::draft07();
    settings.inline_subschemas = true;
    settings.option_add_null_type = false;
    let mut schema =
        serde_json::to_value(settings.into_generator().into_root_schema_for::<AppInput>())
            .expect("app input schema");
    schema["oneOf"] = json!([
        {"properties":{"action":{"enum":["status","windows"]}}},
        {"properties":{"action":{"enum":["inspect","screenshot","release"]}},"required":["windowId","pid"]},
        {"properties":{"action":{"enum":["invoke"]}},"required":["windowId","pid","observationId","elementId","axAction"]},
        {"properties":{"action":{"enum":["select"]}},"required":["windowId","pid","observationId","elementId"]},
        {"properties":{"action":{"enum":["setValue"]}},"required":["windowId","pid","observationId","elementId","value"]},
        {"properties":{"action":{"enum":["type"]}},"required":["windowId","pid","observationId","text"]},
        {"properties":{"action":{"enum":["key"]}},"required":["windowId","pid","observationId","key"]},
        {"properties":{"action":{"enum":["click","scroll"]}},"required":["windowId","pid","observationId","x","y"]}
    ]);
    schema["properties"]["axAction"]["not"] = json!({"const":"AXRaise"});
    schema["allOf"] = json!([{
        "if": {"properties":{"action":{"enum":["windows","inspect","screenshot"]}},
            "anyOf":[{"required":["parentId"]},{"properties":{"offset":{"minimum":1}},"required":["offset"]}]},
        "then": {"required":["observationId"]}
    }]);
    schema
}
