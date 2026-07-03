//! Document reading: one entry point dispatching on file extension.

use std::io::Read;
use std::path::Path;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum ReadError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("unsupported document type: {0}")]
    Unsupported(String),
    #[error("failed to parse {kind}: {message}")]
    Parse { kind: String, message: String },
}

fn parse_err(kind: &str, message: impl std::fmt::Display) -> ReadError {
    ReadError::Parse {
        kind: kind.to_string(),
        message: message.to_string(),
    }
}

/// Structured document content.
#[derive(Debug)]
pub enum DocContent {
    /// pdf / docx / pptx / txt: plain text (pptx joins slides with markers).
    Text { kind: &'static str, text: String },
    /// xlsx / csv: one table per sheet as rows of cell strings.
    Tables {
        kind: &'static str,
        sheets: Vec<(String, Vec<Vec<String>>)>,
    },
}

/// Read a document by extension. `max_cells` caps spreadsheet size to keep
/// tool outputs bounded (rows beyond the cap are dropped and reported by the
/// caller via row counts).
pub fn read_document(path: &Path) -> Result<DocContent, ReadError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "pdf" => read_pdf(path),
        "docx" => read_docx(path),
        "pptx" => read_pptx(path),
        "xlsx" | "xls" | "xlsm" | "ods" => read_spreadsheet(path),
        "csv" => read_csv(path),
        "txt" | "md" | "log" => Ok(DocContent::Text {
            kind: "text",
            text: std::fs::read_to_string(path)?,
        }),
        other => Err(ReadError::Unsupported(other.to_string())),
    }
}

fn read_pdf(path: &Path) -> Result<DocContent, ReadError> {
    let text = pdf_extract::extract_text(path).map_err(|e| parse_err("pdf", e))?;
    Ok(DocContent::Text { kind: "pdf", text })
}

/// Extract text from OOXML parts: collects character data inside the given
/// text element (`w:t` for docx, `a:t` for pptx).
fn ooxml_part_text(xml: &str, text_tag: &str, para_tag: &str) -> String {
    let mut reader = quick_xml::Reader::from_str(xml);
    let mut out = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == text_tag {
                    in_text = true;
                }
            }
            Ok(quick_xml::events::Event::End(e)) => {
                let name = String::from_utf8_lossy(e.name().as_ref()).to_string();
                if name == text_tag {
                    in_text = false;
                } else if name == para_tag {
                    out.push('\n');
                }
            }
            Ok(quick_xml::events::Event::Text(t)) => {
                if in_text {
                    out.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    out
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<std::fs::File>, ReadError> {
    let file = std::fs::File::open(path)?;
    zip::ZipArchive::new(file).map_err(|e| parse_err("ooxml", e))
}

fn zip_entry_string(
    archive: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
) -> Result<String, ReadError> {
    let mut entry = archive
        .by_name(name)
        .map_err(|e| parse_err("ooxml", format!("{name}: {e}")))?;
    let mut xml = String::new();
    entry.read_to_string(&mut xml)?;
    Ok(xml)
}

fn read_docx(path: &Path) -> Result<DocContent, ReadError> {
    let mut archive = open_zip(path)?;
    let xml = zip_entry_string(&mut archive, "word/document.xml")?;
    let text = ooxml_part_text(&xml, "w:t", "w:p");
    Ok(DocContent::Text {
        kind: "docx",
        text: text.trim().to_string(),
    })
}

fn read_pptx(path: &Path) -> Result<DocContent, ReadError> {
    let mut archive = open_zip(path)?;
    // Slide entries: ppt/slides/slide1.xml, slide2.xml, ...
    let mut slide_names: Vec<String> = (0..archive.len())
        .filter_map(|i| {
            let name = archive.by_index(i).ok()?.name().to_string();
            (name.starts_with("ppt/slides/slide") && name.ends_with(".xml")).then_some(name)
        })
        .collect();
    slide_names.sort_by_key(|name| {
        name.trim_start_matches("ppt/slides/slide")
            .trim_end_matches(".xml")
            .parse::<u32>()
            .unwrap_or(u32::MAX)
    });
    let mut text = String::new();
    for (i, name) in slide_names.iter().enumerate() {
        let xml = zip_entry_string(&mut archive, name)?;
        text.push_str(&format!("--- Slide {} ---\n", i + 1));
        text.push_str(ooxml_part_text(&xml, "a:t", "a:p").trim());
        text.push('\n');
    }
    Ok(DocContent::Text {
        kind: "pptx",
        text: text.trim().to_string(),
    })
}

fn read_spreadsheet(path: &Path) -> Result<DocContent, ReadError> {
    use calamine::Reader;
    let mut workbook =
        calamine::open_workbook_auto(path).map_err(|e| parse_err("spreadsheet", e))?;
    let mut sheets = Vec::new();
    let names: Vec<String> = workbook.sheet_names().to_vec();
    for name in names {
        let range = workbook
            .worksheet_range(&name)
            .map_err(|e| parse_err("spreadsheet", e))?;
        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|row| row.iter().map(|cell| cell.to_string()).collect())
            .collect();
        sheets.push((name, rows));
    }
    Ok(DocContent::Tables {
        kind: "xlsx",
        sheets,
    })
}

fn read_csv(path: &Path) -> Result<DocContent, ReadError> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .from_path(path)
        .map_err(|e| parse_err("csv", e))?;
    let mut rows = Vec::new();
    for record in reader.records() {
        let record = record.map_err(|e| parse_err("csv", e))?;
        rows.push(record.iter().map(|s| s.to_string()).collect());
    }
    Ok(DocContent::Tables {
        kind: "csv",
        sheets: vec![("csv".to_string(), rows)],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.csv");
        std::fs::write(&path, "name,score\nalice,90\nbob,85\n").unwrap();
        let DocContent::Tables { kind, sheets } = read_document(&path).unwrap() else {
            panic!("expected tables");
        };
        assert_eq!(kind, "csv");
        assert_eq!(sheets[0].1.len(), 3);
        assert_eq!(sheets[0].1[1], vec!["alice", "90"]);
    }

    #[test]
    fn unsupported_extension() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("movie.mp4");
        std::fs::write(&path, "x").unwrap();
        assert!(matches!(
            read_document(&path),
            Err(ReadError::Unsupported(_))
        ));
    }

    #[test]
    fn plain_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "# Title").unwrap();
        let DocContent::Text { text, .. } = read_document(&path).unwrap() else {
            panic!("expected text");
        };
        assert_eq!(text, "# Title");
    }

    // docx/xlsx read paths are covered by write-then-read roundtrips in
    // write.rs tests, so generated and parsed formats stay in sync.
}
