use std::path::Path;
use std::time::Duration;

use reqwest::redirect::Policy;
use reqwest::Response;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;
use url::Url;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_REDIRECTS: usize = 10;
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

fn is_allowed_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
}

fn validate_external_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value.trim()).map_err(|_| "链接地址无效".to_string())?;
    if !is_allowed_url(&url) {
        return Err("只允许不含账号密码的 HTTP(S) 链接".to_string());
    }
    Ok(url)
}

fn redirect_policy() -> Policy {
    Policy::custom(|attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            return attempt.error("下载重定向次数过多");
        }
        if is_allowed_url(attempt.url()) {
            attempt.follow()
        } else {
            attempt.error("下载重定向被阻止")
        }
    })
}

fn percent_decode_path_segment(segment: &str) -> String {
    let mut decoded = Vec::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = hex_value(bytes[index + 1]);
            let low = hex_value(bytes[index + 2]);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        let character = segment[index..]
            .chars()
            .next()
            .expect("index always points at a character boundary");
        let mut buffer = [0; 4];
        decoded.extend_from_slice(character.encode_utf8(&mut buffer).as_bytes());
        index += character.len_utf8();
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "download".to_string()
    } else {
        cleaned.to_owned()
    }
}

fn file_name_from_url(url: &Url) -> String {
    let segment = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .unwrap_or("download");
    sanitize_file_name(&percent_decode_path_segment(segment))
}

async fn stream_response_to_file(mut response: Response, path: &Path) -> Result<(), String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOWNLOAD_BYTES)
    {
        return Err("下载文件超过 200 MB".to_string());
    }

    let mut file = tokio::fs::File::create(path)
        .await
        .map_err(|_| "无法创建临时文件".to_string())?;
    let mut written = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "下载数据失败".to_string())?
    {
        let chunk_length = u64::try_from(chunk.len()).unwrap_or(u64::MAX);
        written = written
            .checked_add(chunk_length)
            .ok_or_else(|| "下载文件超过 200 MB".to_string())?;
        if written > MAX_DOWNLOAD_BYTES {
            return Err("下载文件超过 200 MB".to_string());
        }
        file.write_all(&chunk)
            .await
            .map_err(|_| "无法写入临时文件".to_string())?;
    }
    file.flush()
        .await
        .map_err(|_| "无法完成临时文件写入".to_string())?;
    file.sync_all()
        .await
        .map_err(|_| "无法完成临时文件写入".to_string())?;
    Ok(())
}

async fn download_to_temp(url: Url) -> Result<tempfile::TempPath, String> {
    // reqwest's rustls-no-provider feature requires an explicit provider.
    // Err means another client already installed the process-wide provider.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(DOWNLOAD_TIMEOUT)
        .redirect(redirect_policy())
        .build()
        .map_err(|_| "无法准备下载".to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "无法连接下载地址".to_string())?
        .error_for_status()
        .map_err(|_| "下载请求失败".to_string())?;

    // Unsupported redirect schemes can be returned as an unfollowed 3xx.
    if !response.status().is_success() {
        return Err("下载地址未返回文件".to_string());
    }

    // Keep this defense in depth even though the custom redirect policy checks
    // every hop before reqwest follows it.
    if !is_allowed_url(response.url()) {
        return Err("下载重定向被阻止".to_string());
    }

    let temp = tempfile::NamedTempFile::new().map_err(|_| "无法创建临时文件".to_string())?;
    let temp_path = temp.into_temp_path();
    let path = temp_path.to_path_buf();
    match tokio::time::timeout(DOWNLOAD_TIMEOUT, stream_response_to_file(response, &path)).await {
        Ok(result) => result.map(|()| temp_path),
        Err(_) => Err("下载超时".to_string()),
    }
}

async fn choose_save_path(
    app: AppHandle,
    file_name: String,
) -> Result<Option<std::path::PathBuf>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(file_name)
            .blocking_save_file()
            .map(|path| path.into_path())
            .transpose()
            .map_err(|_| "无法使用所选位置".to_string())
    })
    .await
    .map_err(|_| "保存对话框失败".to_string())?
}

