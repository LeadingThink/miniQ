//! Publish explicit, immutable conversation snapshots. Viewing never grants RPC access.
use super::common::{params, store_err};
use crate::state::AppState;
use miniq_protocol::{ErrorCode, Role, RpcError};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io::Read, time::Duration};

mod snapshot;
#[cfg(test)]
mod tests;
use snapshot::Snapshot;

const SHARE_API: &str = "https://oneapi.zaiwenai.com/miniq-relay/shares";
const SHARE_VIEW: &str = "https://oneapi.zaiwenai.com/miniq/?share=";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CreateInput {
    session_id: String,
    id: String,
    title: String,
    message_ids: Vec<String>,
    artifact_ids: Vec<String>,
    expires_in_days: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManageInput {
    session_id: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    after: Option<String>,
}

fn invalid(message: impl ToString) -> RpcError {
    RpcError::new(ErrorCode::InvalidParams, message.to_string())
}

fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn connection(
    state: &AppState,
    session_id: &str,
) -> Result<(reqwest::Client, String, String), RpcError> {
    state.store.get_session(session_id).map_err(store_err)?;
    let settings = state.settings.lock().unwrap();
    let provider = settings
        .provider
        .as_ref()
        .ok_or_else(|| invalid("请先配置 OneAPI Key"))?;
    let url = url::Url::parse(&provider.base_url).map_err(|_| invalid("模型服务地址无效"))?;
    if url.scheme() != "https"
        || url.host_str() != Some("oneapi.zaiwenai.com")
        || provider.api_key.trim().is_empty()
    {
        return Err(invalid(
            "公开分享需要在设置中配置 oneapi.zaiwenai.com 的 Key",
        ));
    }
    let scope = format!(
        "{:x}",
        Sha256::digest(format!(
            "miniq-share-scope-v1\0{}\0{session_id}",
            settings.remote_access.device_id
        ))
    );
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| invalid("无法初始化分享连接"))?;
    Ok((client, provider.api_key.trim().to_owned(), scope))
}

async fn response(request: reqwest::RequestBuilder) -> Result<Value, RpcError> {
    let response = request.send().await.map_err(|_| {
        RpcError::new(
            ErrorCode::ProviderError,
            "分享连接中断；可在已有链接中检查结果后重试",
        )
    })?;
    let status = response.status();
    let value: Value = response
        .json()
        .await
        .map_err(|_| RpcError::new(ErrorCode::ProviderError, "分享服务响应无效"))?;
    if !status.is_success() {
        return Err(RpcError::new(
            ErrorCode::ProviderError,
            value["error"]
                .as_str()
                .unwrap_or("分享请求失败，请稍后重试"),
        ));
    }
    Ok(value)
}

fn with_url(mut value: Value) -> Result<Value, RpcError> {
    let id = value["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or_else(|| invalid("分享服务返回无效链接"))?;
    value["url"] = json!(format!("{SHARE_VIEW}{id}"));
    Ok(value)
}

pub(super) async fn create(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let _slot = state
        .share_uploads
        .try_acquire()
        .map_err(|_| RpcError::new(ErrorCode::SessionBusy, "已有分享正在上传，请稍后重试"))?;
    let input: CreateInput = params(raw)?;
    if !valid_id(&input.id)
        || ![7, 30, 90].contains(&input.expires_in_days)
        || input.title.trim().is_empty()
        || input.title.chars().count() > 300
    {
        return Err(invalid("分享标题、有效期或标识无效"));
    }
    let (client, key, scope) = connection(state, &input.session_id)?;
    let state = state.clone();
    let id = input.id.clone();
    let snapshot = tokio::task::spawn_blocking(move || Snapshot::build(&state, &input, scope))
        .await
        .map_err(invalid)??;
    publish(&client, &key, SHARE_API, &id, snapshot)
        .await
        .and_then(with_url)
}

async fn publish(
    client: &reqwest::Client,
    key: &str,
    api: &str,
    id: &str,
    snapshot: Snapshot,
) -> Result<Value, RpcError> {
    let url = format!("{api}/{id}");
    let draft = response(client.put(&url).bearer_auth(key).json(&snapshot.payload)).await?;
    if draft["published"] == true {
        return Ok(draft);
    }
    for file in snapshot.files {
        let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file.handle));
        response(
            client
                .put(format!("{url}/files/{}", file.id))
                .bearer_auth(key)
                .header("content-type", "application/octet-stream")
                .header("content-length", file.size)
                .body(reqwest::Body::wrap_stream(stream)),
        )
        .await?;
    }
    response(client.post(format!("{url}/publish")).bearer_auth(key)).await
}

pub(super) async fn list(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ManageInput = params(raw)?;
    let (client, key, scope) = connection(state, &input.session_id)?;
    if input.after.as_ref().is_some_and(|id| !valid_id(id)) {
        return Err(invalid("分享分页无效"));
    }
    let mut result = response(
        client
            .get(format!("{SHARE_API}/manage"))
            .bearer_auth(key)
            .query(&[("scope", scope), ("after", input.after.unwrap_or_default())]),
    )
    .await?;
    let rows = result["shares"]
        .as_array_mut()
        .ok_or_else(|| invalid("分享列表响应无效"))?;
    for row in rows {
        *row = with_url(row.take())?;
    }
    Ok(result)
}

pub(super) async fn revoke(state: &AppState, raw: Option<Value>) -> Result<Value, RpcError> {
    let input: ManageInput = params(raw)?;
    let id = input
        .id
        .filter(|id| valid_id(id))
        .ok_or_else(|| invalid("分享标识无效"))?;
    let (client, key, scope) = connection(state, &input.session_id)?;
    // The service authorizes the key; scope additionally isolates sessions using that key.
    response(
        client
            .delete(format!("{SHARE_API}/{id}"))
            .bearer_auth(key)
            .header("x-share-scope", scope),
    )
    .await
}
