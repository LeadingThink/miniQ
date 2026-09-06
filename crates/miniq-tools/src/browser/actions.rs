use headless_chrome::{browser::tab::ModifierKey, protocol::cdp::Input, Tab};
use serde_json::json;

use super::input::{Action, BrowserInput, Modifier, MouseButton};
use crate::{observation, ToolContext};

fn selector(input: &BrowserInput) -> Result<String, String> {
    let target = input.target.as_deref().ok_or("target is required")?;
    let id = input
        .observation_id
        .as_deref()
        .ok_or("observationId is required")?;
    let prefix = format!("rpa-{id}-");
    if !target
        .strip_prefix(&prefix)
        .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|ch| ch.is_ascii_digit()))
    {
        return Err("target must come from the current snapshot".into());
    }
    Ok(format!("[data-miniq-rpa-id=\"{target}\"]"))
}

fn point(tab: &Tab, x: Option<f64>, y: Option<f64>) -> Result<(f64, f64), String> {
    let (x, y) = (x.ok_or("x is required")?, y.ok_or("y is required")?);
    let viewport =
        super::snapshot::evaluate(tab, "JSON.stringify({width:innerWidth,height:innerHeight})")?;
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.
        || y < 0.
        || x >= viewport["width"].as_f64().unwrap_or(0.)
        || y >= viewport["height"].as_f64().unwrap_or(0.)
    {
        return Err("coordinates must lie inside the observed viewport".into());
    }
    Ok((x, y))
}

fn mouse(
    tab: &Tab,
    kind: &str,
    at: (f64, f64),
    button: MouseButton,
    count: u32,
    held: bool,
) -> Result<(), String> {
    let (button, buttons) = match button {
        MouseButton::Left => ("left", 1),
        MouseButton::Right => ("right", 2),
        MouseButton::Middle => ("middle", 4),
    };
    let event: Input::DispatchMouseEvent = serde_json::from_value(json!({
        "type": kind, "x": at.0, "y": at.1, "button": button,
        "buttons": if held { buttons } else { 0 }, "clickCount": count,
    }))
    .map_err(|error| error.to_string())?;
    tab.call_method(event).map_err(|error| error.to_string())?;
    Ok(())
}

fn pointer(tab: &Tab, ctx: &ToolContext, input: &BrowserInput) -> Result<(), String> {
    let at = point(tab, input.x, input.y)?;
    if input.action == Action::Move {
        return mouse(tab, "mouseMoved", at, input.button, 0, false);
    }
    let end = if input.action == Action::Drag {
        point(tab, input.end_x, input.end_y)?
    } else {
        at
    };
    observation::check_cancelled(ctx)?;
    mouse(tab, "mouseMoved", at, input.button, 0, false)?;
    let count = if input.action == Action::DoubleClick {
        2
    } else {
        1
    };
    for click in 1..=count {
        mouse(tab, "mousePressed", at, input.button, click, true)?;
        let movement = if input.action == Action::Drag {
            (1..=10).try_for_each(|step| {
                observation::pause(ctx, 15)?;
                let t = f64::from(step) / 10.;
                mouse(
                    tab,
                    "mouseMoved",
                    (at.0 + (end.0 - at.0) * t, at.1 + (end.1 - at.1) * t),
                    input.button,
                    0,
                    true,
                )
            })
        } else {
            Ok(())
        };
        // Release even when a drag was cancelled or an intermediate CDP call failed.
        let release = mouse(tab, "mouseReleased", end, input.button, click, false);
        movement?;
        release?;
    }
    Ok(())
}

