//! Public macOS AX and process-directed event backend. Never takes the pointer.

use std::collections::{HashMap, HashSet};

use core_graphics::geometry::CGPoint;
use serde::Serialize;
use serde_json::{json, Map, Value};

use super::{
    backend::{AppBackend, AppSnapshot, AppWindow, NativeApp},
    input::{Action, AppInput, Modifier},
};
use crate::{observation, ToolContext};

mod ax;
mod events;
mod windows;

use ax::Element;

fn metadata<T: Serialize>(
    name: &str,
    result: Result<T, String>,
    errors: &mut Map<String, Value>,
) -> Value {
    match result {
        Ok(value) => json!(value),
        Err(error) => {
            errors.insert(name.into(), json!(error));
            Value::Null
        }
    }
}

fn child_sources(role: Option<&str>) -> &'static [&'static str] {
    match role {
        Some("AXBrowser") => &["AXChildren", "AXColumns"],
        Some("AXScrollArea") => &["AXChildren", "AXContents"],
        _ => &["AXChildren"],
    }
}

impl AppBackend for NativeApp {
    fn supported(&self) -> bool {
        true
    }
    fn permissions(&self) -> miniq_protocol::ComputerPermissions {
        crate::desktop_permissions()
    }
    fn windows(&self) -> Result<Vec<AppWindow>, String> {
        windows::list()
    }
    fn snapshot(&self, target: &AppWindow) -> Result<Box<dyn AppSnapshot>, String> {
        windows::resolve(target)?;
        let started = windows::identity(target.pid)?;
        let application = Element::application(target.pid)?;
        let root = windows::ax_window(&application, target)?;
        let snapshot = Snapshot {
            target: target.clone(),
            started,
            application,
            elements: vec![root],
            children: HashMap::new(),
            observed: HashSet::from([0]),
            reference_prefix: uuid::Uuid::new_v4().to_string(),
            observed_actions: HashMap::new(),
            observed_selection: HashSet::new(),
        };
        snapshot.validate()?;
        Ok(Box::new(snapshot))
    }
    fn capture(&self, target: &AppWindow) -> Result<image::RgbaImage, String> {
        if !core_graphics::access::ScreenCaptureAccess.preflight() {
            return Err("computer_permission_required: Screen Recording is required for a target screenshot".into());
        }
        windows::resolve(target)?;
        let window = xcap::Window::all()
            .map_err(|error| error.to_string())?
            .into_iter()
            .find(|window| window.id().ok() == Some(target.window_id))
            .ok_or("stale_app_observation: capture target closed or is no longer visible")?;
        let image = window
            .capture_image()
            .map_err(|error| format!("target window capture failed: {error}"))?;
        windows::resolve(target)?;
        Ok(image)
    }
}

struct Snapshot {
    target: AppWindow,
    started: (u64, u64),
    application: Element,
    elements: Vec<Element>,
    children: HashMap<usize, Vec<usize>>,
    observed: HashSet<usize>,
    reference_prefix: String,
    observed_actions: HashMap<usize, HashSet<String>>,
    observed_selection: HashSet<usize>,
}

fn observed_index(id: &str, prefix: &str, observed: &HashSet<usize>) -> Result<usize, String> {
    id.strip_prefix(prefix)
        .and_then(|id| id.strip_prefix(":e"))
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|index| observed.contains(index))
        .ok_or_else(|| "stale_app_element: use an elementId from this observation".into())
}

impl Snapshot {
    fn index(&self, id: &str) -> Result<usize, String> {
        observed_index(id, &self.reference_prefix, &self.observed)
    }

    fn reference(&self, index: usize) -> String {
        format!("{}:e{index}", self.reference_prefix)
    }

    fn retain(&mut self, element: Element) -> usize {
        if let Some(index) = self
            .elements
            .iter()
            .position(|existing| *existing == element)
        {
            return index;
        }
        self.elements.push(element);
        self.elements.len() - 1
    }

    fn belongs(&self, element: &Element) -> Result<(), String> {
        Self::descends_from(element, &self.elements[0])
    }

