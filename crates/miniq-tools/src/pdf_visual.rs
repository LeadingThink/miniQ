//! Bounded PDF rasterization. Every returned page carries visual evidence and a page number.

use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use miniq_models::ChatImage;
use miniq_protocol::RiskLevel;
use miniq_sandbox::Risk;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::file::path_risk;
use crate::observation;
use crate::router::{parse_input, Tool, ToolContext, ToolError};
use crate::visual::failed;

const MAX_PAGES: usize = 10;
#[cfg(test)]
#[path = "pdf_visual_tests.rs"]
mod integration;
pub struct ViewPdfTool;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PdfInput {
    path: String,
    #[serde(default)]
    pages: Option<String>,
    #[serde(default = "first_page")]
    offset: usize,
    #[serde(default = "default_limit")]
    limit: usize,
}
fn first_page() -> usize {
    1
}
fn default_limit() -> usize {
    3
}

#[async_trait]
impl Tool for ViewPdfTool {
    fn name(&self) -> &str {
        "view_pdf"
    }
    fn description(&self) -> &str {
        "Inspect actual PDF page images with the current model's vision, including scans, charts and layout. Requires Poppler pdfinfo/pdftoppm on PATH. Defaults to 3 pages; follow nextPage to inspect the rest. Use doc_read separately for searchable text, never as proof that images/layout were inspected."
    }
    fn parameters_schema(&self) -> Value {
        json!({"type":"object", "additionalProperties":false, "properties":{
            "path":{"type":"string"},
            "pages":{"type":"string", "description":"Explicit 1-based pages/ranges, e.g. 1-3,5; at most 10 pages. Cannot combine with offset/limit."},
            "offset":{"type":"integer","minimum":1,"default":1},
            "limit":{"type":"integer","minimum":1,"maximum":MAX_PAGES,"default":3}
        },"required":["path"]})
    }
    fn evaluate_risk(&self, ctx: &ToolContext, input: &Value) -> Risk {
        path_risk(
            ctx,
            input,
            RiskLevel::Low,
            "read-only PDF visual inspection",
        )
    }
    async fn execute(&self, ctx: &ToolContext, raw: Value) -> Result<Value, ToolError> {
        if raw.get("pages").is_some() && (raw.get("offset").is_some() || raw.get("limit").is_some())
        {
            return Err(ToolError::InvalidInput(
                "pages cannot be combined with offset/limit".into(),
            ));
        }
        let input: PdfInput = parse_input(raw)?;
        if input.offset == 0 || !(1..=MAX_PAGES).contains(&input.limit) {
            return Err(ToolError::InvalidInput(
                "offset must be positive; limit must be 1-10".into(),
            ));
        }
        let path = ctx
            .resolve_read_path(&input.path)
            .map_err(|error| ToolError::SandboxDenied(error.to_string()))?;
        if !path.is_file() {
            return Err(ToolError::InvalidInput(
                "PDF path must be a regular file".into(),
            ));
        }
        let info = run(ctx, Command::new("pdfinfo").arg(&path)).await?;
        let total = total_pages(&String::from_utf8_lossy(&info))?;
        let pages = selected_pages(&input, total)?;
        let temp = tempfile::tempdir().map_err(failed)?;
        let mut output = Vec::new();
        for page in &pages {
            output.push(render(ctx, &path, temp.path(), *page).await?);
        }
        let last = *pages.last().expect("nonempty page selection");
        Ok(
            json!({"path": input.path, "kind":"pdf_visual", "pages":output,
            "totalPages":total, "nextPage": (input.pages.is_none() && last < total).then_some(last + 1),
            "selectionComplete": input.pages.is_none() && input.offset == 1 && last == total}),
        )
    }
    fn output_images(&self, ctx: &ToolContext, output: &Value) -> Vec<ChatImage> {
        output["pages"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|page| observation::images(ctx, page))
            .collect()
    }
}

fn total_pages(info: &str) -> Result<usize, ToolError> {
    info.lines()
        .find_map(|line| line.strip_prefix("Pages:")?.trim().parse().ok())
        .filter(|pages| *pages > 0)
        .ok_or_else(|| failed("pdfinfo did not return a positive page count"))
}

fn selected_pages(input: &PdfInput, total: usize) -> Result<Vec<usize>, ToolError> {
    if let Some(selection) = &input.pages {
        let pages = crate::doc::parse_page_selection(selection, MAX_PAGES)?;
        if pages.iter().any(|page| *page > total) {
            return Err(ToolError::InvalidInput(format!(
                "PDF pages must be within 1-{total}"
            )));
        }
        return Ok(pages);
    }
    if input.offset > total {
        return Err(ToolError::InvalidInput(format!(
            "offset exceeds {total} PDF pages"
        )));
    }
    Ok((input.offset..=input.offset.saturating_add(input.limit - 1).min(total)).collect())
}

async fn render(
    ctx: &ToolContext,
    path: &Path,
    temp: &Path,
    page: usize,
) -> Result<Value, ToolError> {
    let prefix = temp.join(format!("page-{page}"));
    run(
        ctx,
        Command::new("pdftoppm")
            .args([
                "-png",
                "-singlefile",
                "-r",
                "120",
                "-scale-to",
                "4096",
                "-f",
            ])
            .arg(page.to_string())
            .arg("-l")
            .arg(page.to_string())
            .arg(path)
            .arg(&prefix),
    )
    .await?;
    let png = tokio::fs::read(prefix.with_extension("png"))
        .await
        .map_err(failed)?;
    let screenshot = observation::save(ctx, &png).map_err(failed)?;
    Ok(json!({"page":page,"screenshot":screenshot,"dpi":120,"maxDimension":4096}))
}

async fn run(ctx: &ToolContext, command: &mut Command) -> Result<Vec<u8>, ToolError> {
    command.env("LC_ALL", "C").kill_on_drop(true);
    let result = tokio::select! {
        _ = ctx.cancellation.cancelled() => return Err(failed("PDF inspection cancelled")),
        result = tokio::time::timeout(Duration::from_secs(60), command.output()) => result,
    }.map_err(|_| failed("PDF renderer timed out after 60s"))?
        .map_err(|error| failed(format!("Poppler could not run: {error}. Install pdfinfo and pdftoppm (macOS: brew install poppler; Debian/Ubuntu: apt install poppler-utils; Windows: install Poppler and add its bin directory to PATH).")))?;
    if !result.status.success() {
        return Err(failed(format!(
            "PDF rendering failed: {}",
            String::from_utf8_lossy(&result.stderr)
        )));
    }
    Ok(result.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pagination_has_no_silent_page_loss() {
        let input = PdfInput {
            path: "x".into(),
            pages: None,
            offset: 4,
            limit: 3,
        };
        assert_eq!(selected_pages(&input, 5).unwrap(), vec![4, 5]);
        assert!(selected_pages(&input, 2).is_err());
        assert_eq!(total_pages("Title: test\nPages: 12\n").unwrap(), 12);
        assert!(total_pages("Pages: 0").is_err());
    }
    #[tokio::test]
    async fn rejects_ambiguous_or_unbounded_requests() {
        let ctx = ToolContext::new(std::env::temp_dir());
        for input in [
            json!({"path":"x", "pages":"1", "limit":1}),
            json!({"path":"x", "limit":11}),
            json!({"path":"x", "offset":0}),
        ] {
            assert!(matches!(
                ViewPdfTool.execute(&ctx, input).await,
                Err(ToolError::InvalidInput(_))
            ));
        }
        assert!(crate::doc::parse_page_selection("1-18446744073709551615", MAX_PAGES).is_err());
    }
}
