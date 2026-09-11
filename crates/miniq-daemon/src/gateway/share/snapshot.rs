use super::*;
use std::{
    fs::File,
    io::{Seek, SeekFrom},
};

pub(super) struct SharedFile {
    pub id: String,
    pub size: u64,
    pub handle: File,
}
pub(super) struct Snapshot {
    pub payload: Value,
    pub files: Vec<SharedFile>,
}

impl Snapshot {
    pub(super) fn build(
        state: &AppState,
        input: &CreateInput,
        scope: String,
    ) -> Result<Self, RpcError> {
        let session = state
            .store
            .get_session(&input.session_id)
            .map_err(store_err)?;
        let workspace = state
            .store
            .get_workspace(&session.workspace_id)
            .map_err(store_err)?;
        let selected: HashSet<_> = input.message_ids.iter().collect();
        if selected.is_empty() || selected.len() != input.message_ids.len() {
            return Err(invalid("请选择要分享的消息，且不要重复选择"));
        }
        let mut messages = selected_messages(state, &session.id, &selected)?;
        if messages.len() != selected.len() {
            return Err(invalid("选中的消息已变化或不属于此会话，请重新选择"));
        }
        let artifacts = state.store.list_artifacts(&session.id).map_err(store_err)?;
        let selected: HashSet<_> = input.artifact_ids.iter().collect();
        if selected.len() != input.artifact_ids.len() || selected.len() > 30 {
            return Err(invalid("每次最多分享 30 个文件"));
        }
        let roots: Vec<_> = std::iter::once(workspace.path)
            .chain(workspace.additional_paths)
            .collect();
        let mut files = Vec::new();
        let mut metadata = Vec::new();
        let mut total = 0;
        for artifact in &artifacts {
            if !selected.contains(&artifact.id) {
                continue;
            }
            let path = miniq_local::files::validated_file(
                &artifact.path,
                &session.working_directory,
                &roots,
            )
            .map_err(invalid)?;
            let mut handle = File::open(&path).map_err(invalid)?;
            let size = handle.metadata().map_err(invalid)?.len();
            total += size;
            if size > 256 * 1024 * 1024 || total > 512 * 1024 * 1024 {
                return Err(invalid(
                    "分享文件单个上限 256 MB，总计上限 512 MB，请减少文件后重试",
                ));
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("文件名不是有效文本"))?;
            let id = format!(
                "{:032x}",
                u128::from_be_bytes(
                    Sha256::digest(artifact.id.as_bytes())[..16]
                        .try_into()
                        .unwrap()
                )
            );
            let mut digest = Sha256::new();
            let mut buffer = [0; 65536];
            let mut read_bytes = 0;
            loop {
                let read = handle.read(&mut buffer).map_err(invalid)?;
                if read == 0 {
                    break;
                }
                read_bytes += read as u64;
                if read_bytes > size {
                    return Err(invalid("文件在分享期间变化，请重试"));
                }
                digest.update(&buffer[..read]);
            }
            if read_bytes != size {
                return Err(invalid("文件在分享期间变化，请重试"));
            }
            handle.seek(SeekFrom::Start(0)).map_err(invalid)?;
            metadata.push(
                json!({"id":id,"name":name,"size":size,"sha256":format!("{:x}",digest.finalize())}),
            );
            // Replace known file references with snapshot-relative identifiers, never local authority.
            for message in &mut messages {
                let content = message["content"]
                    .as_str()
                    .unwrap_or_default()
                    .replace(&artifact.path, &format!("miniq-file:{id}"));
                message["content"] = json!(content);
            }
            files.push(SharedFile { id, size, handle });
        }
        if files.len() != selected.len() {
            return Err(invalid("文件不属于此会话或已不可用"));
        }
        let payload = json!({"scope":scope,"title":input.title.trim(),"expiresInDays":input.expires_in_days,"messages":messages,"files":metadata});
        if serde_json::to_vec(&payload).map_err(invalid)?.len() > 16 * 1024 * 1024 {
            return Err(invalid("分享正文超过 16 MB，请选择部分消息；不会截断内容"));
        }
        Ok(Self { payload, files })
    }
}

fn selected_messages(
    state: &AppState,
    session_id: &str,
    selected: &HashSet<&String>,
) -> Result<Vec<Value>, RpcError> {
    let mut before = None;
    let mut messages = Vec::new();
    loop {
        let page = state
            .store
            .history_page(&miniq_protocol::HistoryParams {
                session_id: session_id.into(),
                agent_id: None,
                before,
                limit: 100,
                filter: miniq_protocol::HistoryFilter::Answers,
                query: String::new(),
                include_payloads: false,
                include_internal: false,
            })
            .map_err(store_err)?;
        for message in page.messages.into_iter().rev() {
            if selected.contains(&message.id)
                && matches!(message.role, Role::User | Role::Assistant)
            {
                messages.push(json!({"role":message.role,"content":message.content,"createdAt":message.created_at}));
            }
        }
        before = page.next_cursor;
        if before.is_none() || messages.len() == selected.len() {
            break;
        }
    }
    messages.reverse();
    Ok(messages)
}
