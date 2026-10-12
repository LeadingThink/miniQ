use super::fetch::FetchError;
use super::*;

pub(super) struct JsonResponse {
    pub(super) status: StatusCode,
    pub(super) body: Value,
}

pub(super) async fn send_json(
    client: &Client,
    media: &crate::MediaConfig,
    url: &str,
) -> Result<JsonResponse, FetchError> {
    let mut last_status = None;
    for attempt in 0..MAX_RETRIES {
        let result = client.get(url).bearer_auth(&media.api_key).send().await;
        match result {
            Ok(response) => {
                let status = response.status();
                if !status.is_success() {
                    let body = response.json::<Value>().await.unwrap_or_else(|_| json!({}));
                    if status.is_server_error() && attempt + 1 < MAX_RETRIES {
                        tokio::time::sleep(Duration::from_millis(50 * (attempt as u64 + 1))).await;
                        continue;
                    }
                    return Ok(JsonResponse { status, body });
                }
                let body = response.json::<Value>().await.map_err(|_| FetchError {
                    message: format!("status={} code=-1 malformed JSON response", status.as_u16()),
                    unsupported: false,
                })?;
                if body.get("code").is_some_and(|code| {
                    !matches!(code.as_str(), Some("0")) && code.as_i64() != Some(0)
                }) {
                    return Err(FetchError {
                        message: format!("status={} code=-1 channel error", status.as_u16()),
                        unsupported: false,
                    });
                }
                return Ok(JsonResponse { status, body });
            }
            Err(_) if attempt + 1 < MAX_RETRIES => {
                tokio::time::sleep(Duration::from_millis(50 * (attempt as u64 + 1))).await;
            }
            Err(_) => {
                return Err(FetchError {
                    message: "status=0 code=-1 network failure".into(),
                    unsupported: false,
                })
            }
        }
        last_status = Some(0);
    }
    Err(FetchError {
        message: format!("status={} code=-1 request failed", last_status.unwrap_or(0)),
        unsupported: false,
    })
}

pub(super) async fn send_text(
    client: &Client,
    media: &crate::MediaConfig,
    url: &str,
) -> Result<(StatusCode, String), FetchError> {
    for attempt in 0..MAX_RETRIES {
        match client.get(url).bearer_auth(&media.api_key).send().await {
            Ok(response) => {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                if status.is_server_error() && attempt + 1 < MAX_RETRIES {
                    tokio::time::sleep(Duration::from_millis(50 * (attempt as u64 + 1))).await;
                    continue;
                }
                return Ok((status, text));
            }
            Err(_) if attempt + 1 < MAX_RETRIES => {
                tokio::time::sleep(Duration::from_millis(50 * (attempt as u64 + 1))).await
            }
            Err(_) => {
                return Err(FetchError {
                    message: "status=0 code=-1 network failure".into(),
                    unsupported: false,
                })
            }
        }
    }
    Err(FetchError {
        message: "status=0 code=-1 request failed".into(),
        unsupported: false,
    })
}
