//! Gemini's OpenAPI Schema transport uses string-only enum entries. Keep
//! non-string choices as JSON guidance rather than changing argument types;
//! the original tool schema remains authoritative for execution validation.

use serde_json::{Map, Value};

use crate::ProviderError;

pub(crate) fn tool_schema(mut schema: Value, tool: &str) -> Result<Value, ProviderError> {
    normalize(&mut schema, "", tool)?;
    Ok(schema)
}

fn normalize(schema: &mut Value, path: &str, tool: &str) -> Result<(), ProviderError> {
    let Some(object) = schema.as_object_mut() else {
        return Ok(());
    };
    normalize_enum(object, path, tool)?;
    for (keyword, value) in object {
        let path = child_path(path, keyword);
        match keyword.as_str() {
            "properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas" => {
                if let Some(entries) = value.as_object_mut() {
                    for (name, child) in entries {
                        normalize(child, &child_path(&path, name), tool)?;
                    }
                }
            }
            "items"
            | "contains"
            | "additionalProperties"
            | "propertyNames"
            | "not"
            | "if"
            | "then"
            | "else" => {
                if let Some(children) = value.as_array_mut() {
                    for (index, child) in children.iter_mut().enumerate() {
                        normalize(child, &child_path(&path, &index.to_string()), tool)?;
                    }
                } else {
                    normalize(value, &path, tool)?;
                }
            }
            "prefixItems" | "oneOf" | "anyOf" | "allOf" => {
                if let Some(children) = value.as_array_mut() {
                    for (index, child) in children.iter_mut().enumerate() {
                        normalize(child, &child_path(&path, &index.to_string()), tool)?;
                    }
                }
            }
            _ => {} // Defaults, examples and enum values are literal data, not schemas.
        }
    }
    Ok(())
}

fn normalize_enum(
    schema: &mut Map<String, Value>,
    path: &str,
    tool: &str,
) -> Result<(), ProviderError> {
    let Some(choices) = schema.get("enum") else {
        return Ok(());
    };
    let enum_path = child_path(path, "enum");
    let choices = choices
        .as_array()
        .filter(|choices| !choices.is_empty())
        .ok_or_else(|| invalid_schema(tool, &enum_path, "enum must be a nonempty array"))?;
    if let Some(kind) = schema.get("type") {
        for (index, choice) in choices.iter().enumerate() {
            if !matches_type(choice, kind) {
                return Err(invalid_schema(
                    tool,
                    &child_path(&enum_path, &index.to_string()),
                    &format!("enum value {choice} does not match declared type {kind}"),
                ));
            }
        }
    }
    if choices.iter().all(Value::is_string) {
        return Ok(());
    }
    let guidance = format!(
        "Allowed values (JSON): {}. Preserve their JSON types.",
        Value::Array(choices.clone())
    );
    let description = match schema.get("description").and_then(Value::as_str) {
        Some(description) if !description.is_empty() => format!("{description}\n{guidance}"),
        _ => guidance,
    };
    schema.remove("enum");
    schema.insert("description".into(), Value::String(description));
    Ok(())
}

fn matches_type(value: &Value, kind: &Value) -> bool {
    match kind {
        Value::Array(kinds) => kinds.iter().any(|kind| matches_type(value, kind)),
        Value::String(kind) => match kind.as_str() {
            "string" => value.is_string(),
            "number" => value.is_number(),
            "integer" => value.as_f64().is_some_and(|number| number.fract() == 0.0),
            "boolean" => value.is_boolean(),
            "null" => value.is_null(),
            "object" => value.is_object(),
            "array" => value.is_array(),
            _ => false,
        },
        _ => false,
    }
}

fn child_path(parent: &str, name: &str) -> String {
    format!("{parent}/{}", name.replace('~', "~0").replace('/', "~1"))
}

fn invalid_schema(tool: &str, path: &str, detail: &str) -> ProviderError {
    ProviderError::Config(format!("Gemini tool `{tool}` schema at {path}: {detail}"))
}
