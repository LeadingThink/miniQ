//! JSON Schema normalization for OpenAI-compatible Chat Completions relays.

use std::collections::BTreeSet;

use serde_json::{Map, Value};

const COMBINATORS: [&str; 3] = ["oneOf", "anyOf", "allOf"];

/// Convert a JSON Schema to the common subset accepted by model-family
/// adapters behind OpenAI-compatible relays. The tool runtime still validates
/// calls against the original schema, so this wire representation may safely
/// broaden conditional constraints that the upstream API cannot express.
pub(crate) fn compatible_tool_schema(schema: &Value) -> Value {
    match schema {
        Value::Array(values) => Value::Array(values.iter().map(compatible_tool_schema).collect()),
        Value::Object(source) => Value::Object(compatible_schema_object(source)),
        _ => schema.clone(),
    }
}

fn compatible_schema_object(source: &Map<String, Value>) -> Map<String, Value> {
    let mut normalized = Map::new();
    for (key, value) in source {
        if !COMBINATORS.contains(&key.as_str()) && key != "const" {
            normalized.insert(key.clone(), normalize_keyword(key, value));
        }
    }
    if let Some(constant) = source.get("const") {
        merge_enum(&mut normalized, std::iter::once(constant.clone()));
    }

    for keyword in COMBINATORS {
        let Some(variants) = source.get(keyword).and_then(Value::as_array) else {
            continue;
        };
        let variants = variants
            .iter()
            .map(compatible_tool_schema)
            .filter_map(|variant| variant.as_object().cloned())
            .collect::<Vec<_>>();
        merge_variants(&mut normalized, &variants, keyword == "allOf");
    }
    normalized
}

fn normalize_keyword(keyword: &str, value: &Value) -> Value {
    match keyword {
        "properties" | "patternProperties" | "$defs" | "definitions" | "dependentSchemas" => {
            let Some(entries) = value.as_object() else {
                return value.clone();
            };
            Value::Object(
                entries
                    .iter()
                    .map(|(name, schema)| (name.clone(), compatible_tool_schema(schema)))
                    .collect(),
            )
        }
        "items"
        | "contains"
        | "additionalProperties"
        | "propertyNames"
        | "not"
        | "if"
        | "then"
        | "else" => compatible_tool_schema(value),
        "prefixItems" => value
            .as_array()
            .map(|schemas| Value::Array(schemas.iter().map(compatible_tool_schema).collect()))
            .unwrap_or_else(|| value.clone()),
        _ => value.clone(),
    }
}

fn merge_variants(
    target: &mut Map<String, Value>,
    variants: &[Map<String, Value>],
    conjunctive: bool,
) {
    if variants.is_empty() {
        return;
    }

    if !target.contains_key("type") {
        merge_equal_keyword(target, variants, "type");
    }
    if !target.contains_key("additionalProperties") {
        merge_equal_keyword(target, variants, "additionalProperties");
    }

    let mut property_definitions = Map::<String, Value>::new();
    let property_names = variants
        .iter()
        .filter_map(|variant| variant.get("properties").and_then(Value::as_object))
        .flat_map(|properties| properties.keys().cloned())
        .collect::<BTreeSet<_>>();
    for name in property_names {
        let definitions = variants
            .iter()
            .filter_map(|variant| {
                variant
                    .get("properties")
                    .and_then(Value::as_object)
                    .and_then(|properties| properties.get(&name))
                    .cloned()
            })
            .collect::<Vec<_>>();
        property_definitions.insert(name, merge_alternatives(&definitions));
    }
    if !property_definitions.is_empty() {
        let properties = target
            .entry("properties")
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(properties) = properties.as_object_mut() {
            for (name, definition) in property_definitions {
                properties.entry(name).or_insert(definition);
            }
        }
    }

    let required = merged_required(variants, conjunctive);
    if !required.is_empty() {
        let existing = target
            .entry("required")
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Some(existing) = existing.as_array_mut() {
            let mut names = existing
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<BTreeSet<_>>();
            names.extend(required);
            *existing = names.into_iter().map(Value::String).collect();
        }
    }

    let enums = variants
        .iter()
        .filter_map(|variant| variant.get("enum").and_then(Value::as_array))
        .flatten()
        .cloned()
        .collect::<Vec<_>>();
    merge_enum(target, enums);
}

