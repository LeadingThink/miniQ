//! Provider-native apply_patch support with workspace containment and rollback.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::apply_patch_diff::{apply_diff, create_content};
use crate::router::{Tool, ToolContext, ToolError};

pub struct ApplyPatchTool;

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum PatchOperation {
    #[serde(rename = "create_file")]
    Create { path: String, diff: String },
    #[serde(rename = "update_file")]
    Update { path: String, diff: String },
    #[serde(rename = "delete_file")]
    Delete { path: String },
    #[serde(rename = "move_file")]
    Move {
        path: String,
        new_path: String,
        diff: String,
    },
}

impl PatchOperation {
    fn paths(&self) -> Vec<&str> {
        match self {
            Self::Create { path, .. } | Self::Update { path, .. } | Self::Delete { path } => {
                vec![path]
            }
            Self::Move { path, new_path, .. } => vec![path, new_path],
        }
    }
}

fn parse_operations(input: &Value) -> Result<Vec<PatchOperation>, ToolError> {
    let object = input
        .as_object()
        .ok_or_else(|| ToolError::InvalidInput("apply_patch input must be an object".into()))?;
    if let Some(patch) = object.get("patch") {
        if object.len() != 1 {
            return Err(ToolError::InvalidInput(
                "patch cannot be combined with structured operation fields".into(),
            ));
        }
        let patch = patch
            .as_str()
            .ok_or_else(|| ToolError::InvalidInput("patch must be a string".into()))?;
        return parse_text_patch(patch);
    }
    if let Some(operation) = object.get("operation") {
        if object.len() != 1 {
            return Err(ToolError::InvalidInput(
                "operation cannot be combined with other fields".into(),
            ));
        }
        return serde_json::from_value(operation.clone())
            .map(|operation| vec![operation])
            .map_err(|error| ToolError::InvalidInput(error.to_string()));
    }
    serde_json::from_value(input.clone())
        .map(|operation| vec![operation])
        .map_err(|error| ToolError::InvalidInput(error.to_string()))
}

pub fn affected_paths(input: &Value) -> Result<Vec<String>, ToolError> {
    let mut paths = parse_operations(input)?
        .iter()
        .flat_map(PatchOperation::paths)
        .map(str::to_string)
        .collect::<Vec<_>>();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

#[async_trait]
impl Tool for ApplyPatchTool {
    fn name(&self) -> &str {
        "apply_patch"
    }

    fn description(&self) -> &str {
        "Apply OpenAI structured create/update/delete operations or a Codex Begin Patch block. All paths stay inside the workspace and multi-file failures roll back."
    }

    fn parameters_schema(&self) -> Value {
        let operation = json!({
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "create_file"},
                        "path": {"type": "string"},
                        "diff": {"type": "string"}
                    },
                    "required": ["type", "path", "diff"],
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "update_file"},
                        "path": {"type": "string"},
                        "diff": {"type": "string"}
                    },
                    "required": ["type", "path", "diff"],
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "delete_file"},
                        "path": {"type": "string"}
                    },
                    "required": ["type", "path"],
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "type": {"const": "move_file"},
                        "path": {"type": "string"},
                        "new_path": {"type": "string"},
                        "diff": {"type": "string"}
                    },
                    "required": ["type", "path", "new_path", "diff"],
                    "additionalProperties": false
                }
            ]
        });
        json!({
            "type": "object",
            "properties": {
                "operation": operation,
                "patch": {"type": "string", "description": "Codex *** Begin Patch block"}
            },
            "oneOf": [{"required": ["operation"]}, {"required": ["patch"]}],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        let paths = match affected_paths(input) {
            Ok(paths) if !paths.is_empty() => paths,
            Ok(_) => return blocked("patch has no file operations"),
            Err(error) => return blocked(&error.to_string()),
        };
        for path in paths {
            if let Err(error) = resolve_in_workspace(&ctx.workspace, &path) {
                return blocked(&error.to_string());
            }
        }
        Risk {
            level: RiskLevel::Medium,
            reason: "applies a structured file patch inside the workspace".into(),
        }
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let operations = parse_operations(&input)?;
        if operations.is_empty() {
            return Err(ToolError::InvalidInput(
                "patch has no file operations".into(),
            ));
        }
        let workspace = ctx.workspace.clone();
        tokio::task::spawn_blocking(move || apply_operations(&workspace, &operations))
            .await
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?
    }
}

fn blocked(reason: &str) -> Risk {
    Risk {
        level: RiskLevel::Blocked,
        reason: reason.into(),
    }
}

fn apply_operations(workspace: &Path, operations: &[PatchOperation]) -> Result<Value, ToolError> {
    let mut files = BTreeMap::<PathBuf, FileState>::new();
    for operation in operations {
        stage_operation(workspace, operation, &mut files)?;
    }
    let summaries = operations
        .iter()
        .map(|operation| match operation {
            PatchOperation::Create { path, .. } => json!({"type":"create_file","path":path}),
            PatchOperation::Update { path, .. } => json!({"type":"update_file","path":path}),
            PatchOperation::Delete { path } => json!({"type":"delete_file","path":path}),
            PatchOperation::Move { path, new_path, .. } => {
                json!({"type":"move_file","path":path,"newPath":new_path})
            }
        })
        .collect::<Vec<_>>();
    commit_files(&files)?;
    Ok(json!({"status":"completed", "operations": summaries}))
}

#[derive(Clone)]
struct FileState {
    original: Option<Vec<u8>>,
    updated: Option<Vec<u8>>,
}

