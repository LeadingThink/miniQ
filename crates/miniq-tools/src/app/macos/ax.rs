//! Owned wrappers around public Accessibility APIs. No application activation.

use std::ffi::c_void;
use std::ptr;

use core_foundation::{
    array::{CFArray, CFArrayRef},
    base::{CFType, CFTypeID, CFTypeRef, TCFType},
    boolean::CFBoolean,
    number::CFNumber,
    string::{CFString, CFStringRef},
};
use core_graphics::geometry::{CGPoint, CGSize};
use serde_json::{json, Value};

use super::super::input::AxValue;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementGetTypeID() -> CFTypeID;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(
        element: CFTypeRef,
        name: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyActionNames(element: CFTypeRef, names: *mut CFArrayRef) -> i32;
    fn AXUIElementIsAttributeSettable(
        element: CFTypeRef,
        name: CFStringRef,
        settable: *mut u8,
    ) -> i32;
    fn AXUIElementSetAttributeValue(element: CFTypeRef, name: CFStringRef, value: CFTypeRef)
        -> i32;
    fn AXUIElementPerformAction(element: CFTypeRef, action: CFStringRef) -> i32;
    fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, timeout: f32) -> i32;
    fn AXUIElementCopyElementAtPosition(
        element: CFTypeRef,
        x: f32,
        y: f32,
        found: *mut CFTypeRef,
    ) -> i32;
    fn AXValueGetTypeID() -> CFTypeID;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, result: *mut c_void) -> u8;
}

#[derive(Clone, PartialEq)]
pub(super) struct Element(CFType);

// AX references are immutable remote IPC handles, not AppKit UI objects. The
// owning AppSnapshot is moved to one blocking worker at a time, never shared.
unsafe impl Send for Element {}

struct ActionTimeout<'a>(&'a Element);

impl<'a> ActionTimeout<'a> {
    fn enter(element: &'a Element) -> Result<Self, String> {
        check(
            unsafe { AXUIElementSetMessagingTimeout(element.0.as_CFTypeRef(), 10.0) },
            "set action timeout",
        )?;
        Ok(Self(element))
    }
}

impl Drop for ActionTimeout<'_> {
    fn drop(&mut self) {
        // A successful action may close its own control/window. Restoring the
        // read timeout is best effort and must never turn that success into an
        // error. The next observation independently checks target liveness.
        unsafe {
            AXUIElementSetMessagingTimeout(self.0 .0.as_CFTypeRef(), 2.0);
        }
    }
}

fn check(code: i32, operation: &str) -> Result<(), String> {
    match code {
        0 => Ok(()),
        -25202 => Err("stale_app_observation: accessibility element no longer exists; inspect again".into()),
        -25204 => Err(format!("app_action_unconfirmed: {operation} did not respond; inspect before considering another action, never replay blindly")),
        -25205 | -25206 | -25208 => Err(format!("background_action_unsupported: {operation} is not exposed by this application")),
        -25211 => Err("computer_permission_required: Accessibility is not available to this execution process".into()),
        _ => Err(format!("application accessibility error {code} during {operation}")),
    }
}

fn optional(code: i32, operation: &str) -> Result<bool, String> {
    if matches!(code, -25205 | -25212) {
        Ok(false)
    } else {
        check(code, operation).map(|()| true)
    }
}

fn check_dispatch(code: i32, operation: &str) -> Result<(), String> {
    // AppKit can apply a selection and then return "unsupported". Once a
    // mutation was sent, the response alone cannot prove that nothing changed.
    check(code, operation).map_err(|error| format!(
        "app_action_unconfirmed: {operation} returned AX error {code} ({error}); inspect the target before any further input, never replay blindly"
    ))
}

impl Element {
    pub(super) fn application(pid: i32) -> Result<Self, String> {
        let raw = unsafe { AXUIElementCreateApplication(pid) };
        if raw.is_null() {
            return Err("application accessibility handle unavailable".into());
        }
        let element = Self(unsafe { CFType::wrap_under_create_rule(raw) });
        check(
            unsafe { AXUIElementSetMessagingTimeout(raw, 2.0) },
            "set AX timeout",
        )?;
        Ok(element)
    }

