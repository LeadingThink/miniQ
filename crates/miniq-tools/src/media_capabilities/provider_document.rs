//! Read provider-only parameter tables without claiming an execution adapter.
use super::*;

pub(super) fn parameter_table(html: &str) -> Option<Value> {
    let rows = regex::Regex::new(r"(?is)<tr[^>]*>(.*?)</tr>").ok()?;
    let cells = regex::Regex::new(r"(?is)<t[dh][^>]*>(.*?)</t[dh]>").ok()?;
    let range = regex::Regex::new(r"(\d+)\s*(?:至|到|[-–])\s*(\d+)").ok()?;
    let count = regex::Regex::new(r"最多\s*(\d+)").ok()?;
    let default = regex::Regex::new(r"默认\s*(\d+)").ok()?;
    let ratio = regex::Regex::new(r"\b\d+:\d+\b").ok()?;
    let mut properties = Map::new();
    for row in rows.captures_iter(html) {
        let columns = cells
            .captures_iter(&row[1])
            .map(|cell| {
                html2text::from_read(cell[1].as_bytes(), 1000)
                    .replace('`', "")
                    .trim()
                    .to_owned()
            })
            .collect::<Vec<_>>();
        if columns.len() < 3 {
            continue;
        }
        let field = &columns[0];
        if field.is_empty()
            || !field
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '_' || c.is_ascii_digit())
        {
            continue;
        }
        let type_name = columns[1].trim();
        let mut schema = match type_name {
            "string" | "integer" | "number" | "boolean" | "object" => json!({"type":type_name}),
            "array" => json!({"type":"array"}),
            "string[]" | "array<string>" => json!({"type":"array","items":{"type":"string"}}),
            "object[]" | "array<object>" => json!({"type":"array","items":{"type":"object"}}),
            _ => continue,
        };
        let description = columns[2..].join(" ");
        if type_name == "integer" || type_name == "number" {
            if let Some(bounds) = range.captures(&description) {
                schema["minimum"] = json!(bounds[1].parse::<u64>().ok()?);
                schema["maximum"] = json!(bounds[2].parse::<u64>().ok()?);
            }
            if let Some(value) = default.captures(&description) {
                schema["default"] = json!(value[1].parse::<u64>().ok()?);
            }
        }
        if let Some(value) = count.captures(&description) {
            if schema["type"] == "array" {
                schema["maxItems"] = json!(value[1].parse::<u64>().ok()?);
            }
            if type_name == "string" && description.contains("字符") {
                schema["maxLength"] = json!(value[1].parse::<u64>().ok()?);
            }
        }
        if field == "ratio" || field == "aspect_ratio" {
            let values = ratio
                .find_iter(&description)
                .map(|value| Value::String(value.as_str().to_owned()))
                .collect::<Vec<_>>();
            if !values.is_empty() {
                schema["enum"] = json!(values);
            }
        }
        properties.insert(field.to_owned(), schema);
    }
    if properties.is_empty() {
        return None;
    }
    Some(json!({"type":"object","properties":properties}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_only_parameters_keep_their_original_names_and_ranges() {
        let table = r#"<table><tr><th>字段</th><th>类型</th><th>说明</th></tr>
        <tr><td>seconds</td><td>integer</td><td>4 至 15，默认 6</td></tr>
        <tr><td>ratio</td><td>string</td><td>16:9 或 9:16</td></tr>
        <tr><td>reference_videos</td><td>object[]</td><td>最多 3 个</td></tr></table>"#;
        let schema = parameter_table(table).unwrap();
        assert_eq!(schema["properties"]["seconds"]["minimum"], 4);
        assert_eq!(schema["properties"]["seconds"]["maximum"], 15);
        assert_eq!(schema["properties"]["seconds"]["default"], 6);
        assert_eq!(schema["properties"]["reference_videos"]["maxItems"], 3);
        assert!(schema["properties"].get("duration").is_none());
    }
}
