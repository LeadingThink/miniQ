use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::{Mutex, OnceLock};

const ACCOUNT_BASE_URL: &str = "https://oneapi.zaiwenai.com/v1";
struct AccountSession {
    client: reqwest::Client,
    token: Option<String>,
}

static CLIENT: OnceLock<Mutex<Option<AccountSession>>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRequest {
    pub base_url: String,
    pub path: String,
    pub method: String,
    pub body: Option<Value>,
}

#[derive(Serialize)]
pub struct AccountResponse {
    pub status: u16,
    pub data: Value,
}

fn validated_url(request: &AccountRequest) -> Result<String, String> {
    if request.base_url.trim_end_matches('/') != ACCOUNT_BASE_URL {
        return Err("桌面账户仅支持官方在问服务".into());
    }
    let allowed = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/user")
        | ("POST", "/user/login" | "/user/logout" | "/user/sms" | "/keys") => true,
        ("GET", path) if path.starts_with("/keys?") => {
            let pairs: Vec<_> = url::form_urlencoded::parse(path[6..].as_bytes()).collect();
            pairs.len() == 2
                && pairs
                    .iter()
                    .filter(|(key, value)| {
                        key == "page" && value.parse::<u32>().is_ok_and(|page| page > 0)
                    })
                    .count()
                    == 1
                && pairs
                    .iter()
                    .filter(|(key, value)| key == "page_size" && value == "10")
                    .count()
                    == 1
        }
        _ => false,
    };
    if !allowed || request.path.contains('#') {
        return Err("桌面账户服务不支持此接口".into());
    }
    Ok(format!("{ACCOUNT_BASE_URL}{}", request.path))
}

fn trusted_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("账户命令仅允许主窗口调用".into())
    }
}

fn account_session() -> Result<std::sync::MutexGuard<'static, Option<AccountSession>>, String> {
    let mut state = CLIENT
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "账户会话不可用")?;
    if state.is_none() {
        *state = Some(AccountSession {
            client: reqwest::Client::builder()
                .cookie_store(true)
                .redirect(reqwest::redirect::Policy::none())
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .map_err(|_| "无法初始化账户网络请求")?,
            token: None,
        });
    }
    Ok(state)
}

#[tauri::command]
pub async fn desktop_account_request(
    webview: tauri::Webview,
    request: AccountRequest,
) -> Result<AccountResponse, String> {
    trusted_main_webview(webview.label())?;
    let url = validated_url(&request)?;
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| "账户请求方法无效")?;
    let (client, token) = {
        let session = account_session()?;
        let session_state = session
            .as_ref()
            .ok_or_else(|| "账户会话不可用".to_string())?;
        (session_state.client.clone(), session_state.token.clone())
    };
    let mut builder = client.request(method, url)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("channel", "web.zaiwenai.com")
        .header(reqwest::header::CACHE_CONTROL, "no-store");
    if let Some(token) = token.as_deref() {
        builder = builder.header("token", token);
    }
    if let Some(body) = request.body {
        builder = builder.json(&body);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "无法连接账户服务，请检查网络后重试。")?;
    let status = response.status().as_u16();
    if request.path == "/user/login" && (200..300).contains(&status) {
        if let Some(token) = response.headers().get("token").and_then(|value| value.to_str().ok()) {
            if let Ok(mut session) = CLIENT.get_or_init(|| Mutex::new(None)).lock() {
                if let Some(session) = session.as_mut() {
                    session.token = Some(token.to_string());
                }
            }
        }
    }
    let mut data = response
        .json::<Value>()
        .await
        .map_err(|_| "账户服务返回格式无效")?;
    if request.path == "/user/logout" && (200..300).contains(&status) && data["code"] == "0" {
        if let Ok(mut session) = CLIENT.get_or_init(|| Mutex::new(None)).lock() {
            if let Some(session) = session.as_mut() {
                session.token = None;
            }
        }
    }
    // Login may include a JWT in its JSON body. Authentication stays in the cookie jar.
    if request.path == "/user/login" {
        data = serde_json::json!({ "code": data.get("code"), "data": null });
    }
    Ok(AccountResponse { status, data })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(method: &str, path: &str) -> AccountRequest {
        AccountRequest {
            base_url: ACCOUNT_BASE_URL.into(),
            path: path.into(),
            method: method.into(),
            body: None,
        }
    }
    #[test]
    fn restricts_origin_methods_and_paths() {
        for (method, path) in [
            ("GET", "/user"),
            ("POST", "/user/login"),
            ("POST", "/user/logout"),
            ("POST", "/user/sms"),
            ("POST", "/keys"),
            ("GET", "/keys?page=2&page_size=10"),
        ] {
            assert!(validated_url(&request(method, path)).is_ok());
        }
        for (method, path) in [
            ("GET", "/user/login"),
            ("POST", "/user"),
            ("POST", "/user/delete"),
            ("GET", "/iap/apple/context"),
            ("GET", "/keys?page=0&page_size=10"),
            ("GET", "/keys?page=1&page_size=10&redirect=x"),
            ("GET", "/keys?page=1&page_size=10#x"),
            ("DELETE", "/keys"),
        ] {
            assert!(validated_url(&request(method, path)).is_err());
        }
        for base in [
            "http://oneapi.zaiwenai.com/v1",
            "https://evil.example/v1",
            "https://oneapi.zaiwenai.com.evil.example/v1",
        ] {
            let mut value = request("GET", "/user");
            value.base_url = base.into();
            assert!(validated_url(&value).is_err());
        }
    }
    #[test]
    fn allows_only_trusted_main_webview() {
        assert!(trusted_main_webview("main").is_ok());
        assert!(trusted_main_webview("companion").is_err());
        assert!(trusted_main_webview("browser-1").is_err());
    }
}