    fn descends_from(element: &Element, root: &Element) -> Result<(), String> {
        // AppKit file pickers embed controls from OpenAndSavePanelService. An
        // element's PID alone does not establish ownership: require its actual
        // retained AXParent chain to reach this exact target window instead.
        let mut current = Some(element.clone());
        let mut visited = Vec::new();
        while let Some(node) = current {
            if node.sensitive()? {
                return Err(
                    "protected_app_element: password and protected fields require the user".into(),
                );
            }
            if node == *root {
                return Ok(());
            }
            if visited.contains(&node) {
                return Err("stale_app_element: accessibility ancestry contains a cycle".into());
            }
            current = node.element("AXParent")?;
            visited.push(node);
        }
        Err("stale_app_element: element no longer belongs to the observed window".into())
    }

    fn keyboard_window(&self) -> Result<Element, String> {
        self.validate()?;
        let focused_window = self
            .application
            .element("AXFocusedWindow")?
            .ok_or("background_action_unsupported: application has no verifiable key window")?;
        self.belongs(&focused_window).map_err(|_| "background_action_unsupported: key window is neither the observed target nor its attached sheet; inspect the actual target".to_string())?;
        Ok(focused_window)
    }

    fn keyboard_target(&self) -> Result<Element, String> {
        let focused_window = self.keyboard_window()?;
        let focused = self.application.element("AXFocusedUIElement")?.ok_or("background_action_unsupported: application has no verifiable text focus; use its observed AX controls")?;
        Self::descends_from(&focused, &focused_window)?;
        focused.check_interactive()?;
        Ok(focused)
    }

    fn key(&self, input: &AppInput) -> Result<Value, String> {
        let window = self.keyboard_window()?;
        let focused = self.application.element("AXFocusedUIElement")?;
        if let Some(element) = &focused {
            Self::descends_from(element, &window)?;
            element.check_interactive()?;
        } else if !input
            .modifiers
            .iter()
            .any(|modifier| matches!(modifier, Modifier::Meta | Modifier::Ctrl))
            && input.key.as_deref() != Some("Escape")
        {
            return Err("background_action_unsupported: this key needs verified non-protected text focus; use the observed button's AXPress for confirmation".into());
        }
        events::key(self.target.pid, input)?;
        Ok(
            json!({"method":"processEvent","dispatched":true,"targeting":if focused.is_some() { "focusedElement" } else { "keyWindowCommand" },"verification":"Delivery does not confirm handling: background AppKit panels can ignore keyboard commands. Inspect the target; prefer observed AX open, select and press actions if unchanged."}),
        )
    }

    fn describe(&mut self, index: usize) -> Result<Value, String> {
        let element = self.elements[index].clone();
        let protected = element.sensitive()?;
        let role = element.text("AXRole")?;
        let subrole = element.text("AXSubrole")?;
        let children_sources = child_sources(role.as_deref());
        let bounds = element.bounds()?.map(|(position, size)| json!({"x":position.x,"y":position.y,"width":size.width,"height":size.height}));
        if protected {
            return Ok(
                json!({"id":self.reference(index),"role":role,"subrole":subrole,"protected":true,"bounds":bounds,"childCount":0,"actions":[]}),
            );
        }
        self.belongs(&element)?;
        // AX providers can expose a control while declining individual metadata
        // reads (notably AppKit picker decorations). Keep per-attribute failures
        // explicit, instead of making the entire target impossible to inspect.
        let mut errors = Map::new();
        let child_count = metadata(
            "AXChildren",
            self.child_indices(index).map(|children| children.len()),
            &mut errors,
        );
        let title = metadata("AXTitle", element.text("AXTitle"), &mut errors);
        let description = metadata("AXDescription", element.text("AXDescription"), &mut errors);
        let help = metadata("AXHelp", element.text("AXHelp"), &mut errors);
        let identifier = metadata("AXIdentifier", element.text("AXIdentifier"), &mut errors);
        let value = metadata("AXValue", element.value(), &mut errors);
        let minimum = metadata("AXMinValue", element.number("AXMinValue"), &mut errors);
        let maximum = metadata("AXMaxValue", element.number("AXMaxValue"), &mut errors);
        let orientation = metadata("AXOrientation", element.text("AXOrientation"), &mut errors);
        let enabled = metadata("AXEnabled", element.boolean("AXEnabled"), &mut errors);
        let focused = metadata("AXFocused", element.boolean("AXFocused"), &mut errors);
        let actions = metadata("actions", element.actions(), &mut errors);
        let settable = metadata("AXValueSettable", element.settable("AXValue"), &mut errors);
        let selected = metadata("AXSelected", element.boolean("AXSelected"), &mut errors);
        let selection_settable = metadata(
            "selectionSettable",
            element.selection_settable(),
            &mut errors,
        );
        Ok(json!({
            "id":self.reference(index),"processId":element.pid()?,"role":role,"subrole":subrole,
            "title":title,"description":description,"help":help,"identifier":identifier,
            "value":value,"minValue":minimum,"maxValue":maximum,"orientation":orientation,
            "enabled":enabled,"focused":focused,"bounds":bounds,
            "actions":actions,"valueSettable":settable,
            "selected":selected,"selectionSettable":selection_settable,
            "childCount":child_count,"childrenSources":children_sources,
            "protected":false,"attributeErrors":errors,
        }))
    }