async fn stage_and_replace(temp_path: &Path, target: std::path::PathBuf) -> Result<(), String> {
    let source = temp_path.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let directory = target
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let staging = tempfile::NamedTempFile::new_in(directory)
            .map_err(|_| "无法创建保存临时文件".to_string())?;
        std::fs::copy(&source, staging.path()).map_err(|_| "无法准备保存文件".to_string())?;
        staging
            .as_file()
            .sync_all()
            .map_err(|_| "无法完成保存文件写入".to_string())?;
        staging
            .persist(&target)
            .map_err(|_| "无法替换目标文件".to_string())?;
        Ok(())
    })
    .await
    .map_err(|_| "保存文件失败".to_string())?
}

/// Downloads an HTTP(S) link after an explicit user menu action and asks
/// where to save the exact response bytes. The target is touched only after
/// the complete response has been downloaded and verified.
#[tauri::command]
pub async fn save_external_link_as(app: AppHandle, url: String) -> Result<Option<String>, String> {
    let parsed_url = validate_external_url(&url)?;
    let file_name = file_name_from_url(&parsed_url);
    let temp_path = download_to_temp(parsed_url).await?;
    let target = match choose_save_path(app, file_name).await? {
        Some(target) => target,
        None => {
            drop(temp_path);
            return Ok(None);
        }
    };

    stage_and_replace(&temp_path, target.clone()).await?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn serve_once(response: Vec<u8>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/report.pdf", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            stream.read(&mut request).await.unwrap();
            stream.write_all(&response).await.unwrap();
            stream.shutdown().await.unwrap();
        });
        (url, server)
    }

    #[tokio::test]
    async fn downloads_binary_bytes_and_replaces_only_after_staging() {
        let bytes = b"%PDF-1.7\r\n\0\xff\x80\r\n%%EOF";
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            bytes.len()
        )
        .into_bytes();
        response.extend_from_slice(bytes);
        let (url, server) = serve_once(response).await;
        let downloaded = download_to_temp(validate_external_url(&url).unwrap())
            .await
            .unwrap();
        server.await.unwrap();
        assert_eq!(std::fs::read(&downloaded).unwrap(), bytes);
        let destination = tempfile::tempdir().unwrap();
        let target = destination.path().join("report.pdf");
        std::fs::write(&target, b"previous file").unwrap();
        stage_and_replace(&downloaded, target.clone())
            .await
            .unwrap();
        assert_eq!(std::fs::read(target).unwrap(), bytes);
    }

    #[tokio::test]
    async fn refuses_failed_responses_and_non_web_redirects() {
        for response in [
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 302 Found\r\nLocation: file:///private/report.pdf\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 209715201\r\nConnection: close\r\n\r\n",
        ] {
            let (url, server) = serve_once(response.as_bytes().to_vec()).await;
            assert!(download_to_temp(validate_external_url(&url).unwrap()).await.is_err());
            server.await.unwrap();
        }
    }

    #[test]
    fn allows_only_http_and_https_without_credentials() {
        assert!(validate_external_url("http://example.test/file").is_ok());
        assert!(validate_external_url("https://example.test/file").is_ok());
        assert!(validate_external_url("ftp://example.test/file").is_err());
        assert!(validate_external_url("file:///tmp/file").is_err());
        assert!(validate_external_url("https://user@example.test/file").is_err());
        assert!(validate_external_url("https://user:password@example.test/file").is_err());
        assert!(validate_external_url("not a URL").is_err());
    }

    #[test]
    fn decodes_url_filename_and_keeps_safe_unicode_spaces_percent_and_hash() {
        let url = Url::parse("https://example.test/%E4%B8%AD%E6%96%87%20file%25%23.txt").unwrap();
        assert_eq!(file_name_from_url(&url), "中文 file%#.txt");

        let plus = Url::parse("https://example.test/a+b.txt").unwrap();
        assert_eq!(file_name_from_url(&plus), "a+b.txt");
    }

    #[test]
    fn sanitizes_traversal_separators_and_control_characters() {
        let encoded_traversal = Url::parse("https://example.test/%2E%2E%2Fsecret%00.txt").unwrap();
        assert_eq!(file_name_from_url(&encoded_traversal), "_secret_.txt");

        assert_eq!(
            sanitize_file_name("a/b\\c:d*e?f\"g<h>i|j\u{0}"),
            "a_b_c_d_e_f_g_h_i_j_"
        );
        assert_eq!(sanitize_file_name("../"), "_");
        assert_eq!(
            file_name_from_url(&Url::parse("https://example.test/").unwrap()),
            "download"
        );
    }
}
