//! Missing historical pixels are explicit evidence gaps, never invented visuals.

use miniq_models::ChatImage;
use serde_json::{json, Value};

pub(crate) const MISSING_NOTE: &str = "The original local image file is missing. Its pixels are not included and have not been inspected in this request. Do not infer visual details from its path, source text, OCR or metadata. Continue work that does not require these pixels; if visual inspection is necessary, ask for the file to be restored or attached again. Original image references and source metadata remain in the conversation archive; restoring the file makes it readable again.";

pub(crate) fn missing_evidence(image: &ChatImage, reference: Option<&str>) -> Option<Value> {
    // exists()/is_file() would also hide permission errors and unsupported files.
    // Only a genuinely absent path can be omitted from an outgoing request.
    match std::fs::symlink_metadata(&image.path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(json!({
            "status": "missing_visual_evidence",
            "image_reference": reference,
            "image": image,
            "note": MISSING_NOTE,
        })),
        _ => None,
    }
}

#[cfg(test)]
pub(crate) mod tests;
