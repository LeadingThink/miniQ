use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::{ConnectorError, ExternalSessionEvent};

pub(crate) fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub(crate) fn env_root(variable: &str, default_suffix: &[&str]) -> PathBuf {
    if let Some(value) = std::env::var_os(variable).filter(|value| !value.is_empty()) {
        return PathBuf::from(value);
    }
    let mut root = user_home().unwrap_or_default();
    for segment in default_suffix {
        root.push(segment);
    }
    root
}

pub(crate) fn collect_files(
    roots: &[PathBuf],
    extension: &str,
    skipped_prefixes: &[&str],
) -> Result<Vec<PathBuf>, ConnectorError> {
    let mut files = Vec::new();
    for root in roots {
        collect_files_from(root, extension, skipped_prefixes, &mut files)?;
    }
    files.sort();
    Ok(files)
}

fn collect_files_from(
    root: &Path,
    extension: &str,
    skipped_prefixes: &[&str],
    files: &mut Vec<PathBuf>,
) -> Result<(), ConnectorError> {
    if !root.is_dir() {
        return Ok(());
    }
    let entries = std::fs::read_dir(root).map_err(|source| ConnectorError::Io {
        path: root.to_path_buf(),
        source,
    })?;
    for entry in entries {
        let entry = entry.map_err(|source| ConnectorError::Io {
            path: root.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skipped_prefixes
            .iter()
            .any(|prefix| name.starts_with(prefix))
        {
            continue;
        }
        if path.is_dir() {
            collect_files_from(&path, extension, skipped_prefixes, files)?;
        } else if path
            .extension()
            .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        {
            files.push(path);
        }
    }
    Ok(())
}

pub(crate) fn read_jsonl(path: &Path) -> Result<Vec<Value>, ConnectorError> {
    let file = File::open(path).map_err(|source| ConnectorError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut values = Vec::new();
    for (index, line) in BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|source| ConnectorError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str(&line).map_err(|source| ConnectorError::JsonLine {
            path: path.to_path_buf(),
            line: index + 1,
            source,
        })?;
        values.push(value);
    }
    Ok(values)
}

pub(crate) fn nested<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, segment| current.get(segment))
}

pub(crate) fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    nested(value, path)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn first_string(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| string_at(value, path))
}

pub(crate) fn timestamp_at(value: &Value, paths: &[&[&str]]) -> Option<String> {
    paths.iter().find_map(|path| {
        let raw = nested(value, path)?;
        match raw {
            Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_owned()),
            Value::Number(number) => Some(number.to_string()),
            _ => None,
        }
    })
}

pub(crate) fn content_text(value: &Value) -> String {
    let mut parts = Vec::new();
    collect_content_text(value, &mut parts);
    parts.join("\n")
}

fn collect_content_text(value: &Value, parts: &mut Vec<String>) {
    match value {
        Value::String(text) if !text.is_empty() => parts.push(text.clone()),
        Value::Array(items) => {
            for item in items {
                collect_content_text(item, parts);
            }
        }
        Value::Object(object) => {
            let block_type = object
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            match block_type {
                "text" | "input_text" | "output_text" => {
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        parts.push(text.to_owned());
                    }
                }
                "tool_result" => {
                    if let Some(content) = object.get("content") {
                        collect_content_text(content, parts);
                    }
                }
                _ => {
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        parts.push(text.to_owned());
                    } else if let Some(content) = object.get("content") {
                        collect_content_text(content, parts);
                    }
                }
            }
        }
        _ => {}
    }
}

pub(crate) fn raw_event(
    value: Value,
    sequence: usize,
    raw_id: Option<String>,
    event_type: String,
    occurred_at: Option<String>,
) -> ExternalSessionEvent {
    let event_id = match raw_id {
        Some(id) => format!("{sequence}:{id}"),
        None => sequence.to_string(),
    };
    ExternalSessionEvent {
        event_id,
        sequence,
        event_type,
        payload: value,
        occurred_at,
    }
}

pub(crate) fn first_and_last_timestamp(
    events: &[ExternalSessionEvent],
) -> (Option<String>, Option<String>) {
    let timestamps: Vec<&String> = events
        .iter()
        .filter_map(|event| event.occurred_at.as_ref())
        .collect();
    (
        timestamps.first().map(|value| (*value).clone()),
        timestamps.last().map(|value| (*value).clone()),
    )
}