pub(super) fn perform(tab: &Tab, ctx: &ToolContext, input: &BrowserInput) -> Result<(), String> {
    observation::check_cancelled(ctx)?;
    match input.action {
        Action::Click if input.target.is_some() => {
            let element = tab
                .wait_for_element(&selector(input)?)
                .map_err(|error| error.to_string())?;
            validate_element(&element, false)?;
            observation::check_cancelled(ctx)?;
            element.click().map_err(|error| error.to_string())?;
        }
        Action::Click | Action::DoubleClick | Action::Move | Action::Drag => {
            pointer(tab, ctx, input)?
        }
        Action::Type | Action::Select => fill(tab, ctx, input)?,
        Action::Press => {
            let modifiers = input
                .modifiers
                .iter()
                .map(|modifier| match modifier {
                    Modifier::Alt => ModifierKey::Alt,
                    Modifier::Ctrl => ModifierKey::Ctrl,
                    Modifier::Meta => ModifierKey::Meta,
                    Modifier::Shift => ModifierKey::Shift,
                })
                .collect::<Vec<_>>();
            tab.press_key_with_modifiers(
                input.key.as_deref().ok_or("key is required")?,
                Some(&modifiers),
            )
            .map_err(|error| error.to_string())?;
        }
        Action::Scroll => {
            let at = point(tab, input.x, input.y)?;
            let event: Input::DispatchMouseEvent = serde_json::from_value(json!({
                "type": "mouseWheel", "x": at.0, "y": at.1, "deltaX": input.delta_x, "deltaY": input.delta_y,
            })).map_err(|error| error.to_string())?;
            tab.call_method(event).map_err(|error| error.to_string())?;
        }
        Action::Back | Action::Forward => {
            tab.evaluate(
                if input.action == Action::Back {
                    "history.back()"
                } else {
                    "history.forward()"
                },
                false,
            )
            .map_err(|error| error.to_string())?;
        }
        Action::Reload => {
            tab.reload(false, None).map_err(|error| error.to_string())?;
        }
        _ => return Err("not a browser interaction".into()),
    }
    Ok(())
}

fn fill(tab: &Tab, ctx: &ToolContext, input: &BrowserInput) -> Result<(), String> {
    let text = input.text.as_deref().ok_or("text is required")?;
    let element = tab
        .wait_for_element(&selector(input)?)
        .map_err(|error| error.to_string())?;
    observation::check_cancelled(ctx)?;
    validate_element(&element, input.action == Action::Type)?;
    if input.action == Action::Select {
        let result = element.call_js_fn(r#"function(value) {
            if (this.tagName !== 'SELECT' || this.disabled) throw new Error('target must be an enabled select');
            if (![...this.options].some(option => option.value === value && !option.disabled)) throw new Error('option does not exist or is disabled');
            this.value = value;
            this.dispatchEvent(new Event('input', {bubbles:true}));
            this.dispatchEvent(new Event('change', {bubbles:true}));
            return this.value === value;
        }"#, vec![json!(text)], false).map_err(|error| error.to_string())?;
        if result.value != Some(json!(true)) {
            return Err("selection did not persist".into());
        }
        return Ok(());
    }
    element.click().map_err(|error| error.to_string())?;
    observation::check_cancelled(ctx)?;
    if input.clear {
        let selected = element.call_js_fn(r#"function() {
            if (this.isContentEditable) {
                const range = document.createRange(); range.selectNodeContents(this);
                const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
            } else if (typeof this.select === 'function' && !this.disabled && !this.readOnly) { this.select(); }
            else { throw new Error('target is not an editable text field'); }
            return true;
        }"#, vec![], false).map_err(|error| error.to_string())?;
        if selected.value != Some(json!(true)) {
            return Err("unable to select editable text; no input was sent".into());
        }
        tab.press_key("Backspace")
            .map_err(|error| error.to_string())?;
    }
    observation::check_cancelled(ctx)?;
    tab.type_str(text).map_err(|error| error.to_string())?;
    if input.submit {
        observation::check_cancelled(ctx)?;
        tab.press_key("Enter").map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn validate_element(element: &headless_chrome::Element<'_>, editable: bool) -> Result<(), String> {
    let result = element.call_js_fn(r#"function(editable) {
        if (!this.isConnected || this.disabled || this.getAttribute('aria-disabled') === 'true' || this.closest('[inert]')) return false;
        if (editable && (this.readOnly || !(this.isContentEditable || this.tagName === 'TEXTAREA' || (this.tagName === 'INPUT' && ['text','search','email','url','tel','password','number'].includes(this.type))))) return false;
        this.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
        const rect = this.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2);
        return rect.width > 0 && rect.height > 0 && (hit === this || this.contains(hit));
    }"#, vec![json!(editable)], false).map_err(|error| error.to_string())?;
    if result.value != Some(json!(true)) {
        return Err(
            "target is disabled, obscured or not editable; observe again before acting".into(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn targets_are_bound_to_the_current_observation() {
        let mut input = BrowserInput::parse(
            json!({"action":"click","observationId":"abc","target":"rpa-abc-2"}),
        )
        .unwrap();
        assert!(selector(&input).is_ok());
        for value in ["#submit", "rpa-old-2", "rpa-abc-2\"]", "rpa-abc-"] {
            input.target = Some(value.into());
            assert!(selector(&input).is_err());
        }
    }
}
