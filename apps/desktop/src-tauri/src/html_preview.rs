//! Read-only, revocable HTML resource origins. Preview code never runs on the app origin.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path as RoutePath, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::{routing::get, Router};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

#[derive(Default)]
pub struct HtmlPreviews(Mutex<HashMap<String, CancellationToken>>);

#[derive(serde::Serialize)]
pub struct PreviewHandle {
    id: String,
    url: String,
}

#[derive(Clone)]
struct Grant {
    id: String,
    root: PathBuf,
    origin: String,
    network: bool,
    cancelled: CancellationToken,
}

impl HtmlPreviews {
    pub async fn open(
        &self,
        path: &str,
        workspace: &str,
        attached: &[String],
        network: bool,
    ) -> Result<PreviewHandle, String> {
        let file = super::local_file::validated_file(path, workspace, attached)?;
        if !matches!(
            file.extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("html" | "htm")
        ) {
            return Err("HTML preview requires an HTML file".into());
        }
        // Only this document's directory is exposed, never the whole workspace.
        let root = file
            .parent()
            .ok_or("HTML file has no parent directory")?
            .to_owned();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| error.to_string())?;
        let origin = format!(
            "http://{}",
            listener.local_addr().map_err(|error| error.to_string())?
        );
        let id = uuid::Uuid::new_v4().to_string();
        let mut url = tauri::Url::parse(&origin).map_err(|error| error.to_string())?;
        url.path_segments_mut()
            .map_err(|_| "invalid preview origin")?
            .push(&id)
            .push(
                file.file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("HTML filename is not UTF-8")?,
            );
        let cancelled = CancellationToken::new();
        let grant = Grant {
            id: id.clone(),
            root,
            origin,
            network,
            cancelled: cancelled.clone(),
        };
        self.0
            .lock()
            .map_err(|_| "HTML preview lock poisoned")?
            .insert(id.clone(), cancelled.clone());
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router(grant))
                .with_graceful_shutdown(cancelled.cancelled_owned())
                .await;
        });
        Ok(PreviewHandle {
            id,
            url: url.to_string(),
        })
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        if let Some(cancelled) = self
            .0
            .lock()
            .map_err(|_| "HTML preview lock poisoned")?
            .remove(id)
        {
            cancelled.cancel();
        }
        Ok(())
    }
}

impl Drop for HtmlPreviews {
    fn drop(&mut self) {
        if let Ok(previews) = self.0.get_mut() {
            for token in previews.values() {
                token.cancel();
            }
        }
    }
}

fn router(grant: Grant) -> Router {
    Router::new()
        .route("/{id}/{*path}", get(resource))
        .with_state(Arc::new(grant))
}

fn resource_path(grant: &Grant, id: &str, path: &str) -> Result<PathBuf, StatusCode> {
    if id != grant.id || grant.cancelled.is_cancelled() {
        return Err(StatusCode::NOT_FOUND);
    }
    let relative = Path::new(path);
    if path.contains('\\')
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let file = grant
        .root
        .join(relative)
        .canonicalize()
        .map_err(|_| StatusCode::NOT_FOUND)?;
    if !file.starts_with(&grant.root) || !file.is_file() {
        return Err(StatusCode::FORBIDDEN);
    }
    let extension = file
        .extension()
        .and_then(|part| part.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "json"
            | "csv"
            | "txt"
            | "wasm"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "svg"
            | "ico"
            | "avif"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "mp4"
            | "webm"
            | "mov"
            | "mp3"
            | "wav"
            | "m4a"
            | "ogg"
            | "pdf"
    ) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(file)
}

fn policy(grant: &Grant) -> String {
    let sources = format!(
        "{}{}",
        grant.origin,
        if grant.network { " https: http:" } else { "" }
    );
    format!("sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {sources}; style-src 'unsafe-inline' {sources}; img-src data: blob: {sources}; font-src data: {sources}; media-src blob: {sources}; connect-src {sources}; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
}

async fn resource(
    State(grant): State<Arc<Grant>>,
    RoutePath((id, path)): RoutePath<(String, String)>,
    method: Method,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let expected_host = grant
        .origin
        .strip_prefix("http://")
        .ok_or(StatusCode::INTERNAL_SERVER_ERROR)?;
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(expected_host)
    {
        return Err(StatusCode::FORBIDDEN);
    }
    let file = resource_path(&grant, &id, &path)?;
    let mut reader = tokio::fs::File::open(&file)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let size = reader
        .metadata()
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?
        .len();
    let range = match headers.get(header::RANGE) {
        Some(value) => {
            let ranges = value
                .to_str()
                .ok()
                .and_then(|value| http_range::HttpRange::parse(value, size).ok());
            match ranges.as_deref() {
                Some([range]) => Some(*range),
                _ => {
                    return Ok((
                        StatusCode::RANGE_NOT_SATISFIABLE,
                        [(header::CONTENT_RANGE, format!("bytes */{size}"))],
                    )
                        .into_response())
                }
            }
        }
        None => None,
    };
    let length = range.map_or(size, |range| range.length);
    if let Some(range) = range {
        reader
            .seek(std::io::SeekFrom::Start(range.start))
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    }
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        Body::from_stream(
            ReaderStream::new(reader.take(length))
                .take_until(grant.cancelled.clone().cancelled_owned()),
        )
    };
    let mut response = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(&file)
                .first_or_octet_stream()
                .as_ref(),
        )
        .header(header::CONTENT_LENGTH, length)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null")
        .header(header::CONTENT_SECURITY_POLICY, policy(&grant))
        .header("Referrer-Policy", "no-referrer")
        .header("X-Content-Type-Options", "nosniff");
    if let Some(range) = range {
        response = response.header(
            header::CONTENT_RANGE,
            format!(
                "bytes {}-{}/{size}",
                range.start,
                range.start + range.length - 1
            ),
        );
    }
    response
        .body(body)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[cfg(test)]
#[path = "html_preview/tests.rs"]
mod tests;
