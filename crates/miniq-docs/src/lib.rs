//! miniq-docs: office document reading and generation.
//!
//! Read:  pdf / docx / xlsx / pptx / csv / plain text -> structured text.
//! Write: docx / xlsx / md / csv / txt.
//!
//! This crate only converts between files and structured data; it never
//! decides paths (sandboxing) and never talks to the model.

mod read;
mod write;

pub use read::{read_document, read_pdf_pages, DocContent, ReadError};
pub use write::{write_document, DocOutput, SheetData, WriteError};