    fn child_indices(&mut self, index: usize) -> Result<Vec<usize>, String> {
        if let Some(children) = self.children.get(&index) {
            return Ok(children.clone());
        }
        let element = &self.elements[index];
        let mut exposed = Vec::new();
        // AppKit picker columns can return empty AXChildren while AXContents
        // holds the actual list. AXBrowser exposes all columns via AXColumns.
        // Preserve every real reference and deduplicate; input still requires
        // the exact AXParent ancestry to reach the retained target window.
        for source in child_sources(element.text("AXRole")?.as_deref()) {
            for child in element.elements(source)? {
                if !exposed.contains(&child) {
                    exposed.push(child);
                }
            }
        }
        let children = exposed
            .into_iter()
            .map(|child| self.retain(child))
            .collect::<Vec<_>>();
        self.children.insert(index, children.clone());
        Ok(children)
    }

    fn pointer(
        &self,
        ctx: &ToolContext,
        input: &AppInput,
        image_size: Option<(u32, u32)>,
    ) -> Result<Value, String> {
        let (width, height) =
            image_size.ok_or("take a target screenshot before coordinate input")?;
        let x = input.x.ok_or("x required")?;
        let y = input.y.ok_or("y required")?;
        if width == 0
            || height == 0
            || !x.is_finite()
            || !y.is_finite()
            || x < 0.
            || y < 0.
            || x >= width as f64
            || y >= height as f64
        {
            return Err("coordinates must be inside the target screenshot".into());
        }
        let point = CGPoint::new(
            self.target.x as f64 + x * self.target.width as f64 / width as f64,
            self.target.y as f64 + y * self.target.height as f64 / height as f64,
        );
        let element = self.application.at_position(point.x, point.y)?;
        self.belongs(&element)?;
        element.check_interactive()?;
        observation::check_cancelled(ctx)?;
        if input.action == Action::Click
            && element.actions()?.iter().any(|action| action == "AXPress")
        {
            element.press()?;
            return Ok(json!({"method":"AXPress","dispatched":true}));
        }
        if self.keyboard_window()? != self.elements[0] {
            return Err("background_action_unsupported: coordinate events require the exact key-window screenshot; use the attached sheet's AX controls".into());
        }
        events::pointer(self.target.pid, self.target.window_id, input, point)?;
        Ok(
            json!({"method":"processEvent","dispatched":true,"verification":"inspect the updated target state"}),
        )
    }
}

impl AppSnapshot for Snapshot {
    fn validate(&self) -> Result<(), String> {
        if windows::identity(self.target.pid)? != self.started {
            return Err("stale_app_observation: target process restarted".into());
        }
        windows::resolve(&self.target)?;
        if windows::ax_window(&self.application, &self.target)? != self.elements[0] {
            return Err("stale_app_observation: accessibility window was replaced".into());
        }
        Ok(())
    }