    fn from_value(value: CFType) -> Result<Self, String> {
        if value.type_of() != unsafe { AXUIElementGetTypeID() } {
            return Err("application returned an invalid accessibility element".into());
        }
        Ok(Self(value))
    }

    fn attribute(&self, name: &str) -> Result<Option<CFType>, String> {
        let attribute = CFString::new(name);
        let mut value = ptr::null();
        let code = unsafe {
            AXUIElementCopyAttributeValue(
                self.0.as_CFTypeRef(),
                attribute.as_concrete_TypeRef(),
                &mut value,
            )
        };
        if !optional(code, &format!("read {name}"))? || value.is_null() {
            return Ok(None);
        }
        Ok(Some(unsafe { CFType::wrap_under_create_rule(value) }))
    }

    pub(super) fn text(&self, name: &str) -> Result<Option<String>, String> {
        Ok(self
            .attribute(name)?
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string()))
    }

    pub(super) fn boolean(&self, name: &str) -> Result<Option<bool>, String> {
        Ok(self
            .attribute(name)?
            .and_then(|value| value.downcast::<CFBoolean>())
            .map(bool::from))
    }

    pub(super) fn number(&self, name: &str) -> Result<Option<f64>, String> {
        Ok(self
            .attribute(name)?
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_f64())
            .filter(|value| value.is_finite()))
    }

    pub(super) fn element(&self, name: &str) -> Result<Option<Self>, String> {
        self.attribute(name)?.map(Self::from_value).transpose()
    }

    pub(super) fn elements(&self, name: &str) -> Result<Vec<Self>, String> {
        let Some(value) = self.attribute(name)? else {
            return Ok(Vec::new());
        };
        let array = value
            .downcast::<CFArray>()
            .ok_or("application returned a non-array accessibility attribute")?;
        array
            .iter()
            .map(|raw| {
                if (*raw).is_null() {
                    return Err("application returned a null child".into());
                }
                Self::from_value(unsafe { CFType::wrap_under_get_rule(*raw) })
            })
            .collect()
    }

    pub(super) fn pid(&self) -> Result<i32, String> {
        let mut pid = 0;
        check(
            unsafe { AXUIElementGetPid(self.0.as_CFTypeRef(), &mut pid) },
            "read element process",
        )?;
        Ok(pid)
    }

    pub(super) fn bounds(&self) -> Result<Option<(CGPoint, CGSize)>, String> {
        let Some(position) = self.attribute("AXPosition")? else {
            return Ok(None);
        };
        let Some(size) = self.attribute("AXSize")? else {
            return Ok(None);
        };
        let type_id = unsafe { AXValueGetTypeID() };
        if position.type_of() != type_id || size.type_of() != type_id {
            return Ok(None);
        }
        let mut point = CGPoint::new(0., 0.);
        let mut dimensions = CGSize::new(0., 0.);
        let valid = unsafe {
            AXValueGetValue(
                position.as_CFTypeRef(),
                1,
                (&mut point as *mut CGPoint).cast(),
            ) != 0
                && AXValueGetValue(
                    size.as_CFTypeRef(),
                    2,
                    (&mut dimensions as *mut CGSize).cast(),
                ) != 0
        };
        Ok(valid.then_some((point, dimensions)))
    }

    pub(super) fn actions(&self) -> Result<Vec<String>, String> {
        let mut raw = ptr::null();
        let code = unsafe { AXUIElementCopyActionNames(self.0.as_CFTypeRef(), &mut raw) };
        if code == -25208 {
            return Ok(Vec::new());
        }
        check(code, "read supported actions")?;
        if raw.is_null() {
            return Ok(Vec::new());
        }
        let array = unsafe { CFArray::<CFTypeRef>::wrap_under_create_rule(raw) };
        array
            .iter()
            .map(|raw| {
                let value = unsafe { CFType::wrap_under_get_rule(*raw) };
                value
                    .downcast::<CFString>()
                    .map(|s| s.to_string())
                    .ok_or_else(|| "application returned a non-string action".into())
            })
            .collect()
    }

    pub(super) fn settable(&self, name: &str) -> Result<bool, String> {
        let mut settable = 0;
        let name = CFString::new(name);
        let code = unsafe {
            AXUIElementIsAttributeSettable(
                self.0.as_CFTypeRef(),
                name.as_concrete_TypeRef(),
                &mut settable,
            )
        };
        Ok(optional(code, "check writable attribute")? && settable != 0)
    }

    pub(super) fn sensitive(&self) -> Result<bool, String> {
        Ok(
            self.text("AXSubrole")?.as_deref() == Some("AXSecureTextField")
                || self.boolean("AXProtectedContent")? == Some(true),
        )
    }

    pub(super) fn check_interactive(&self) -> Result<(), String> {
        if self.sensitive()? {
            return Err(
                "protected_app_element: password and protected fields require the user".into(),
            );
        }
        if self.boolean("AXEnabled")? == Some(false) {
            return Err("app_element_disabled: inspect the current state before acting".into());
        }
        Ok(())
    }

    pub(super) fn press(&self) -> Result<(), String> {
        self.perform_named_action("AXPress")
    }

    pub(super) fn perform_named_action(&self, action: &str) -> Result<(), String> {
        self.check_interactive()?;
        if !self.actions()?.iter().any(|supported| supported == action) {
            return Err(format!(
                "background_action_unsupported: this element does not expose {action}"
            ));
        }
        // Creating an AppKit file-picker service can exceed the metadata read
        // timeout. Still report genuinely unconfirmed actions without replay.
        let _timeout = ActionTimeout::enter(self)?;
        let action = CFString::new(action);
        check_dispatch(
            unsafe {
                AXUIElementPerformAction(self.0.as_CFTypeRef(), action.as_concrete_TypeRef())
            },
            "perform element action",
        )
    }

    pub(super) fn selection_settable(&self) -> Result<bool, String> {
        if self.settable("AXSelected")? {
            return Ok(true);
        }
        match self.element("AXParent")? {
            Some(parent) => parent.settable("AXSelectedChildren"),
            None => Ok(false),
        }
    }

    pub(super) fn select(&self) -> Result<&'static str, String> {
        self.check_interactive()?;
        if self.settable("AXSelected")? {
            self.set_attribute("AXSelected", &CFBoolean::true_value().as_CFType())?;
            return Ok("AXSelected");
        }
        let parent = self
            .element("AXParent")?
            .ok_or("background_action_unsupported: this element has no selectable parent")?;
        parent.check_interactive()?;
        let selection = CFArray::from_CFTypes(std::slice::from_ref(&self.0));
        parent.set_attribute("AXSelectedChildren", &selection.as_CFType())?;
        Ok("AXSelectedChildren")
    }

    pub(super) fn set_value(&self, value: &AxValue) -> Result<(), String> {
        self.check_interactive()?;
        let (minimum, maximum) = if matches!(value, AxValue::Number { .. }) {
            (self.number("AXMinValue")?, self.number("AXMaxValue")?)
        } else {
            (None, None)
        };
        validate_value(value, &self.value()?, minimum, maximum)?;
        let value = match value {
            AxValue::Text { text } => CFString::new(text).as_CFType(),
            AxValue::Number { number } => CFNumber::from(*number).as_CFType(),
            AxValue::Boolean { boolean } => CFBoolean::from(*boolean).as_CFType(),
        };
        self.set_attribute("AXValue", &value)
    }

    pub(super) fn replace_selection(&self, text: &str) -> Result<(), String> {
        self.set_text("AXSelectedText", text)
    }

    fn set_text(&self, attribute: &str, text: &str) -> Result<(), String> {
        self.set_attribute(attribute, &CFString::new(text).as_CFType())
    }

    fn set_attribute(&self, attribute: &str, value: &CFType) -> Result<(), String> {
        self.check_interactive()?;
        if !self.settable(attribute)? {
            return Err(format!("background_action_unsupported: this element does not expose a writable {attribute}"));
        }
        let name = CFString::new(attribute);
        check_dispatch(
            unsafe {
                AXUIElementSetAttributeValue(
                    self.0.as_CFTypeRef(),
                    name.as_concrete_TypeRef(),
                    value.as_CFTypeRef(),
                )
            },
            &format!("set {attribute}"),
        )
    }

    pub(super) fn value(&self) -> Result<Value, String> {
        if self.sensitive()? {
            return Ok(Value::Null);
        }
        let Some(value) = self.attribute("AXValue")? else {
            return Ok(Value::Null);
        };
        if let Some(text) = value.downcast::<CFString>() {
            return Ok(json!(text.to_string()));
        }
        if let Some(boolean) = value.downcast::<CFBoolean>() {
            return Ok(json!(bool::from(boolean)));
        }
        if let Some(number) = value.downcast::<CFNumber>() {
            return Ok(json!(number.to_f64()));
        }
        Ok(Value::Null)
    }

    pub(super) fn at_position(&self, x: f64, y: f64) -> Result<Self, String> {
        let mut raw = ptr::null();
        check(
            unsafe {
                AXUIElementCopyElementAtPosition(
                    self.0.as_CFTypeRef(),
                    x as f32,
                    y as f32,
                    &mut raw,
                )
            },
            "hit test target application",
        )?;
        if raw.is_null() {
            return Err(
                "background_action_unsupported: no accessibility element at this point".into(),
            );
        }
        Self::from_value(unsafe { CFType::wrap_under_create_rule(raw) })
    }
}

