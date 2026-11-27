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
    pub url: Option<String>,
    /// Page identifier returned by tabs or an observation. Omit to use the
    /// user's selected page in the main task, or the child task's own page.
    pub tab_id: Option<String>,
    /// Required for all page interactions, copied from the latest observation.
    pub observation_id: Option<String>,
    /// Exact target returned by snapshot; arbitrary CSS selectors are not accepted.
    pub target: Option<String>,
    /// Prefer a semantic locator from the observed page over coordinates.
    pub locator: Option<ElementLocator>,
    /// Destination for drag, using the same element locator contract.
    pub end_locator: Option<ElementLocator>,
    pub end_target: Option<String>,
    #[schemars(length(max = 10000))]
    pub text: Option<String>,
    /// Values for a multi-select. `text` remains the shorthand for one value
    /// and for text inputs; keeping the two fields explicit prevents an array
    /// from being accepted by the runtime while the generated schema says it
    /// is a string.
    #[serde(default)]
    #[schemars(length(min = 1, max = 100))]
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

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ElementLocator {
    pub by: LocatorBy,
    #[schemars(length(min = 1))]
    pub value: String,
    /// Optional accessible-name filter, especially useful for role locators.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default = "yes")]
    pub exact: bool,
}

#[derive(Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) enum LocatorBy {
    Role,
    Label,
    Text,
    Placeholder,
    TestId,
    Css,
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
        let has_null = |value: &Value| {
            value
                .as_object()
                .is_some_and(|fields| fields.values().any(Value::is_null))
        };
        if has_null(&value)
            || ["locator", "endLocator"]
                .iter()
                .any(|key| value.get(key).is_some_and(has_null))
        {
            return Err(ToolError::InvalidInput(
                "omit unused parameters instead of passing null".into(),
            ));
        }
        let input: Self = parse_input(value)?;
        input.validate_limits()?;
        input.validate_addressing()?;
        input.validate_action()?;
        Ok(input)
    }

    fn validate_limits(&self) -> Result<(), ToolError> {
        if [self.x, self.y, self.end_x, self.end_y]
            .into_iter()
            .flatten()
            .any(|coordinate| !coordinate.is_finite() || coordinate < 0.)
        {
            return Err(ToolError::InvalidInput(
                "coordinates must be finite and nonnegative".into(),
            ));
        }
        if [self.width, self.height]
            .into_iter()
            .flatten()
            .any(|dimension| !dimension.is_finite() || dimension < 1.)
        {
            return Err(ToolError::InvalidInput(
                "browser dimensions must be finite and at least 1".into(),
            ));
        }
        if !(1..=500).contains(&self.limit) || self.milliseconds > 5000 {
            return Err(ToolError::InvalidInput(
                "limit must be 1..500; milliseconds must be 0..5000".into(),
            ));
        }
        if self
            .text
            .as_ref()
            .is_some_and(|text| text.chars().count() > 10000)
        {
            return Err(ToolError::InvalidInput(
                "text exceeds 10000 characters; use multiple type calls".into(),
            ));
        }
        if self
            .values
            .as_ref()
            .is_some_and(|values| !(1..=100).contains(&values.len()))
        {
            return Err(ToolError::InvalidInput(
                "values must contain 1..100 strings".into(),
            ));
        }
        Ok(())
    }

    fn validate_addressing(&self) -> Result<(), ToolError> {
        let element = self.target.is_some() || self.locator.is_some();
        let destination = self.end_target.is_some() || self.end_locator.is_some();
        if self
            .locator
            .iter()
            .chain(self.end_locator.iter())
            .any(|locator| locator.value.is_empty())
            || (self.target.is_some() && self.locator.is_some())
            || (self.end_target.is_some() && self.end_locator.is_some())
            || (element && (self.x.is_some() || self.y.is_some()))
            || (destination && (self.end_x.is_some() || self.end_y.is_some()))
            || (self.x.is_some() != self.y.is_some())
            || (self.end_x.is_some() != self.end_y.is_some())
        {
            return Err(ToolError::InvalidInput("use exactly one element target, locator or coordinate pair; locator value must not be empty".into()));
        }
        Ok(())
    }

    fn validate_action(&self) -> Result<(), ToolError> {
        let input = self;
        let element = input.target.is_some() || input.locator.is_some();
        let destination = input.end_target.is_some() || input.end_locator.is_some();
        let pointer = matches!(
            input.action,
            Action::Click | Action::DoubleClick | Action::Move | Action::Drag | Action::Scroll
        );
        if (pointer && !element && (input.x.is_none() || input.y.is_none()))
            || (input.action == Action::Drag
                && !destination
                && (input.end_x.is_none() || input.end_y.is_none()))
            || (input.action == Action::Type && (input.text.is_none() || !element))
            || (input.action == Action::Select
                && (!element
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
        if input.requires_observation() && input.observation_id.is_none() {
            return Err(ToolError::InvalidInput(
                "observationId is required for browser interactions".into(),
            ));
        }
        Ok(())
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
    // Apply the same exclusive addressing rule to the generated schema and runtime.
    let address = |target: &str, locator: &str, x: &str, y: &str| {
        serde_json::json!({"oneOf":[
            {"required":[target], "not":{"anyOf":[{"required":[locator]},{"required":[x]},{"required":[y]}]}},
            {"required":[locator], "not":{"anyOf":[{"required":[target]},{"required":[x]},{"required":[y]}]}},
            {"required":[x,y], "not":{"anyOf":[{"required":[target]},{"required":[locator]}]}}
        ]})
    };
    let element = serde_json::json!({"oneOf":[{"required":["target"]},{"required":["locator"]}]});
    schema["allOf"] = serde_json::json!([
        {"if":{"anyOf":[{"required":["target"]},{"required":["locator"]},{"required":["x"]},{"required":["y"]}]},
         "then":address("target","locator","x","y")},
        {"if":{"anyOf":[{"required":["endTarget"]},{"required":["endLocator"]},{"required":["endX"]},{"required":["endY"]}]},
         "then":address("endTarget","endLocator","endX","endY")}
    ]);
    schema["oneOf"] = serde_json::json!([
        {"properties":{"action":{"enum":["snapshot","screenshot","status","currentUrl","tabs","stop","wait","close"]}}},
        {"properties":{"action":{"enum":["open","navigate","newTab"]}},"required":["url"]},
        {"properties":{"action":{"enum":["switchTab","closeTab"]}},"required":["tabId"]},
        {"properties":{"action":{"enum":["click","doubleClick","move","scroll"]}},"required":["observationId"],"allOf":[address("target","locator","x","y")]},
        {"properties":{"action":{"enum":["drag"]}},"required":["observationId"],"allOf":[address("target","locator","x","y"),address("endTarget","endLocator","endX","endY")]},
        {"properties":{"action":{"enum":["type"]}},"required":["observationId","text"],"allOf":[element]},
        {"properties":{"action":{"enum":["select"]}},"required":["observationId"],"allOf":[element],"anyOf":[{"required":["text"]},{"required":["values"]}]},
        {"properties":{"action":{"enum":["press"]}},"required":["observationId","key"]},
        {"properties":{"action":{"enum":["back","forward","reload"]}},"required":["observationId"]},
        {"properties":{"action":{"enum":["setVisible"]}},"required":["visible"]},
        {"properties":{"action":{"enum":["resize"]}},"required":["width","height"]}
    ]);
    schema
}
