//! Minimal JSON Schema support for `exec --output-schema`.
//!
//! Only the keywords scripts rely on most are enforced: `type` (string or list), `required`,
//! `properties`, `additionalProperties: false`, `items` and `enum`. Other keywords are ignored.

use anyhow::{bail, Context, Result};
use serde_json::Value;

/// Load a schema from inline JSON (starting with `{`) or from a file path.
pub fn load(source: &str) -> Result<Value> {
    let text = if source.trim_start().starts_with('{') {
        source.to_owned()
    } else {
        std::fs::read_to_string(source).with_context(|| format!("read output schema {source}"))?
    };
    let schema: Value = serde_json::from_str(&text).context("output schema is not valid JSON")?;
    if !schema.is_object() {
        bail!("output schema must be a JSON object");
    }
    Ok(schema)
}

/// Instructions appended to the prompt so the model answers with JSON only.
pub fn instructions(schema: &Value) -> String {
    format!(
        "\n\n[output format]\nRespond with only one JSON value that conforms to the JSON Schema below. \
         Do not add prose or Markdown outside the JSON.\n{}",
        serde_json::to_string_pretty(schema).unwrap_or_default()
    )
}

/// Parse the model's final text, tolerating a surrounding ```json fence.
pub fn parse(text: &str) -> Result<Value, String> {
    let trimmed = text.trim();
    let body = match trimmed.strip_prefix("```") {
        Some(rest) => {
            let rest = rest.split_once('\n').map_or("", |(_, body)| body);
            rest.trim_end().strip_suffix("```").unwrap_or(rest).trim()
        }
        None => trimmed,
    };
    serde_json::from_str(body).map_err(|error| format!("final answer is not valid JSON: {error}"))
}

/// Validate `value` against `schema`; the error names the failing JSON path.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    check(schema, value, "$")
}

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.is_i64() || value.is_u64(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn check(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    if let Some(expected) = schema.get("type") {
        let types: Vec<&str> = match expected {
            Value::String(name) => vec![name.as_str()],
            Value::Array(names) => names.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        if !types.is_empty() && !types.iter().any(|name| type_matches(name, value)) {
            return Err(format!(
                "{path}: expected {}, got {value}",
                types.join(" or ")
            ));
        }
    }
    if let Some(Value::Array(allowed)) = schema.get("enum") {
        if !allowed.contains(value) {
            return Err(format!("{path}: {value} is not one of the allowed values"));
        }
    }
    if let Value::Object(object) = value {
        if let Some(Value::Array(required)) = schema.get("required") {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("{path}: missing required property `{key}`"));
                }
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        for (key, item) in object {
            match properties.and_then(|properties| properties.get(key)) {
                Some(child) => check(child, item, &format!("{path}.{key}"))?,
                None if schema.get("additionalProperties") == Some(&Value::Bool(false)) => {
                    return Err(format!("{path}: unexpected property `{key}`"));
                }
                None => {}
            }
        }
    }
    if let (Value::Array(items), Some(child)) = (value, schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            check(child, item, &format!("{path}[{index}]"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({
            "type": "object",
            "required": ["name", "tags"],
            "properties": {
                "name": {"type": "string"},
                "count": {"type": ["integer", "null"]},
                "tags": {"type": "array", "items": {"type": "string", "enum": ["a", "b"]}},
                "nested": {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
            },
            "additionalProperties": false
        })
    }

    #[test]
    fn accepts_valid_documents_and_fences() {
        let value = parse("```json\n{\"name\":\"x\",\"tags\":[\"a\"],\"count\":null,\"nested\":{\"ok\":true}}\n```").unwrap();
        assert_eq!(validate(&schema(), &value), Ok(()));
        let value = parse("  {\"name\":\"x\",\"tags\":[],\"count\":3}  ").unwrap();
        assert_eq!(validate(&schema(), &value), Ok(()));
        assert!(parse("```\n[1]\n```").is_ok());
    }

    #[test]
    fn reports_the_failing_path() {
        let cases = [
            (json!({"tags": []}), "missing required property `name`"),
            (json!({"name": 1, "tags": []}), "$.name: expected string"),
            (json!({"name": "x", "tags": ["c"]}), "$.tags[0]"),
            (json!({"name": "x", "tags": [], "count": 1.5}), "$.count"),
            (
                json!({"name": "x", "tags": [], "nested": {}}),
                "$.nested: missing required property `ok`",
            ),
            (
                json!({"name": "x", "tags": [], "extra": 1}),
                "unexpected property `extra`",
            ),
            (json!([]), "$: expected object"),
        ];
        for (value, needle) in cases {
            let error = validate(&schema(), &value).unwrap_err();
            assert!(error.contains(needle), "{error} should contain {needle}");
        }
    }

    #[test]
    fn rejects_prose_and_loads_inline_or_file_schemas() {
        assert!(parse("Here is the JSON: {}").is_err());
        assert!(load("{\"type\":\"object\"}").is_ok());
        assert!(load("[1]").is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema.json");
        std::fs::write(&path, "{\"type\":\"string\"}").unwrap();
        assert_eq!(load(path.to_str().unwrap()).unwrap()["type"], "string");
        assert!(load(dir.path().join("missing.json").to_str().unwrap()).is_err());
    }
}
