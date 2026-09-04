//! Structured Jupyter notebook cell editing for Claude-compatible calls.

use async_trait::async_trait;
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::file::path_risk;
use crate::router::{parse_input, Tool, ToolContext, ToolError};

pub struct NotebookEditTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NotebookEditInput {
    path: String,
    #[serde(default)]
    cell_id: Option<String>,
    #[serde(default)]
    new_source: String,
    #[serde(default)]
    cell_type: Option<CellType>,
    #[serde(default)]
    edit_mode: EditMode,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CellType {
    Code,
    Markdown,
    Raw,
}

impl CellType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Markdown => "markdown",
            Self::Raw => "raw",
        }
    }
}

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EditMode {
    #[default]
    Replace,
    Insert,
    Delete,
}

impl EditMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Replace => "replace",
            Self::Insert => "insert",
            Self::Delete => "delete",
        }
    }
}

#[async_trait]
impl Tool for NotebookEditTool {
    fn name(&self) -> &str {
        "notebook_edit"
    }

    fn description(&self) -> &str {
        "Replace, insert or delete a Jupyter notebook cell by cell id. Requires approval."
    }

    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "cellId": {"type": "string"},
                "newSource": {"type": "string"},
                "cellType": {"type": "string", "enum": ["code", "markdown", "raw"]},
                "editMode": {"type": "string", "enum": ["replace", "insert", "delete"]}
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(
            ctx,
            input,
            RiskLevel::Medium,
            "edits a Jupyter notebook in the workspace",
        )
    }

    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let input: NotebookEditInput = parse_input(input)?;
        let path = resolve_in_workspace(&ctx.workspace, &input.path)
            .map_err(|error| ToolError::SandboxDenied(error.to_string()))?;
        let content = tokio::fs::read(&path).await.map_err(|error| {
            ToolError::ExecutionFailed(format!("read {}: {error}", path.display()))
        })?;
        let mut notebook: Value = serde_json::from_slice(&content)
            .map_err(|error| ToolError::InvalidInput(format!("invalid notebook JSON: {error}")))?;
        let cells = notebook
            .get_mut("cells")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| ToolError::InvalidInput("notebook has no cells array".into()))?;
        let index = input
            .cell_id
            .as_deref()
            .map(|id| find_cell(cells, id))
            .transpose()?;

        let affected = match input.edit_mode {
            EditMode::Replace => {
                let index = index
                    .ok_or_else(|| ToolError::InvalidInput("replace requires cellId".into()))?;
                let cell = cells[index].as_object_mut().ok_or_else(|| {
                    ToolError::InvalidInput("notebook cell must be an object".into())
                })?;
                cell.insert("source".into(), source_value(&input.new_source));
                if let Some(cell_type) = input.cell_type {
                    cell.insert("cell_type".into(), json!(cell_type.as_str()));
                }
                index
            }
            EditMode::Insert => {
                let insert_at = index.map(|index| index + 1).unwrap_or(cells.len());
                cells.insert(
                    insert_at,
                    new_cell(input.cell_type.unwrap_or(CellType::Code), &input.new_source),
                );
                insert_at
            }
            EditMode::Delete => {
                let index = index
                    .ok_or_else(|| ToolError::InvalidInput("delete requires cellId".into()))?;
                cells.remove(index);
                index
            }
        };
        let cell_count = cells.len();
        let encoded = serde_json::to_vec_pretty(&notebook)
            .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?;
        tokio::fs::write(&path, encoded).await.map_err(|error| {
            ToolError::ExecutionFailed(format!("write {}: {error}", path.display()))
        })?;
        Ok(json!({
            "path": input.path,
            "editMode": input.edit_mode.as_str(),
            "cellIndex": affected,
            "cellCount": cell_count,
        }))
    }
}

fn find_cell(cells: &[Value], id: &str) -> Result<usize, ToolError> {
    if let Some(index) = cells
        .iter()
        .position(|cell| cell.get("id").and_then(Value::as_str) == Some(id))
    {
        return Ok(index);
    }
    if let Ok(index) = id.parse::<usize>() {
        if index < cells.len() {
            return Ok(index);
        }
    }
    Err(ToolError::InvalidInput(format!(
        "notebook cell not found: {id}"
    )))
}

fn source_value(source: &str) -> Value {
    Value::Array(
        source
            .split_inclusive('\n')
            .map(|line| Value::String(line.to_string()))
            .collect(),
    )
}

fn new_cell(cell_type: CellType, source: &str) -> Value {
    let mut cell = Map::new();
    cell.insert("cell_type".into(), json!(cell_type.as_str()));
    cell.insert("metadata".into(), json!({}));
    cell.insert("source".into(), source_value(source));
    if matches!(cell_type, CellType::Code) {
        cell.insert("execution_count".into(), Value::Null);
        cell.insert("outputs".into(), json!([]));
    }
    Value::Object(cell)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn replaces_inserts_and_deletes_cells() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("book.ipynb");
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"cells":[{"id":"first","cell_type":"code","metadata":{},"source":["old\n"],"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5})).unwrap(),
        )
        .unwrap();
        let context = ToolContext::new(dir.path().to_path_buf());
        NotebookEditTool
            .execute(&context, json!({"path":"book.ipynb","cellId":"first","newSource":"new\n","editMode":"replace"}))
            .await
            .unwrap();
        NotebookEditTool
            .execute(&context, json!({"path":"book.ipynb","cellId":"first","newSource":"notes","cellType":"markdown","editMode":"insert"}))
            .await
            .unwrap();
        let notebook: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(notebook["cells"][0]["source"][0], "new\n");
        assert_eq!(notebook["cells"][1]["cell_type"], "markdown");
    }

    #[test]
    fn empty_source_is_a_valid_empty_line_array() {
        assert_eq!(source_value(""), json!([]));
    }
}
