use std::io::{Read, Seek, SeekFrom};

use base64::Engine;
use miniq_protocol::{ErrorCode, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};

use super::common::{params, store_err};
use crate::state::AppState;

const CHUNK_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    session_id: String,
    tool_call_id: String,
    #[serde(default)]
    offset: u64,
    #[serde(default)]
    image_index: usize,
}

pub(super) async fn read(state: &AppState, input: Option<Value>) -> Result<Value, RpcError> {
    let input: ReadInput = params(input)?;
    let call = state
        .store
        .get_tool_call(&input.tool_call_id)
        .map_err(store_err)?;
    if call.session_id != input.session_id
        || !matches!(
            call.tool_name.as_str(),
            "computer_use" | "browser_automation" | "view_image" | "view_pdf"
        )
    {
        return Err(RpcError::new(
            ErrorCode::InvalidParams,
            "observation does not belong to this tool call",
        ));
    }
    let screenshot = call.output.as_ref().and_then(|output| {
        if call.tool_name == "view_pdf" {
            output
                .get("pages")?
                .as_array()?
                .get(input.image_index)?
                .get("screenshot")
        } else if input.image_index == 0 {
            output.get("screenshot")
        } else {
            None
        }
    });
    let id = screenshot
        .and_then(|value| value.get("id"))
        .and_then(Value::as_str)
        .ok_or_else(|| RpcError::new(ErrorCode::InvalidParams, "tool call has no screenshot"))?;
    let path = miniq_tools::observation_path(&state.observations_dir, id)
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))?;
    tokio::task::spawn_blocking(move || read_chunk(&path, input.offset))
        .await
        .map_err(|error| RpcError::new(ErrorCode::InternalError, error.to_string()))?
        .map_err(|error| RpcError::new(ErrorCode::InvalidParams, error))
}

fn read_chunk(path: &std::path::Path, offset: u64) -> Result<Value, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || metadata.len() > miniq_tools::MAX_OBSERVATION_BYTES as u64
        || offset > metadata.len()
    {
        return Err("invalid screenshot file or offset".into());
    }
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    file.take(CHUNK_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let next = offset + bytes.len() as u64;
    Ok(
        json!({"offset": offset, "nextOffset": next, "totalBytes": metadata.len(),
        "done": next == metadata.len(), "mimeType": "image/png",
        "base64": base64::engine::general_purpose::STANDARD.encode(bytes) }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_roundtrip_without_loss() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("observation.png");
        let bytes = (0..CHUNK_BYTES * 2 + 7)
            .map(|i| (i % 251) as u8)
            .collect::<Vec<_>>();
        std::fs::write(&path, &bytes).unwrap();
        let mut offset = 0;
        let mut restored = Vec::new();
        loop {
            let chunk = read_chunk(&path, offset).unwrap();
            restored.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(chunk["base64"].as_str().unwrap())
                    .unwrap(),
            );
            offset = chunk["nextOffset"].as_u64().unwrap();
            if chunk["done"] == true {
                break;
            }
        }
        assert_eq!(restored, bytes);
        assert!(read_chunk(&path, offset + 1).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("private");
        std::fs::write(&file, "private").unwrap();
        let link = directory.path().join("screenshot.png");
        std::os::unix::fs::symlink(file, &link).unwrap();
        assert!(read_chunk(&link, 0).is_err());
    }

    #[tokio::test]
    async fn reads_only_a_screenshot_recorded_for_the_requested_session_and_tool() {
        let directory = tempfile::tempdir().unwrap();
        let store = miniq_memory::Store::open_in_memory().unwrap();
        let workspace = store
            .create_workspace(directory.path().to_str().unwrap(), "test")
            .unwrap();
        let session = store.create_session(&workspace.id, "test").unwrap();
        let mut state = AppState::new(
            store,
            "test-token".into(),
            std::sync::Arc::new(miniq_models::mock::MockProvider::new(Vec::new())),
        );
        state.observations_dir = directory.path().into();
        let id = "aa8091e1-3bf0-4b0f-b699-260f2ac9e081";
        std::fs::write(
            miniq_tools::observation_path(directory.path(), id).unwrap(),
            "test",
        )
        .unwrap();
        let call = state
            .store
            .create_tool_call(
                &session.id,
                "computer_use",
                &json!({"action":"screenshot"}),
                miniq_protocol::ToolCallStatus::Running,
            )
            .unwrap();
        state
            .store
            .finish_tool_call(
                &call.id,
                miniq_protocol::ToolCallStatus::Succeeded,
                Some(&json!({"screenshot":{"id":id}})),
            )
            .unwrap();
        let params = json!({"sessionId":session.id,"toolCallId":call.id});
        let result = read(&state, Some(params.clone())).await.unwrap();
        assert_eq!(result["base64"], "dGVzdA==");
        let mut wrong_session = params.clone();
        wrong_session["sessionId"] = json!("other");
        assert!(read(&state, Some(wrong_session)).await.is_err());
        let other = state
            .store
            .create_tool_call(
                &session.id,
                "shell_run",
                &json!({}),
                miniq_protocol::ToolCallStatus::Running,
            )
            .unwrap();
        state
            .store
            .finish_tool_call(
                &other.id,
                miniq_protocol::ToolCallStatus::Succeeded,
                Some(&json!({"screenshot":{"id":id}})),
            )
            .unwrap();
        let mut wrong_tool = params;
        wrong_tool["toolCallId"] = json!(other.id);
        assert!(read(&state, Some(wrong_tool)).await.is_err());
        let pdf = state
            .store
            .create_tool_call(
                &session.id,
                "view_pdf",
                &json!({"path":"fixture.pdf"}),
                miniq_protocol::ToolCallStatus::Running,
            )
            .unwrap();
        state.store.finish_tool_call(&pdf.id, miniq_protocol::ToolCallStatus::Succeeded,
            Some(&json!({"pages":[{"page":2,"screenshot":{"id":id}},{"page":5,"screenshot":{"id":id}}]}))).unwrap();
        let selected = json!({"sessionId":session.id,"toolCallId":pdf.id,"imageIndex":1});
        assert_eq!(
            read(&state, Some(selected)).await.unwrap()["base64"],
            "dGVzdA=="
        );
        assert!(read(
            &state,
            Some(json!({"sessionId":session.id,"toolCallId":pdf.id,"imageIndex":2}))
        )
        .await
        .is_err());
    }
}