    fn page(
        &mut self,
        parent_id: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<Value, String> {
        self.validate()?;
        let index = parent_id.map(|id| self.index(id)).transpose()?.unwrap_or(0);
        self.belongs(&self.elements[index])?;
        let children = self.child_indices(index)?;
        if offset > children.len() {
            return Err("page offset exceeds this element's child count".into());
        }
        let end = offset.saturating_add(limit).min(children.len());
        let elements = children[offset..end]
            .iter()
            .map(|index| self.describe(*index))
            .collect::<Result<Vec<_>, _>>()?;
        let parent = self.describe(index)?;
        self.observed.extend(children[offset..end].iter().copied());
        self.observed.insert(index);
        for node in std::iter::once(&parent).chain(elements.iter()) {
            let index = self.index(node["id"].as_str().ok_or("missing element reference")?)?;
            let actions = node["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            self.observed_actions.insert(index, actions);
            if node["selectionSettable"] == true {
                self.observed_selection.insert(index);
            } else {
                self.observed_selection.remove(&index);
            }
        }
        Ok(
            json!({"rootId":self.reference(0),"parentId":self.reference(index),"parent":parent,"elements":elements,"offset":offset,"total":children.len(),"nextOffset":(end<children.len()).then_some(end),"untrustedContent":true}),
        )
    }

    fn perform(
        &mut self,
        ctx: &ToolContext,
        input: &AppInput,
        image_size: Option<(u32, u32)>,
    ) -> Result<Value, String> {
        self.validate()?;
        observation::check_cancelled(ctx)?;
        match input.action {
            Action::Invoke | Action::Select | Action::SetValue => {
                let index = self.index(input.element_id.as_deref().ok_or("elementId required")?)?;
                let element = &self.elements[index];
                self.belongs(element)?;
                if input.action == Action::Invoke {
                    let action = input.ax_action.as_deref().ok_or("axAction required")?;
                    if action == "AXRaise" {
                        return Err("background_action_unsupported: AXRaise would change the user's foreground window".into());
                    }
                    if !self
                        .observed_actions
                        .get(&index)
                        .is_some_and(|actions| actions.contains(action))
                    {
                        return Err(format!("background_action_unsupported: this observation did not expose {action} on this element"));
                    }
                    element.perform_named_action(action)?;
                    Ok(json!({"method":action,"dispatched":true}))
                } else if input.action == Action::Select {
                    if !self.observed_selection.contains(&index) {
                        return Err("background_action_unsupported: this observation did not expose writable selection on this element".into());
                    }
                    let method = element.select()?;
                    Ok(match element.boolean("AXSelected") {
                        Ok(selected) => {
                            json!({"method":method,"dispatched":true,"selected":selected})
                        }
                        Err(error) => {
                            json!({"method":method,"dispatched":true,"selected":null,"verificationError":error})
                        }
                    })
                } else {
                    let requested = input.value.as_ref().ok_or("value required")?;
                    element.set_value(requested)?;
                    // The write already succeeded. A control replaced by its
                    // change handler can make readback stale; preserve that
                    // distinction so the agent observes rather than replays.
                    Ok(match element.value() {
                        Ok(value) => {
                            json!({"method":"AXSetValue","dispatched":true,"valueMatches":value==requested.scalar(),"value":value})
                        }
                        Err(error) => {
                            json!({"method":"AXSetValue","dispatched":true,"valueMatches":null,"verificationError":error})
                        }
                    })
                }
            }
            Action::Key => self.key(input),
            Action::Type => {
                let text = input.text.as_deref().ok_or("text required")?;
                let focused = self.keyboard_target()?;
                if focused.settable("AXSelectedText")? {
                    self.belongs(&focused)?;
                    focused.replace_selection(text)?;
                    return Ok(json!({"method":"AXSelectedText","dispatched":true}));
                }
                events::text(self.target.pid, text, ctx, || {
                    self.keyboard_target().map(|_| ())
                })?;
                Ok(
                    json!({"method":"processEvent","dispatched":true,"verification":"inspect the updated target state"}),
                )
            }
            Action::Click | Action::Scroll => self.pointer(ctx, input, image_size),
            _ => Err("not an application input action".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_elements_returned_in_a_page_can_be_addressed() {
        let observed = HashSet::from([0, 2]);
        assert_eq!(
            observed_index("current:e0", "current", &observed).unwrap(),
            0
        );
        assert_eq!(
            observed_index("current:e2", "current", &observed).unwrap(),
            2
        );
        for id in [
            "current:e1",
            "current:e3",
            "current:e9999",
            "current:e-1",
            "old:e2",
            "e2",
            "",
            "root",
        ] {
            assert!(observed_index(id, "current", &observed).is_err());
        }
    }
}
