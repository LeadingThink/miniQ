use miniq_models::ToolCallRequest;
use serde_json::{json, Map, Value};

use super::names::type_glob;
use super::NativeToolError;

pub(crate) fn object(call: &ToolCallRequest) -> Result<&Map<String, Value>, NativeToolError> {
    call.arguments
        .as_object()
        .ok_or_else(|| NativeToolError::invalid(call, "tool arguments must be a JSON object"))
}

pub(super) fn remap(
    call: &ToolCallRequest,
    fields: &[(&str, &str)],
    ignored: &[&str],
) -> Result<Value, NativeToolError> {
    let input = object(call)?;
    let mut output = Map::new();
    for key in input.keys() {
        if !fields.iter().any(|(source, _)| source == key) && !ignored.contains(&key.as_str()) {
            return Err(NativeToolError::invalid(
                call,
                format!("unsupported argument `{key}` for {}", call.name),
            ));
        }
    }
    for (source, destination) in fields {
        let Some(value) = input.get(*source) else {
            continue;
        };
        if let Some(existing) = output.get(*destination) {
            if existing != value {
                return Err(NativeToolError::invalid(
                    call,
                    format!("conflicting values for `{destination}`"),
                ));
            }
        } else {
            output.insert((*destination).to_string(), value.clone());
        }
    }
    Ok(Value::Object(output))
}

pub(super) fn adapt_shell(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let input = object(call)?;
    for key in [
        "run_in_background",
        "dangerouslyDisableSandbox",
        "tty",
        "login",
    ] {
        if input.contains_key(key) && !input[key].is_boolean() {
            return Err(NativeToolError::invalid(
                call,
                format!("{key} must be a boolean"),
            ));
        }
    }
    if input
        .get("dangerouslyDisableSandbox")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Err(NativeToolError::unsupported(
            call,
            "dangerouslyDisableSandbox cannot bypass miniQ workspace and approval controls",
        ));
    }
    let mut output = remap(
        call,
        &[
            ("command", "command"),
            ("cmd", "command"),
            ("cwd", "cwd"),
            ("workdir", "cwd"),
            ("working_directory", "cwd"),
            ("timeoutSecs", "timeoutSecs"),
            ("env", "env"),
            ("run_in_background", "runInBackground"),
            ("runInBackground", "runInBackground"),
        ],
        &[
            "description",
            "run_in_background",
            "dangerouslyDisableSandbox",
            "yield_time_ms",
            "max_output_tokens",
            "justification",
            "prefix_rule",
            "sandbox_permissions",
            "login",
            "tty",
            "timeout",
            "timeout_ms",
            "timeoutMs",
        ],
    )?;
    for key in ["tty", "login"] {
        if input.get(key).and_then(Value::as_bool) == Some(true) {
            return Err(NativeToolError::unsupported(
                call,
                format!("{key}=true is not supported by miniQ's non-interactive shell"),
            ));
        }
    }
    if input.contains_key("shell") {
        return Err(NativeToolError::unsupported(
            call,
            "selecting a different shell is not supported",
        ));
    }
    if let Some(permission) = input.get("sandbox_permissions") {
        match permission.as_str() {
            Some("use_default") => {}
            Some("require_escalated") => {
                return Err(NativeToolError::unsupported(
                    call,
                    "sandbox escalation cannot bypass miniQ approval controls",
                ));
            }
            _ => {
                return Err(NativeToolError::invalid(
                    call,
                    "sandbox_permissions must be use_default or require_escalated",
                ));
            }
        }
    }
    let millis = ["timeout", "timeout_ms", "timeoutMs"]
        .iter()
        .find_map(|key| input.get(*key));
    if let Some(value) = millis {
        if input.contains_key("timeoutSecs") {
            return Err(NativeToolError::invalid(
                call,
                "timeoutSecs cannot be combined with a millisecond timeout",
            ));
        }
        let millis = value
            .as_u64()
            .ok_or_else(|| NativeToolError::invalid(call, "shell timeout must be milliseconds"))?;
        output["timeoutSecs"] = json!(millis.div_ceil(1000).max(1));
    }
    Ok(output)
}

pub(super) fn adapt_process_output(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let input = object(call)?;
    let mut output = remap(
        call,
        &[
            ("task_id", "id"),
            ("shell_id", "id"),
            ("id", "id"),
            ("block", "block"),
            ("timeout_secs", "timeoutSecs"),
        ],
        &["timeout", "timeout_ms"],
    )?;
    let millis = ["timeout", "timeout_ms"]
        .iter()
        .find_map(|key| input.get(*key));
    if let Some(value) = millis {
        if input.contains_key("timeout_secs") {
            return Err(NativeToolError::invalid(
                call,
                "timeout_secs cannot be combined with a millisecond timeout",
            ));
        }
        let millis = value.as_u64().ok_or_else(|| {
            NativeToolError::invalid(call, "TaskOutput timeout must be milliseconds")
        })?;
        output["timeoutSecs"] = json!(millis.div_ceil(1000).max(1));
    }
    Ok(output)
}

