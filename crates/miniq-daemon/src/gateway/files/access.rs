//! Mobile confirmation of one canonical file, using the existing session allowlist.
//! File identities remain pinned so replacing a path cannot inherit its permission.
use super::{invalid, params, revision, scope, transfer, AppState, FileInput};
use miniq_protocol::{ErrorCode, RpcError};
use same_file::Handle;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

mod links;
mod protected;

const CONFIRMATION_TTL: Duration = Duration::from_secs(300);
// Pinned identities hold OS handles; leave room below common 256-FD limits
// for the database, sockets, subprocesses and active file transfers.
const MAX_PENDING: usize = 8;
const MAX_GRANTED: usize = 32;

#[derive(Default)]
pub(crate) struct FileAccess {
    pending: HashMap<String, Pending>,
    granted: HashMap<(String, PathBuf), Grant>,
}

impl FileAccess {
    pub(crate) fn expire_pending(&mut self) {
        self.pending
            .retain(|_, pending| pending.expires > Instant::now());
    }

    pub(crate) fn clear_session(&mut self, session: &str) {
        self.pending.retain(|_, pending| pending.session != session);
        self.granted.retain(|(owner, _), _| owner != session);
    }

    fn prune(&mut self, state: &AppState) {
        self.expire_pending();
        self.granted.retain(|(session, _), grant| {
            state.store.get_session(session).is_ok()
                && state.is_allowed_for_session(session, &grant.permission)
        });
    }
}

struct Pending {
    session: String,
    actor: String,
    requested: PathBuf,
    path: PathBuf,
    handle: Handle,
    revision: String,
    expires: Instant,
}