fn merge_equal_keyword(
    target: &mut Map<String, Value>,
    variants: &[Map<String, Value>],
    keyword: &str,
) {
    let Some(first) = variants.first().and_then(|variant| variant.get(keyword)) else {
        return;
    };
    if variants
        .iter()
        .all(|variant| variant.get(keyword) == Some(first))
    {
        target.insert(keyword.to_string(), first.clone());
    }
}

fn merged_required(variants: &[Map<String, Value>], conjunctive: bool) -> BTreeSet<String> {
    let sets = variants
        .iter()
        .map(|variant| {
            variant
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<BTreeSet<_>>()
        })
        .collect::<Vec<_>>();
    if conjunctive {
        return sets.into_iter().flatten().collect();
    }
    let Some((first, rest)) = sets.split_first() else {
        return BTreeSet::new();
    };
    rest.iter().fold(first.clone(), |common, set| {
        common.intersection(set).cloned().collect()
    })
}

fn merge_alternatives(definitions: &[Value]) -> Value {
    let mut unique = Vec::<Value>::new();
    for definition in definitions {
        if !unique.contains(definition) {
            unique.push(definition.clone());
        }
    }
    if unique.len() == 1 {
        return unique.pop().expect("one definition");
    }
    let variants = unique
        .iter()
        .filter_map(Value::as_object)
        .cloned()
        .collect::<Vec<_>>();
    if variants.len() != unique.len() {
        return Value::Object(Map::new());
    }
    let mut merged = Map::new();
    merge_variants(&mut merged, &variants, false);
    Value::Object(merged)
}

fn merge_enum(target: &mut Map<String, Value>, values: impl IntoIterator<Item = Value>) {
    let mut merged = target
        .remove("enum")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    for value in values {
        if !merged.contains(&value) {
            merged.push(value);
        }
    }
    if !merged.is_empty() {
        target.insert("enum".into(), Value::Array(merged));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn flattens_nested_unions_without_losing_fields_or_choices() {
        let schema = json!({
            "type": "object",
            "properties": {
                "operation": {
                    "oneOf": [
                        {"type":"object","properties":{"type":{"const":"create_file"},"path":{"type":"string"},"diff":{"type":"string"}},"required":["type","path","diff"]},
                        {"type":"object","properties":{"type":{"const":"delete_file"},"path":{"type":"string"}},"required":["type","path"]}
                    ]
                },
                "patch": {"type":"string"}
            },
            "oneOf": [{"required":["operation"]}, {"required":["patch"]}]
        });

        let normalized = compatible_tool_schema(&schema);
        assert!(normalized.get("oneOf").is_none());
        let operation = &normalized["properties"]["operation"];
        assert!(operation.get("oneOf").is_none());
        assert_eq!(operation["type"], "object");
        assert_eq!(operation["required"], json!(["path", "type"]));
        assert_eq!(
            operation["properties"]["type"]["enum"],
            json!(["create_file", "delete_file"])
        );
        assert_eq!(operation["properties"]["diff"]["type"], "string");
    }

    #[test]
    fn all_of_keeps_every_required_field() {
        let normalized = compatible_tool_schema(&json!({
            "allOf": [
                {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]},
                {"type":"object","properties":{"content":{"type":"string"}},"required":["content"]}
            ]
        }));

        assert_eq!(normalized["type"], "object");
        assert_eq!(normalized["required"], json!(["content", "path"]));
        assert_eq!(normalized["properties"]["content"]["type"], "string");
        assert_eq!(normalized["properties"]["path"]["type"], "string");
    }

    #[test]
    fn property_names_that_match_schema_keywords_are_preserved() {
        let normalized = compatible_tool_schema(&json!({
            "type": "object",
            "properties": {
                "const": {"type":"string"},
                "oneOf": {"type":"boolean"}
            }
        }));

        assert_eq!(normalized["properties"]["const"]["type"], "string");
        assert_eq!(normalized["properties"]["oneOf"]["type"], "boolean");
    }
}