fn validate_value(
    value: &AxValue,
    current: &Value,
    minimum: Option<f64>,
    maximum: Option<f64>,
) -> Result<(), String> {
    let matching_type = match value {
        AxValue::Text { .. } => current.is_string(),
        AxValue::Number { .. } => current.is_number(),
        AxValue::Boolean { .. } => current.is_boolean(),
    };
    if !matching_type {
        return Err(
            "background_action_unsupported: value must match the element's readable AXValue type"
                .into(),
        );
    }
    if let AxValue::Number { number } = value {
        if !number.is_finite()
            || minimum.is_some_and(|minimum| *number < minimum)
            || maximum.is_some_and(|maximum| *number > maximum)
        {
            return Err("app_value_out_of_range: value must be finite and inside the element's AXMinValue/AXMaxValue bounds".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unsupported_dispatch_response_does_not_prove_no_mutation_happened() {
        assert!(check(-25205, "preflight")
            .unwrap_err()
            .starts_with("background_action_unsupported"));
        assert!(check_dispatch(-25205, "set AXSelectedChildren")
            .unwrap_err()
            .starts_with("app_action_unconfirmed"));
        assert!(check_dispatch(0, "set AXSelectedChildren").is_ok());
    }

    #[test]
    fn scalar_values_preserve_type_and_observed_numeric_bounds() {
        assert!(validate_value(
            &AxValue::Text {
                text: "hello".into()
            },
            &json!(""),
            None,
            None
        )
        .is_ok());
        assert!(validate_value(
            &AxValue::Boolean { boolean: true },
            &json!(false),
            None,
            None
        )
        .is_ok());
        for number in [0., 0.5, 1.] {
            assert!(
                validate_value(&AxValue::Number { number }, &json!(0.), Some(0.), Some(1.)).is_ok()
            );
        }
        for number in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
            assert!(
                validate_value(&AxValue::Number { number }, &json!(0.), Some(0.), Some(1.))
                    .is_err()
            );
        }
        for current in [json!("0"), json!(true), Value::Null] {
            assert!(validate_value(&AxValue::Number { number: 0. }, &current, None, None).is_err());
        }
        assert!(
            validate_value(&AxValue::Text { text: "1".into() }, &json!(0.), None, None).is_err()
        );
    }
}