pub(super) fn adapt_read(call: &ToolCallRequest) -> Result<(&'static str, Value), NativeToolError> {
    let input = object(call)?;
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str);
    let extension = path
        .and_then(|path| path.rsplit_once('.').map(|(_, extension)| extension))
        .map(str::to_ascii_lowercase);
    let document = extension.as_deref().is_some_and(|extension| {
        matches!(
            extension,
            "pdf" | "docx" | "pptx" | "xlsx" | "xls" | "xlsm" | "ods" | "csv"
        )
    });
    let target = if document { "doc_read" } else { "file_read" };
    let fields = if document {
        &[
            ("file_path", "path"),
            ("path", "path"),
            ("offset", "lineOffset"),
            ("limit", "lineLimit"),
            ("pages", "pages"),
        ][..]
    } else {
        &[
            ("file_path", "path"),
            ("path", "path"),
            ("offset", "offset"),
            ("limit", "limit"),
        ][..]
    };
    let mut output = remap(call, fields, &["view_range"])?;
    if input.contains_key("pages") && extension.as_deref() != Some("pdf") {
        return Err(NativeToolError::invalid(
            call,
            "pages is valid only when Read targets a PDF",
        ));
    }
    if let Some(range) = input.get("view_range") {
        let (offset_key, limit_key) = if document {
            ("lineOffset", "lineLimit")
        } else {
            ("offset", "limit")
        };
        if output.get(offset_key).is_some() || output.get(limit_key).is_some() {
            return Err(NativeToolError::invalid(
                call,
                "view_range cannot be combined with offset or limit",
            ));
        }
        let range = range
            .as_array()
            .filter(|range| range.len() == 2)
            .ok_or_else(|| {
                NativeToolError::invalid(call, "view_range must be [start_line, end_line]")
            })?;
        let start = range[0]
            .as_u64()
            .ok_or_else(|| NativeToolError::invalid(call, "view_range start must be an integer"))?;
        let end = range[1]
            .as_u64()
            .ok_or_else(|| NativeToolError::invalid(call, "view_range end must be an integer"))?;
        if start == 0 || end < start {
            return Err(NativeToolError::invalid(
                call,
                "view_range must be 1-based and ordered",
            ));
        }
        output[offset_key] = json!(start);
        output[limit_key] = json!(end - start + 1);
    }
    Ok((target, output))
}

pub(super) fn adapt_multi_edit(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let mut output = remap(
        call,
        &[("file_path", "path"), ("path", "path"), ("edits", "edits")],
        &[],
    )?;
    let edits = output["edits"]
        .as_array()
        .ok_or_else(|| NativeToolError::invalid(call, "edits must be an array"))?;
    let mut normalized = Vec::with_capacity(edits.len());
    for edit in edits {
        let nested = ToolCallRequest {
            id: call.id.clone(),
            name: call.name.clone(),
            arguments: edit.clone(),
        };
        normalized.push(remap(
            &nested,
            &[
                ("old_string", "oldString"),
                ("oldString", "oldString"),
                ("new_string", "newString"),
                ("newString", "newString"),
                ("replace_all", "replaceAll"),
                ("replaceAll", "replaceAll"),
            ],
            &[],
        )?);
    }
    output["edits"] = Value::Array(normalized);
    Ok(output)
}

pub(super) fn adapt_grep(call: &ToolCallRequest) -> Result<Value, NativeToolError> {
    let mut output = remap(
        call,
        &[
            ("pattern", "pattern"),
            ("path", "path"),
            ("glob", "glob"),
            ("output_mode", "outputMode"),
            ("outputMode", "outputMode"),
            ("head_limit", "maxResults"),
            ("max_results", "maxResults"),
            ("maxResults", "maxResults"),
            ("offset", "offset"),
            ("multiline", "multiline"),
            ("before_context", "beforeContext"),
            ("after_context", "afterContext"),
            ("-B", "beforeContext"),
            ("-A", "afterContext"),
            ("-C", "context"),
            ("type", "type"),
            ("case_insensitive", "caseInsensitive"),
            ("caseInsensitive", "caseInsensitive"),
            ("-i", "caseInsensitive"),
        ],
        &["-n"],
    )?;
    if output.get("outputMode").is_none() {
        output["outputMode"] = json!("files_with_matches");
    }
    if let Some(context) = output
        .as_object_mut()
        .and_then(|arguments| arguments.remove("context"))
    {
        if output.get("beforeContext").is_some() || output.get("afterContext").is_some() {
            return Err(NativeToolError::invalid(
                call,
                "-C cannot be combined with -A or -B",
            ));
        }
        output["beforeContext"] = context.clone();
        output["afterContext"] = context;
    }
    if let Some(kind) = output
        .as_object_mut()
        .and_then(|arguments| arguments.remove("type"))
    {
        if output.get("glob").is_some() {
            return Err(NativeToolError::invalid(
                call,
                "type cannot be combined with glob",
            ));
        }
        let kind = kind
            .as_str()
            .ok_or_else(|| NativeToolError::invalid(call, "grep type must be a string"))?;
        output["glob"] = json!(type_glob(kind).ok_or_else(|| {
            NativeToolError::invalid(call, format!("unsupported grep type `{kind}`"))
        })?);
    }
    Ok(output)
}
