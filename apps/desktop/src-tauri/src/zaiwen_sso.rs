//! Main-site login stays in its WebView. Tickets and OneAPI cookies stay native.
use crate::{account_transport, browser};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const TICKET_URL: &str = "https://back.zaiwenai.com/api/v1/user/sso-ticket";
const PLATFORM_URL: &str = "https://platform.zaiwenai.com/user";
// JSON.stringify keeps the result contract identical on WebView2 and WKWebView.
const SESSION_SCRIPT: &str = include_str!("zaiwen_session.js");
const SESSION_CHANGED: &str = "在问账号已变化，请重新确认导入。";
static SSO_CLIENT: OnceLock<Mutex<Option<(String, Client)>>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    supported: bool,
    session_id: Option<String>,
}

#[derive(Deserialize)]
struct Ticket {
    ticket: String,
    expires_at: u64,
    redeem_url: String,
}

#[derive(Deserialize)]
struct TicketResponse {
    code: String,
    data: Option<Ticket>,
}

fn session_id(token: &str) -> String {
    // A non-authorizing change marker only. Never expose the bearer token to JS.
    let mut hash = DefaultHasher::new();
    token.hash(&mut hash);
    format!("{:016x}", hash.finish())
}

fn decode_token(result: &str) -> Result<Option<String>, String> {
    let inner: String = serde_json::from_str(result).map_err(|_| "主站登录状态格式无效")?;
    let token: Option<String> = serde_json::from_str(&inner).map_err(|_| "主站登录状态格式无效")?;
    Ok(token.filter(|value| !value.trim().is_empty()))
}

async fn main_site_token(app: &tauri::AppHandle) -> Result<Option<String>, String> {
    if !browser::capabilities().dom_snapshot {
        return Err("此平台尚不支持读取主站登录态".into());
    }
    let result = browser::evaluate(app, "zaiwen-site", SESSION_SCRIPT.into())
        .await
        .map_err(|_| "无法读取在问登录状态，请等待主站加载完成后重试。")?;
    decode_token(&result)
}

pub async fn assert_session(app: &tauri::AppHandle, expected: &str) -> Result<(), String> {
    match main_site_token(app).await? {
        Some(token) if session_id(&token) == expected => Ok(()),
        _ => Err(SESSION_CHANGED.into()),
    }
}

#[tauri::command]
pub async fn zaiwen_session_status(webview: tauri::Webview) -> Result<SessionStatus, String> {
    account_transport::trusted_main_webview(webview.label())?;
    let supported = browser::capabilities().dom_snapshot;
    let token = if supported {
        main_site_token(webview.app_handle()).await?
    } else {
        None
    };
    let id = token.as_deref().map(session_id);
    if let Ok(mut state) = SSO_CLIENT.get_or_init(|| Mutex::new(None)).lock() {
        if state
            .as_ref()
            .is_some_and(|(old, _)| Some(old) != id.as_ref())
        {
            *state = None;
        }
    }
    Ok(SessionStatus {
        supported,
        session_id: id,
    })
}

fn official_url(value: &str, host: &str) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "SSO 服务地址无效")?;
    if url.scheme() != "https"
        || url.host_str() != Some(host)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("SSO 服务地址无效".into());
    }
    Ok(url)
}

fn redemption_url(status: u16, body: TicketResponse, now: u64) -> Result<url::Url, String> {
    if status == 403 || body.code == "00403" {
        return Err("主站登录已过期，请重新登录在问。".into());
    }
    if status == 503 || body.code == "00503" {
        return Err("主站 SSO 暂不可用，请稍后重试或在模型设置中登录账户。".into());
    }
    if status != 200 || body.code != "0" {
        return Err("主站 SSO 连接失败，请稍后重试。".into());
    }
    let ticket = body.data.ok_or("主站未返回 SSO 票据")?;
    if ticket.ticket.is_empty() || ticket.expires_at <= now {
        return Err("SSO 票据已过期，请重试。".into());
    }
    // Use the returned path; never assume /v1/sso. Restrict the credential recipient.
    let mut url = official_url(&ticket.redeem_url, "oneapi.zaiwenai.com")?;
    if url.query().is_some() {
        return Err("SSO 服务地址无效".into());
    }
    url.query_pairs_mut()
        .append_pair("ticket", &ticket.ticket)
        .append_pair("next", PLATFORM_URL);
    Ok(url)
}

fn validate_redemption(status: u16, location: &str, has_cookie: bool) -> Result<(), String> {
    if status != 302 || !has_cookie {
        return Err("SSO 登录未成功，请重新登录在问后重试。".into());
    }
    official_url(location, "platform.zaiwenai.com")?;
    Ok(())
}

#[tauri::command]
pub async fn zaiwen_account_login(
    webview: tauri::Webview,
    session_id: String,
) -> Result<(), String> {
    account_transport::trusted_main_webview(webview.label())?;
    let app = webview.app_handle();
    let token = main_site_token(app).await?.ok_or("请先在在问主站登录。")?;
    if self::session_id(&token) != session_id {
        return Err(SESSION_CHANGED.into());
    }
    // A fresh jar prevents a failed redemption from reusing an unrelated SMS login.
    let client = account_transport::new_account_client()?;
    let response = client
        .get(TICKET_URL)
        .header("token", token)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-store")
        .send()
        .await
        .map_err(|_| "无法连接主站 SSO 服务，请检查网络后重试。")?;
    let status = response.status().as_u16();
    let body = response
        .json::<TicketResponse>()
        .await
        .map_err(|_| "主站 SSO 响应格式无效")?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_secs();
    let redeem = redemption_url(status, body, now)?;
    // Immediately consume once; do not follow redirects or retain/log credential URLs.
    let response = client
        .get(redeem)
        .send()
        .await
        .map_err(|_| "SSO 兑换失败，请重新尝试导入。")?;
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let has_cookie = response
        .cookies()
        .any(|cookie| cookie.name() == "token" && !cookie.value().is_empty());
    validate_redemption(response.status().as_u16(), location, has_cookie)?;
    assert_session(app, &session_id).await?;
    *SSO_CLIENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "SSO 会话不可用")? = Some((session_id, client));
    Ok(())
}

pub async fn client_for(app: &tauri::AppHandle, session_id: &str) -> Result<Client, String> {
    assert_session(app, session_id).await?;
    SSO_CLIENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "SSO 会话不可用")?
        .as_ref()
        .filter(|(id, _)| id == session_id)
        .map(|(_, client)| client.clone())
        .ok_or_else(|| "请先确认导入并连接在问账户。".into())
}

#[cfg(test)]
#[path = "zaiwen_sso_tests.rs"]
mod tests;