struct Grant {
    permission: String,
    handle: Handle,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Decision {
    session_id: String,
    request_id: String,
    allow: bool,
}

pub(crate) async fn dispatch(
    state: &AppState,
    method: &str,
    raw: Option<Value>,
    actor: Option<&str>,
    authenticated_remote: bool,
) -> Result<Value, RpcError> {
    let actor = actor
        .filter(|actor| {
            authenticated_remote
                && actor
                    .strip_prefix("remote:")
                    .is_some_and(|peer| !peer.is_empty())
        })
        .ok_or_else(|| RpcError::new(ErrorCode::Unauthorized, "文件授权需要已认证的远程连接"))?
        .to_owned();
    let state = state.clone();
    if method == "file.access.request" {
        let input: FileInput = params(raw)?;
        tokio::task::spawn_blocking(move || request(&state, input, &actor))
            .await
            .map_err(invalid)?
    } else {
        let input: Decision = params(raw)?;
        tokio::task::spawn_blocking(move || resolve(&state, input, &actor))
            .await
            .map_err(invalid)?
    }
}

fn request(state: &AppState, input: FileInput, actor: &str) -> Result<Value, RpcError> {
    let scope = scope(state, &input.session_id)?;
    let requested = Path::new(&scope.cwd).join(&input.path);
    let network_path = requested.components().any(|part| matches!(part,
        Component::Prefix(prefix) if !matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_))
    )) || (!cfg!(windows) && input.path.starts_with("\\\\")) || input.path.starts_with("//");
    // Never interpret a supplied parent traversal or Windows alternate stream
    // as permission to another file. The confirmation displays the canonical path.
    if requested
        .components()
        .any(|part| part == Component::ParentDir)
        || input.path.split(['/', '\\']).any(|part| part == "..")
        || requested.components().any(
            |part| matches!(part, Component::Normal(name) if name.to_string_lossy().contains(':')),
        )
        || !requested.is_absolute()
        || network_path
    {
        return Err(invalid(
            "只能授权本地单个文件，路径不能包含目录跳转、网络共享或备用数据流",
        ));
    }
    let (path, file) = candidate(state, &requested)?;
    let metadata = file.metadata().map_err(invalid)?;
    let handle = Handle::from_file(file).map_err(invalid)?;
    let mut access = state.file_access.lock().unwrap();
    access.prune(state);
    if access.pending.len() >= MAX_PENDING
        || (access.granted.len() >= MAX_GRANTED
            && !access
                .granted
                .contains_key(&(input.session_id.clone(), path.clone())))
    {
        return Err(invalid("文件授权数量已达上限，请重启桌面后重新授权"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    access.pending.insert(
        id.clone(),
        Pending {
            session: input.session_id,
            actor: actor.into(),
            requested,
            path: path.clone(),
            handle,
            revision: revision(&metadata).map_err(invalid)?,
            expires: Instant::now() + CONFIRMATION_TTL,
        },
    );
    Ok(json!({"requestId":id,"path":path,"expiresInSeconds":CONFIRMATION_TTL.as_secs()}))
}

fn resolve(state: &AppState, input: Decision, actor: &str) -> Result<Value, RpcError> {
    scope(state, &input.session_id)?;
    let mut access = state.file_access.lock().unwrap();
    access.prune(state);
    let pending = access
        .pending
        .get(&input.request_id)
        .filter(|pending| pending.session == input.session_id && pending.actor == actor)
        .ok_or_else(|| invalid("文件授权确认已过期或不属于当前会话和设备，请重新请求"))?;
    if !input.allow {
        let pending = access
            .pending
            .remove(&input.request_id)
            .expect("checked pending");
        crate::audit::record(
            state,
            actor,
            "file.preview.rejected",
            json!({"sessionId":input.session_id,"path":pending.path}),
        );
        return Ok(json!({"allowed":false}));
    }
    // Consume before revalidation: a changed target cannot be approved by
    // replaying the same consent after a transient failure.
    let requested = pending.requested.clone();
    let pending = access
        .pending
        .remove(&input.request_id)
        .expect("checked pending");
    let (path, file) = candidate(state, &requested)?;
    let metadata = file.metadata().map_err(invalid)?;
    let current = Handle::from_file(file).map_err(invalid)?;
    if path != pending.path
        || current != pending.handle
        || revision(&metadata).map_err(invalid)? != pending.revision
    {
        return Err(invalid("文件在确认期间发生变化，请重新请求授权"));
    }
    if access.granted.len() >= MAX_GRANTED
        && !access
            .granted
            .contains_key(&(input.session_id.clone(), path.clone()))
    {
        return Err(invalid("文件授权数量已达上限"));
    }
    // This namespace cannot match any ToolExecutor approval pattern. It never
    // adds a root, attachment, persistent always-allow rule, or tool permission.
    let permission = format!("file-preview:{}", input.request_id);
    state.allow_for_session(&input.session_id, &permission);
    crate::audit::record(
        state,
        actor,
        "file.preview.authorized",
        json!({"sessionId":input.session_id,"path":path}),
    );
    let previous = access.granted.insert(
        (input.session_id.clone(), path.clone()),
        Grant {
            permission,
            handle: pending.handle,
        },
    );
    if let Some(previous) = previous {
        if let Some(allowlist) = state
            .session_allowlist
            .lock()
            .unwrap()
            .get_mut(&input.session_id)
        {
            allowlist.remove(&previous.permission);
        }
    }
    Ok(json!({"allowed":true,"path":path}))
}

fn candidate(state: &AppState, requested: &Path) -> Result<(PathBuf, File), RpcError> {
    let path = dunce::canonicalize(requested).map_err(invalid)?;
    protected::check(state, requested).map_err(invalid)?;
    protected::check(state, &path).map_err(invalid)?;
    if super::is_staging_file(&path) {
        return Err(invalid("未完成传输的文件不能授权"));
    }
    let file = transfer::open_source_file(&path).map_err(invalid)?;
    let metadata = file.metadata().map_err(invalid)?;
    if !metadata.is_file() {
        return Err(invalid("只能授权单个普通文件"));
    }
    // A second hard-link name can hide a protected credential path.
    links::ensure_single_link(&file).map_err(invalid)?;
    Ok((path, file))
}

pub(super) fn allowed(
    state: &AppState,
    session: &str,
    path: &Path,
    file: &File,
) -> Result<bool, String> {
    let access = state.file_access.lock().unwrap();
    let Some(grant) = access.granted.get(&(session.to_owned(), path.to_owned())) else {
        return Ok(false);
    };
    let current = Handle::from_file(file.try_clone().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    Ok(current == grant.handle && state.is_allowed_for_session(session, &grant.permission))
}

#[cfg(test)]
mod tests;
