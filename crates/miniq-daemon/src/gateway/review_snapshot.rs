//! Read checkpointed bytes directly; never execute shell or tools.
use super::common::store_err;
use crate::state::AppState;
use miniq_memory::ReviewSnapshot;
use miniq_protocol::{ErrorCode, RpcError};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

fn fail(s: impl std::fmt::Display) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, s.to_string())
}
fn read(path: &str) -> Result<Option<Vec<u8>>, RpcError> {
    let file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(fail(e)),
    };
    use std::io::Read;
    let mut bytes = vec![];
    file.take((crate::review::INPUT_BUDGET + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(fail)?;
    if bytes.len() > crate::review::INPUT_BUDGET {
        return Err(fail("checkpoint file exceeds review input budget"));
    }
    Ok(Some(bytes))
}
pub(super) fn capture_diff(
    state: &AppState,
    snapshot: &mut ReviewSnapshot,
) -> Result<(), RpcError> {
    let checkpoints = state
        .store
        .turn_checkpoints(&snapshot.session_id, &snapshot.user_message_id)
        .map_err(store_err)?;
    let mut seen = HashSet::new();
    let mut diffs = vec![];
    for first in &checkpoints.within {
        if !seen.insert(&first.abs_path) {
            continue;
        }
        let old = if first.existed {
            read(
                first
                    .backup_path
                    .as_deref()
                    .ok_or_else(|| fail("checkpoint backup unavailable"))?,
            )?
            .ok_or_else(|| fail("checkpoint backup missing"))?
        } else {
            vec![]
        };
        let new = if let Some(later) = checkpoints
            .after
            .iter()
            .find(|c| c.abs_path == first.abs_path)
        {
            if later.existed {
                read(
                    later
                        .backup_path
                        .as_deref()
                        .ok_or_else(|| fail("later checkpoint backup unavailable"))?,
                )?
                .ok_or_else(|| fail("later checkpoint backup missing"))?
            } else {
                vec![]
            }
        } else {
            let current = read(&first.abs_path)?;
            let last = checkpoints
                .within
                .iter()
                .rev()
                .find(|c| c.abs_path == first.abs_path)
                .unwrap();
            let identity = current
                .as_ref()
                .map(|b| format!("sha256:{:x}", Sha256::digest(b)))
                .unwrap_or_else(|| "absent".into());
            if last.after_state.as_deref() != Some(&identity) {
                return Err(fail("workspace changed or checkpoint end state unavailable; cannot capture immutable turn diff"));
            }
            current.unwrap_or_default()
        };
        let path = Path::new(&first.abs_path).to_string_lossy();
        match (std::str::from_utf8(&old),std::str::from_utf8(&new)){
    (Ok(old),Ok(new))=>diffs.push(json!({"path":path,"diff":similar::TextDiff::from_lines(old,new).unified_diff().to_string()})),
    _=>{diffs.push(json!({"path":path,"binary":true}));snapshot.limitations.push(format!("Binary file {path} content is unavailable to text review."));}
   }
    }
    snapshot.diff = json!(diffs);
    Ok(())
}
