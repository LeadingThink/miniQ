//! Disk-backed, replayable output pages. Cursors are byte offsets, separately
//! tracked for stdout/stderr. Text is the default projection; lossless base64
//! pages are available only when explicitly requested.
use crate::ToolError;
use base64::Engine;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::sync::{Arc, Mutex};

pub(super) type Output = Arc<Mutex<Spool>>;
pub(super) struct Spool {
    file: tempfile::NamedTempFile,
    pub len: u64,
    pub closed: bool,
    pub error: Option<String>,
}
impl Spool {
    pub fn new() -> Result<Output, ToolError> {
        Ok(Arc::new(Mutex::new(Self {
            file: tempfile::NamedTempFile::new().map_err(io_error)?,
            len: 0,
            closed: false,
            error: None,
        })))
    }
    pub fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.file.as_file_mut().seek(SeekFrom::End(0))?;
        self.file.write_all(bytes)?;
        self.len += bytes.len() as u64;
        Ok(())
    }
    pub fn page(&mut self, offset: u64, limit: usize, raw: bool) -> Result<Value, ToolError> {
        if offset > self.len {
            return Err(ToolError::InvalidInput(
                "output offset exceeds available bytes".into(),
            ));
        }
        self.file
            .as_file_mut()
            .seek(SeekFrom::Start(offset))
            .map_err(io_error)?;
        let mut bytes = vec![0; limit.min((self.len - offset) as usize)];
        self.file.read_exact(&mut bytes).map_err(io_error)?;
        // Keep a trailing partial UTF-8 codepoint for the next page, except at
        // permanent EOF. Invalid bytes inside the page remain in base64.
        if !raw {
            if let Err(error) = std::str::from_utf8(&bytes) {
                if error.error_len().is_none()
                    && (!self.closed || offset + (bytes.len() as u64) < self.len)
                {
                    bytes.truncate(error.valid_up_to());
                }
            }
        }
        let next = offset + bytes.len() as u64;
        let mut page = json!({
            "offset":offset,"nextOffset":next,"totalBytes":self.len,"hasMore":next < self.len,
            "closed":self.closed,"error":self.error});
        if raw {
            page["base64"] = base64::engine::general_purpose::STANDARD
                .encode(&bytes)
                .into();
        } else {
            page["text"] = String::from_utf8_lossy(&bytes).into_owned().into();
            if std::str::from_utf8(&bytes).is_err() {
                page["binaryNotice"] = "Display text contains replacement characters. Replay this offset with raw=true for original bytes.".into();
            }
        }
        Ok(page)
    }
}
fn io_error(error: std::io::Error) -> ToolError {
    ToolError::ExecutionFailed(format!("process output storage: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_preserve_unicode_and_binary_and_allow_replay() {
        let spool = Spool::new().unwrap();
        let mut s = spool.lock().unwrap();
        let original = "ab中文XYZ".as_bytes();
        s.append(original).unwrap();
        s.closed = true;
        let mut offset = 0;
        let mut reconstructed = Vec::new();
        while offset < s.len {
            let page = s.page(offset, 4, true).unwrap();
            reconstructed.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(page["base64"].as_str().unwrap())
                    .unwrap(),
            );
            offset = page["nextOffset"].as_u64().unwrap();
        }
        assert_eq!(reconstructed, original);
        assert_eq!(s.page(0, 4, false).unwrap()["text"], "ab");
        s.append(&[255, 0, 254]).unwrap();
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(
                    s.page(original.len() as u64, 4, true).unwrap()["base64"]
                        .as_str()
                        .unwrap()
                )
                .unwrap(),
            vec![255, 0, 254]
        );
        let invalid = s.len + 1;
        assert!(s.page(invalid, 4, false).is_err());
    }
}
