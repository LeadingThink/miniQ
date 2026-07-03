//! doc_read / doc_write: office document tools backed by miniq-docs.

use async_trait::async_trait;
use miniq_docs::{read_document, write_document, DocContent, DocOutput, SheetData};
use miniq_protocol::RiskLevel;
use miniq_sandbox::{resolve_in_workspace, Risk};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::file::path_risk;
use crate::router::{parse_input, Tool, ToolContext, ToolError};

const DEFAULT_MAX_ROWS: usize = 200;

// ---- doc_read ----

pub struct DocReadTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocReadInput {
    path: String,
    /// Tables only: 0-based first row (default 0).
    #[serde(default)]
    offset: Option<usize>,
    /// Tables only: max rows per sheet (default 200).
    #[serde(default)]
    max_rows: Option<usize>,
}

#[async_trait]
impl Tool for DocReadTool {
    fn name(&self) -> &str {
        "doc_read"
    }
    fn description(&self) -> &str {
        "Read an office document (pdf, docx, pptx, xlsx, csv, txt/md) as structured \
         text or tables. Spreadsheets support row paging via offset/maxRows."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Document path relative to the workspace root"},
                "offset": {"type": "integer", "description": "Spreadsheets: 0-based first row"},
                "maxRows": {"type": "integer", "description": "Spreadsheets: max rows per sheet (default 200)"}
            },
            "required": ["path"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(ctx, input, RiskLevel::Low, "read-only document access")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: DocReadInput = parse_input(input)?;
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let content = tokio::task::spawn_blocking(move || read_document(&path))
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;

        match content {
            DocContent::Text { kind, text } => Ok(json!({
                "path": p.path,
                "kind": kind,
                "text": text,
            })),
            DocContent::Tables { kind, sheets } => {
                let offset = p.offset.unwrap_or(0);
                let max_rows = p.max_rows.unwrap_or(DEFAULT_MAX_ROWS).max(1);
                let sheets_json: Vec<Value> = sheets
                    .into_iter()
                    .map(|(name, rows)| {
                        let total = rows.len();
                        let page: Vec<Vec<String>> =
                            rows.into_iter().skip(offset).take(max_rows).collect();
                        json!({
                            "name": name,
                            "rows": page,
                            "totalRows": total,
                            "offset": offset,
                            "truncated": total > offset + max_rows,
                        })
                    })
                    .collect();
                Ok(json!({
                    "path": p.path,
                    "kind": kind,
                    "sheets": sheets_json,
                }))
            }
        }
    }
}

// ---- doc_write ----

pub struct DocWriteTool;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SheetInput {
    name: String,
    rows: Vec<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocWriteInput {
    path: String,
    /// For .docx/.md/.txt: markdown-ish text (`#` headings for docx).
    #[serde(default)]
    content: Option<String>,
    /// For .xlsx/.csv: tabular data.
    #[serde(default)]
    sheets: Option<Vec<SheetInput>>,
    /// Human-readable deliverable title shown in the results area.
    #[serde(default)]
    title: Option<String>,
}

#[async_trait]
impl Tool for DocWriteTool {
    fn name(&self) -> &str {
        "doc_write"
    }
    fn description(&self) -> &str {
        "Generate an office document deliverable: .docx/.md/.txt from `content` \
         (markdown headings supported), or .xlsx/.csv from `sheets`. Requires approval."
    }
    fn parameters_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Output path relative to the workspace root; extension picks the format"},
                "content": {"type": "string", "description": "Text content for .docx/.md/.txt"},
                "sheets": {
                    "type": "array",
                    "description": "Tabular content for .xlsx/.csv",
                    "items": {
                        "type": "object",
                        "properties": {
                            "name": {"type": "string"},
                            "rows": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}}
                        },
                        "required": ["name", "rows"]
                    }
                },
                "title": {"type": "string", "description": "Deliverable title shown to the user"}
            },
            "required": ["path"]
        })
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(ctx, input, RiskLevel::Medium, "writes a document in the workspace")
    }
    async fn execute(&self, ctx: &ToolContext, input: Value) -> Result<Value, ToolError> {
        let p: DocWriteInput = parse_input(input)?;
        let path = resolve_in_workspace(&ctx.workspace, &p.path)
            .map_err(|e| ToolError::SandboxDenied(e.to_string()))?;
        let output = match (p.content, p.sheets) {
            (Some(content), None) => DocOutput::Text(content),
            (None, Some(sheets)) => DocOutput::Tables(
                sheets
                    .into_iter()
                    .map(|s| SheetData {
                        name: s.name,
                        rows: s.rows,
                    })
                    .collect(),
            ),
            (Some(_), Some(_)) => {
                return Err(ToolError::InvalidInput(
                    "provide either content or sheets, not both".into(),
                ))
            }
            (None, None) => {
                return Err(ToolError::InvalidInput(
                    "provide content (text formats) or sheets (table formats)".into(),
                ))
            }
        };
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        }
        let kind = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let write_path = path.clone();
        tokio::task::spawn_blocking(move || write_document(&write_path, &output))
            .await
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?
            .map_err(|e| ToolError::ExecutionFailed(e.to_string()))?;
        let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Ok(json!({
            "path": p.path,
            "kind": kind,
            "bytes": bytes,
            "title": p.title.unwrap_or_else(|| p.path.clone()),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(dir: &std::path::Path) -> ToolContext {
        ToolContext::new(dir.to_path_buf())
    }

    #[tokio::test]
    async fn write_docx_then_read_back() {
        let dir = tempfile::tempdir().unwrap();
        let out = DocWriteTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "report.docx", "content": "# Report\nAll good.", "title": "周报"}),
            )
            .await
            .unwrap();
        assert_eq!(out["kind"], "docx");
        assert_eq!(out["title"], "周报");

        let read = DocReadTool
            .execute(&ctx(dir.path()), json!({"path": "report.docx"}))
            .await
            .unwrap();
        assert!(read["text"].as_str().unwrap().contains("All good."));
    }

    #[tokio::test]
    async fn xlsx_paging() {
        let dir = tempfile::tempdir().unwrap();
        let rows: Vec<Vec<String>> = (0..30)
            .map(|i| vec![format!("row{i}"), i.to_string()])
            .collect();
        DocWriteTool
            .execute(
                &ctx(dir.path()),
                serde_json::to_value(json!({"path": "data.xlsx", "sheets": [{"name": "S", "rows": rows}]})).unwrap(),
            )
            .await
            .unwrap();

        let read = DocReadTool
            .execute(
                &ctx(dir.path()),
                json!({"path": "data.xlsx", "offset": 10, "maxRows": 5}),
            )
            .await
            .unwrap();
        let sheet = &read["sheets"][0];
        assert_eq!(sheet["rows"].as_array().unwrap().len(), 5);
        assert_eq!(sheet["rows"][0][0], "row10");
        assert_eq!(sheet["totalRows"], 30);
        assert_eq!(sheet["truncated"], true);
    }

    #[tokio::test]
    async fn input_validation_and_sandbox() {
        let dir = tempfile::tempdir().unwrap();
        let err = DocWriteTool
            .execute(&ctx(dir.path()), json!({"path": "x.docx"}))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::InvalidInput(_)));

        let err = DocReadTool
            .execute(&ctx(dir.path()), json!({"path": "../secret.xlsx"}))
            .await
            .unwrap_err();
        assert!(matches!(err, ToolError::SandboxDenied(_)));
    }
}
