//! Document generation: docx / xlsx / md / csv / txt.

use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum WriteError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported output type: {0}")]
    Unsupported(String),
    #[error("failed to build {kind}: {message}")]
    Build { kind: String, message: String },
    #[error("invalid input: {0}")]
    Invalid(String),
}

fn build_err(kind: &str, message: impl std::fmt::Display) -> WriteError {
    WriteError::Build {
        kind: kind.to_string(),
        message: message.to_string(),
    }
}

/// One sheet of tabular output.
#[derive(Debug, Clone)]
pub struct SheetData {
    pub name: String,
    pub rows: Vec<Vec<String>>,
}

/// What to write.
#[derive(Debug)]
pub enum DocOutput {
    /// Markdown-ish text: for docx each line becomes a paragraph, `#`
    /// prefixes become headings. For md/txt it is written verbatim.
    Text(String),
    /// Tabular data: xlsx (multi-sheet) or csv (first sheet only).
    Tables(Vec<SheetData>),
}

/// Write a document; the format is chosen by the path extension.
pub fn write_document(path: &Path, output: &DocOutput) -> Result<(), WriteError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match (ext.as_str(), output) {
        ("md" | "txt", DocOutput::Text(text)) => {
            std::fs::write(path, text)?;
            Ok(())
        }
        ("docx", DocOutput::Text(text)) => write_docx(path, text),
        ("xlsx", DocOutput::Tables(sheets)) => write_xlsx(path, sheets),
        ("csv", DocOutput::Tables(sheets)) => write_csv(path, sheets),
        ("md" | "txt" | "docx", DocOutput::Tables(_)) => Err(WriteError::Invalid(
            "tabular content requires an .xlsx or .csv path".into(),
        )),
        ("xlsx" | "csv", DocOutput::Text(_)) => Err(WriteError::Invalid(
            "text content requires a .docx, .md or .txt path".into(),
        )),
        (other, _) => Err(WriteError::Unsupported(other.to_string())),
    }
}

/// Markdown-lite -> docx: `#`-prefixed lines become headings (size by
/// level), everything else becomes body paragraphs. Empty lines separate
/// paragraphs.
fn write_docx(path: &Path, text: &str) -> Result<(), WriteError> {
    use docx_rs::{AlignmentType, Docx, Paragraph, Run};

    let mut docx = Docx::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        let (content, size) = if let Some(rest) = trimmed.strip_prefix("### ") {
            (rest, 26)
        } else if let Some(rest) = trimmed.strip_prefix("## ") {
            (rest, 30)
        } else if let Some(rest) = trimmed.strip_prefix("# ") {
            (rest, 36)
        } else {
            (trimmed, 22)
        };
        let mut run = Run::new().add_text(content).size(size);
        if size > 22 {
            run = run.bold();
        }
        docx = docx.add_paragraph(Paragraph::new().add_run(run).align(AlignmentType::Left));
    }
    let file = std::fs::File::create(path)?;
    docx.build().pack(file).map_err(|e| build_err("docx", e))?;
    Ok(())
}

fn write_xlsx(path: &Path, sheets: &[SheetData]) -> Result<(), WriteError> {
    if sheets.is_empty() {
        return Err(WriteError::Invalid("at least one sheet is required".into()));
    }
    let mut workbook = rust_xlsxwriter::Workbook::new();
    for sheet in sheets {
        let worksheet = workbook
            .add_worksheet()
            .set_name(&sheet.name)
            .map_err(|e| build_err("xlsx", e))?;
        for (r, row) in sheet.rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                // Numbers are written as numbers so Excel formulas work.
                if let Ok(n) = cell.parse::<f64>() {
                    worksheet
                        .write_number(r as u32, c as u16, n)
                        .map_err(|e| build_err("xlsx", e))?;
                } else {
                    worksheet
                        .write_string(r as u32, c as u16, cell)
                        .map_err(|e| build_err("xlsx", e))?;
                }
            }
        }
    }
    workbook.save(path).map_err(|e| build_err("xlsx", e))?;
    Ok(())
}

fn write_csv(path: &Path, sheets: &[SheetData]) -> Result<(), WriteError> {
    let sheet = sheets
        .first()
        .ok_or_else(|| WriteError::Invalid("at least one sheet is required".into()))?;
    let mut writer = csv::Writer::from_path(path).map_err(|e| build_err("csv", e))?;
    for row in &sheet.rows {
        writer.write_record(row).map_err(|e| build_err("csv", e))?;
    }
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::{read_document, DocContent};

    #[test]
    fn docx_write_then_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.docx");
        write_document(
            &path,
            &DocOutput::Text(
                "# Weekly Report\n\nAll systems normal.\n## Details\nNothing broke.".into(),
            ),
        )
        .unwrap();
        let DocContent::Text { kind, text } = read_document(&path).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(kind, "docx");
        assert!(text.contains("Weekly Report"));
        assert!(text.contains("All systems normal."));
        assert!(text.contains("Nothing broke."));
    }

    #[test]
    fn xlsx_write_then_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.xlsx");
        write_document(
            &path,
            &DocOutput::Tables(vec![SheetData {
                name: "Scores".into(),
                rows: vec![
                    vec!["name".into(), "score".into()],
                    vec!["alice".into(), "90".into()],
                ],
            }]),
        )
        .unwrap();
        let DocContent::Tables { sheets, .. } = read_document(&path).unwrap() else {
            panic!("expected tables");
        };
        assert_eq!(sheets[0].0, "Scores");
        assert_eq!(sheets[0].1[0], vec!["name", "score"]);
        assert_eq!(sheets[0].1[1][1], "90");
    }

    #[test]
    fn csv_write_then_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.csv");
        write_document(
            &path,
            &DocOutput::Tables(vec![SheetData {
                name: "csv".into(),
                rows: vec![vec!["a".into(), "b".into()], vec!["1".into(), "2".into()]],
            }]),
        )
        .unwrap();
        let DocContent::Tables { sheets, .. } = read_document(&path).unwrap() else {
            panic!("expected tables");
        };
        assert_eq!(sheets[0].1.len(), 2);
    }

    #[test]
    fn mismatched_content_type_rejected() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            write_document(&dir.path().join("x.xlsx"), &DocOutput::Text("t".into())),
            Err(WriteError::Invalid(_))
        ));
        assert!(matches!(
            write_document(&dir.path().join("x.docx"), &DocOutput::Tables(vec![])),
            Err(WriteError::Invalid(_))
        ));
        assert!(matches!(
            write_document(&dir.path().join("x.pptx"), &DocOutput::Text("t".into())),
            Err(WriteError::Unsupported(_))
        ));
    }
}
