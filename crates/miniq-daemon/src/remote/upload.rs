use super::{transport::CHUNK_BYTES, URL_SAFE_NO_PAD};
use base64::Engine;
use serde::Deserialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
const MAX_BUFFERED_BYTES: usize = 64 * 1024 * 1024;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    transfer_id: String,
    request_id: Value,
    index: usize,
    total_bytes: usize,
    data: String,
}
struct Transfer {
    request_id: Value,
    total: usize,
    next: usize,
    bytes: Vec<u8>,
    updated: Instant,
}

#[derive(Default)]
pub(super) struct Uploads {
    transfers: HashMap<(String, String), Transfer>,
}

impl Uploads {
    pub fn expire(&mut self) {
        self.transfers
            .retain(|_, transfer| transfer.updated.elapsed() < TRANSFER_TIMEOUT);
    }
    pub fn cancel(&mut self, source: &str, id: &str) {
        self.transfers
            .retain(|(owner, _), transfer| owner != source || transfer.request_id != id);
    }
    pub fn retain_sources(&mut self, ids: &[String]) {
        self.transfers.retain(|(source, _), _| ids.contains(source));
    }

    pub fn read(&mut self, source: &str, value: Value) -> anyhow::Result<Option<Value>> {
        if value["type"] != "remote_chunk" {
            return Ok(Some(value));
        }
        let chunk: Chunk = serde_json::from_value(value)?;
        let key = (source.to_string(), chunk.transfer_id.clone());
        let result = self.append(&key, chunk);
        if result.is_err() {
            self.transfers.remove(&key);
        }
        result
    }

    fn append(&mut self, key: &(String, String), chunk: Chunk) -> anyhow::Result<Option<Value>> {
        anyhow::ensure!(
            !chunk.transfer_id.is_empty() && chunk.transfer_id.len() <= 128,
            "invalid transfer ID"
        );
        anyhow::ensure!(
            chunk.request_id.is_string() || chunk.request_id.is_number(),
            "invalid request ID"
        );
        anyhow::ensure!(
            chunk.total_bytes > 0 && chunk.total_bytes <= MAX_REQUEST_BYTES,
            "request exceeds upload limit"
        );
        anyhow::ensure!(
            chunk.data.len() <= CHUNK_BYTES.div_ceil(3) * 4,
            "upload chunk too large"
        );
        let bytes = URL_SAFE_NO_PAD.decode(&chunk.data)?;
        anyhow::ensure!(
            !bytes.is_empty() && bytes.len() <= CHUNK_BYTES,
            "invalid upload chunk size"
        );
        let buffered: usize = self
            .transfers
            .values()
            .map(|transfer| transfer.bytes.len())
            .sum();
        anyhow::ensure!(
            buffered + bytes.len() <= MAX_BUFFERED_BYTES,
            "too many upload bytes buffered"
        );
        if !self.transfers.contains_key(key) {
            anyhow::ensure!(
                chunk.index == 0 && self.transfers.len() < 8,
                "missing first chunk or too many uploads"
            );
            self.transfers.insert(
                key.clone(),
                Transfer {
                    request_id: chunk.request_id.clone(),
                    total: chunk.total_bytes,
                    next: 0,
                    bytes: Vec::new(),
                    updated: Instant::now(),
                },
            );
        }
        let transfer = self.transfers.get_mut(key).unwrap();
        anyhow::ensure!(
            transfer.next == chunk.index
                && transfer.total == chunk.total_bytes
                && transfer.request_id == chunk.request_id,
            "inconsistent upload chunks"
        );
        anyhow::ensure!(
            transfer.bytes.len() + bytes.len() <= transfer.total,
            "upload exceeds declared size"
        );
        transfer.bytes.extend(bytes);
        transfer.next += 1;
        transfer.updated = Instant::now();
        if transfer.bytes.len() < transfer.total {
            return Ok(None);
        }
        let transfer = self.transfers.remove(key).unwrap();
        let request: Value = serde_json::from_slice(&transfer.bytes)?;
        anyhow::ensure!(
            request["id"] == transfer.request_id && request["type"] != "remote_chunk",
            "upload request ID mismatch"
        );
        Ok(Some(request))
    }
}

#[cfg(test)]
#[path = "upload/tests.rs"]
mod tests;