fn file_state<'a>(
    files: &'a mut BTreeMap<PathBuf, FileState>,
    path: &Path,
) -> Result<&'a mut FileState, ToolError> {
    if !files.contains_key(path) {
        let original = match std::fs::read(path) {
            Ok(content) => Some(content),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => {
                return Err(ToolError::ExecutionFailed(format!(
                    "read {}: {error}",
                    path.display()
                )))
            }
        };
        files.insert(
            path.to_path_buf(),
            FileState {
                updated: original.clone(),
                original,
            },
        );
    }
    Ok(files.get_mut(path).expect("state inserted"))
}

fn stage_operation(
    workspace: &Path,
    operation: &PatchOperation,
    files: &mut BTreeMap<PathBuf, FileState>,
) -> Result<(), ToolError> {
    match operation {
        PatchOperation::Create { path, diff } => {
            let path = resolve_path(workspace, path)?;
            let state = file_state(files, &path)?;
            if state.updated.is_some() {
                return Err(ToolError::ExecutionFailed(format!(
                    "create target already exists: {}",
                    path.display()
                )));
            }
            state.updated = Some(create_content(diff).into_bytes());
        }
        PatchOperation::Update { path, diff } => {
            let path = resolve_path(workspace, path)?;
            let state = file_state(files, &path)?;
            let current = state.updated.as_deref().ok_or_else(|| {
                ToolError::ExecutionFailed(format!("update target not found: {}", path.display()))
            })?;
            state.updated = Some(apply_diff(current, diff)?.into_bytes());
        }
        PatchOperation::Delete { path } => {
            let path = resolve_path(workspace, path)?;
            let state = file_state(files, &path)?;
            if state.updated.is_none() {
                return Err(ToolError::ExecutionFailed(format!(
                    "delete target not found: {}",
                    path.display()
                )));
            }
            state.updated = None;
        }
        PatchOperation::Move {
            path,
            new_path,
            diff,
        } => {
            let source = resolve_path(workspace, path)?;
            let target = resolve_path(workspace, new_path)?;
            let current = file_state(files, &source)?.updated.clone().ok_or_else(|| {
                ToolError::ExecutionFailed(format!("move source not found: {}", source.display()))
            })?;
            if file_state(files, &target)?.updated.is_some() {
                return Err(ToolError::ExecutionFailed(format!(
                    "move target already exists: {}",
                    target.display()
                )));
            }
            let updated = if diff.trim().is_empty() {
                current
            } else {
                apply_diff(&current, diff)?.into_bytes()
            };
            file_state(files, &source)?.updated = None;
            file_state(files, &target)?.updated = Some(updated);
        }
    }
    Ok(())
}

fn resolve_path(workspace: &Path, path: &str) -> Result<PathBuf, ToolError> {
    resolve_in_workspace(workspace, path)
        .map_err(|error| ToolError::SandboxDenied(error.to_string()))
}

fn commit_files(files: &BTreeMap<PathBuf, FileState>) -> Result<(), ToolError> {
    let mut applied = Vec::new();
    for (path, state) in files {
        let result = write_state(path, state.updated.as_deref());
        if let Err(error) = result {
            for prior in applied.into_iter().rev() {
                let previous = files.get(prior).and_then(|state| state.original.as_deref());
                let _ = write_state(prior, previous);
            }
            return Err(error);
        }
        applied.push(path);
    }
    Ok(())
}

fn write_state(path: &Path, content: Option<&[u8]>) -> Result<(), ToolError> {
    match content {
        Some(content) => {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
            }
            std::fs::write(path, content).map_err(|error| {
                ToolError::ExecutionFailed(format!("write {}: {error}", path.display()))
            })
        }
        None if path.exists() => std::fs::remove_file(path).map_err(|error| {
            ToolError::ExecutionFailed(format!("delete {}: {error}", path.display()))
        }),
        None => Ok(()),
    }
}

fn parse_text_patch(patch: &str) -> Result<Vec<PatchOperation>, ToolError> {
    let lines = patch.lines().collect::<Vec<_>>();
    if lines.first().copied() != Some("*** Begin Patch")
        || lines.last().copied() != Some("*** End Patch")
    {
        return Err(ToolError::InvalidInput(
            "text patch must start with *** Begin Patch and end with *** End Patch".into(),
        ));
    }
    let mut operations = Vec::new();
    let mut index = 1;
    while index + 1 < lines.len() {
        let header = lines[index];
        index += 1;
        let new_path = if header.starts_with("*** Update File: ") {
            let new_path = lines
                .get(index)
                .and_then(|line| line.strip_prefix("*** Move to: "));
            if new_path.is_some() {
                index += 1;
            }
            new_path
        } else {
            None
        };
        let mut body = Vec::new();
        while index + 1 < lines.len() && !lines[index].starts_with("*** ") {
            body.push(lines[index]);
            index += 1;
        }
        if let Some(path) = header.strip_prefix("*** Add File: ") {
            operations.push(PatchOperation::Create {
                path: path.into(),
                diff: body.join("\n") + "\n",
            });
        } else if let Some(path) = header.strip_prefix("*** Delete File: ") {
            if !body.is_empty() {
                return Err(ToolError::InvalidInput(
                    "Delete File section must not contain a diff".into(),
                ));
            }
            operations.push(PatchOperation::Delete { path: path.into() });
        } else if let Some(path) = header.strip_prefix("*** Update File: ") {
            let operation = match new_path {
                Some(new_path) => PatchOperation::Move {
                    path: path.into(),
                    new_path: new_path.into(),
                    diff: body.join("\n") + "\n",
                },
                None => PatchOperation::Update {
                    path: path.into(),
                    diff: body.join("\n") + "\n",
                },
            };
            operations.push(operation);
        } else {
            return Err(ToolError::InvalidInput(format!(
                "unsupported patch section: {header}"
            )));
        }
    }
    Ok(operations)
}

#[cfg(test)]
#[path = "apply_patch/tests.rs"]
mod tests;
