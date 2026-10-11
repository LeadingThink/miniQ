use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tauri::{
    webview::{DownloadEvent, NewWindowResponse},
    Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};
use tauri_plugin_opener::OpenerExt;

#[cfg(not(any(target_os = "macos", windows)))]
use tauri::webview::PageLoadEvent;

#[path = "browser_capture.rs"]
mod capture;
pub use capture::capture as screenshot;

#[cfg(target_os = "macos")]
#[path = "browser_dialogs.rs"]
mod dialogs;

#[path = "browser_navigation.rs"]
mod navigation;

const LABEL_PREFIX: &str = "miniq-browser-";

/// One WKWebsiteDataStore shared by every embedded browser view (macOS 14+),
/// so logins survive new tabs and restarts. Wry falls back to the default
/// persistent store on older macOS. Never change it: that logs everyone out.
#[cfg(target_os = "macos")]
const BROWSER_DATA_STORE_ID: [u8; 16] = [
    0x6d, 0x69, 0x6e, 0x69, 0x51, 0x2d, 0x42, 0x72, 0x6f, 0x77, 0x73, 0x65, 0x72, 0x2d, 0x76, 0x31,
];

/// Directory name of the shared browser profile (WebView2 / WebKitGTK data;
/// on macOS it only keeps browser views out of the main window's context).
const BROWSER_PROFILE_DIR: &str = "browser-profile";

/// Schemes handed to the operating system. Anything else that is not web
/// content is blocked: auto-launching arbitrary URL handlers from a page or
/// an iframe without a prompt is unsafe.
const EXTERNAL_SCHEMES: &[&str] = &["mailto", "tel", "sms", "facetime", "facetime-audio"];

const ZOOM_STEPS: [f64; 12] = [
    0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];

const EVENT_PAGE_LOAD: &str = "browser://page-load";
const EVENT_TITLE: &str = "browser://title";
const EVENT_NEW_WINDOW: &str = "browser://new-window";
const EVENT_DOWNLOAD: &str = "browser://download";
const EVENT_EXTERNAL: &str = "browser://external";

fn remember_url(label: &str, url: &tauri::Url) {
    navigation::remember(label, url.as_str());
}

/// WebKit runs the navigation policy on the opener before asking for a new
/// window, so a popup URL is briefly recorded for the opener. Undo that.
fn forget_new_window_url(label: &str, url: &tauri::Url) {
    navigation::forget_popup(label, url.as_str());
}

#[cfg(test)]
fn requested_url(label: &str) -> Option<String> {
    navigation::snapshot(label, None).0
}

fn zoom_levels() -> &'static Mutex<HashMap<String, f64>> {
    static ZOOM: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();
    ZOOM.get_or_init(Default::default)
}

fn current_zoom(label: &str) -> f64 {
    zoom_levels()
        .lock()
        .ok()
        .and_then(|levels| levels.get(label).copied())
        .unwrap_or(1.0)
}

/// Next zoom factor for `zoom_in` / `zoom_out` / `zoom_reset`, snapping an
/// off-grid factor to the neighbouring step.
fn next_zoom(current: f64, action: &str) -> Option<f64> {
    const EPSILON: f64 = 0.001;
    let first = ZOOM_STEPS[0];
    let last = ZOOM_STEPS[ZOOM_STEPS.len() - 1];
    match action {
        "zoom_in" => Some(
            ZOOM_STEPS
                .into_iter()
                .find(|step| *step > current + EPSILON)
                .unwrap_or(last),
        ),
        "zoom_out" => Some(
            ZOOM_STEPS
                .into_iter()
                .rev()
                .find(|step| *step < current - EPSILON)
                .unwrap_or(first),
        ),
        "zoom_reset" => Some(1.0),
        _ => None,
    }
}

#[derive(Debug, PartialEq, Eq)]
enum NavigationKind {
    /// http(s) page; tracked as the view's address.
    Web,
    /// Same-document helpers such as `about:blank` iframes and `blob:` URLs.
    InPage,
    /// Opened by the OS (mail, phone, ...).
    External,
    Blocked,
}

fn classify_navigation(url: &tauri::Url) -> NavigationKind {
    match url.scheme() {
        "http" | "https" if url.username().is_empty() && url.password().is_none() => {
            NavigationKind::Web
        }
        "about" if matches!(url.path(), "blank" | "srcdoc") => NavigationKind::InPage,
        "blob" => NavigationKind::InPage,
        scheme if EXTERNAL_SCHEMES.contains(&scheme) => NavigationKind::External,
        _ => NavigationKind::Blocked,
    }
}

fn view_id_of(label: &str) -> &str {
    label.strip_prefix(LABEL_PREFIX).unwrap_or(label)
}

fn emit_to_main<S: serde::Serialize + Clone>(app: &tauri::AppHandle, event: &str, payload: S) {
    if let Err(error) = app.emit_to("main", event, payload) {
        eprintln!("[miniq] could not emit {event}: {error}");
    }
}

/// Keep event payloads small: `data:` download URLs can be megabytes long.
fn display_url(url: &str) -> String {
    const LIMIT: usize = 2048;
    if url.len() <= LIMIT {
        return url.to_owned();
    }
    let mut end = LIMIT;
    while !url.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &url[..end])
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PageLoadPayload {
    view_id: String,
    url: String,
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<navigation::LoadError>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TitlePayload {
    view_id: String,
    title: String,
}

/// Shared by `browser://new-window` and `browser://external`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UrlPayload {
    view_id: String,
    url: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadPayload {
    view_id: String,
    id: String,
    url: String,
    file_name: String,
    path: String,
    phase: &'static str,
}

/// Hand a non-web link to the OS. Throttled so a page cannot spam the mail
/// or phone app with a navigation loop.
fn open_external(app: &tauri::AppHandle, label: &str, url: &tauri::Url) {
    static LAST_OPEN: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    if let Ok(mut last) = LAST_OPEN.lock() {
        let now = std::time::Instant::now();
        if last.is_some_and(|at| now.duration_since(at) < std::time::Duration::from_secs(1)) {
            return;
        }
        *last = Some(now);
    }
    if let Err(error) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("[miniq] could not open external link: {error}");
        return;
    }
    emit_to_main(
        app,
        EVENT_EXTERNAL,
        UrlPayload {
            view_id: view_id_of(label).to_owned(),
            url: url.to_string(),
        },
    );
}

struct PendingDownload {
    id: String,
    label: String,
    url: String,
    path: PathBuf,
}

fn pending_downloads() -> &'static Mutex<Vec<PendingDownload>> {
    static DOWNLOADS: OnceLock<Mutex<Vec<PendingDownload>>> = OnceLock::new();
    DOWNLOADS.get_or_init(Default::default)
}

/// Reduce a suggested download name to one safe path component.
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let cleaned: String = cleaned.chars().take(200).collect();
    if cleaned.is_empty() {
        "download".to_owned()
    } else {
        cleaned
    }
}

fn file_name_from_url(url: &tauri::Url) -> String {
    let segment = url
        .path_segments()
        .and_then(|mut segments| segments.next_back())
        .filter(|segment| !segment.is_empty())
        .unwrap_or("download");
    let decoded = url::form_urlencoded::parse(format!("x={segment}").as_bytes())
        .next()
        .map(|(_, value)| value.into_owned())
        .unwrap_or_else(|| segment.to_owned());
    sanitize_file_name(&decoded)
}

/// `dir/name`, or `dir/stem (n).ext` for the first free `n`, the way browsers
/// avoid overwriting earlier downloads.
fn unique_download_path(dir: &Path, name: &str, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let candidate = dir.join(name);
    if !taken(&candidate) {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    for counter in 1..10_000 {
        let candidate = dir.join(format!("{stem} ({counter}){extension}"));
        if !taken(&candidate) {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}){extension}", uuid::Uuid::new_v4()))
}

fn download_payload(
    label: &str,
    id: String,
    url: &str,
    path: &Path,
    phase: &'static str,
) -> DownloadPayload {
    DownloadPayload {
        view_id: view_id_of(label).to_owned(),
        id,
        url: display_url(url),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        phase,
    }
}

fn handle_download(webview: &tauri::Webview, event: DownloadEvent<'_>) -> bool {
    let app = webview.app_handle();
    let label = webview.label();
    match event {
        DownloadEvent::Requested { url, destination } => {
            let name = destination
                .file_name()
                .and_then(|name| name.to_str())
                .map(sanitize_file_name)
                .unwrap_or_else(|| file_name_from_url(&url));
            let directory = app
                .path()
                .download_dir()
                .map_err(|error| error.to_string())
                .and_then(|dir| {
                    std::fs::create_dir_all(&dir)
                        .map(|_| dir)
                        .map_err(|error| error.to_string())
                });
            let directory = match directory {
                Ok(directory) => directory,
                Err(error) => {
                    eprintln!("[miniq] download folder unavailable: {error}");
                    let payload = download_payload(
                        label,
                        uuid::Uuid::new_v4().to_string(),
                        url.as_str(),
                        Path::new(&name),
                        "failed",
                    );
                    emit_to_main(app, EVENT_DOWNLOAD, payload);
                    return false;
                }
            };
            let id = uuid::Uuid::new_v4().to_string();
            let path = {
                let Ok(mut pending) = pending_downloads().lock() else {
                    return false;
                };
                let path = unique_download_path(&directory, &name, |candidate| {
                    candidate.exists() || pending.iter().any(|item| item.path == candidate)
                });
                pending.push(PendingDownload {
                    id: id.clone(),
                    label: label.to_owned(),
                    url: url.to_string(),
                    path: path.clone(),
                });
                path
            };
            *destination = path.clone();
            let payload = download_payload(label, id, url.as_str(), &path, "started");
            emit_to_main(app, EVENT_DOWNLOAD, payload);
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let entry = pending_downloads().lock().ok().and_then(|mut pending| {
                let index = pending
                    .iter()
                    .position(|item| item.label == label && item.url == url.as_str())
                    .or_else(|| pending.iter().position(|item| item.url == url.as_str()))?;
                Some(pending.remove(index))
            });
            // macOS never reports the final path; use the one we assigned.
            let (id, saved_path) = match entry {
                Some(entry) => (entry.id, path.unwrap_or(entry.path)),
                None => (uuid::Uuid::new_v4().to_string(), path.unwrap_or_default()),
            };
            let phase = if success { "finished" } else { "failed" };
            let payload = download_payload(label, id, url.as_str(), &saved_path, phase);
            emit_to_main(app, EVENT_DOWNLOAD, payload);
            true
        }
        _ => true,
    }
}

/// Canonical form of `path` if it is an existing entry strictly inside
/// `download_dir` (symlinks resolved, so links cannot escape the folder).
fn validate_download_path(download_dir: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("下载文件路径无效".into());
    }
    let directory = download_dir
        .canonicalize()
        .map_err(|_| "找不到下载文件夹".to_string())?;
    let file = path
        .canonicalize()
        .map_err(|_| "文件不存在或已被移动".to_string())?;
    if file == directory || !file.starts_with(&directory) {
        return Err("只能定位下载文件夹中的文件".into());
    }
    Ok(file)
}

pub fn reveal_download(app: &tauri::AppHandle, path: &str) -> Result<(), String> {
    let download_dir = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?;
    let file = validate_download_path(&download_dir, Path::new(path))?;
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|error| error.to_string())
}

/// Never call `Webview::url()` on macOS: wry unwraps WKWebView's nil URL after
/// a failed load and aborts the whole app. Read the optional URL directly.
#[cfg(target_os = "macos")]
async fn committed_url(webview: &tauri::Webview) -> Result<Option<String>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
            let url = unsafe { view.URL() }
                .and_then(|url| url.absoluteString())
                .map(|value| value.to_string())
                .filter(|value| !value.is_empty());
            let _ = sender.send(url);
        })
        .map_err(|error| error.to_string())?;
    let url = tokio::time::timeout(std::time::Duration::from_secs(5), receiver)
        .await
        .map_err(|_| "读取内置浏览器地址超时".to_string())?
        .map_err(|_| "内置浏览器地址通道已关闭".to_string())?;
    Ok(url)
}

#[cfg(not(target_os = "macos"))]
async fn committed_url(webview: &tauri::Webview) -> Result<Option<String>, String> {
    Ok(webview
        .url()
        .ok()
        .map(|url| url.to_string())
        .filter(|url| !url.is_empty()))
}

async fn browser_state(
    webview: &tauri::Webview,
    label: &str,
    zoom: Option<f64>,
) -> Result<BrowserState, String> {
    let (url, load_error) = navigation::snapshot(label, committed_url(webview).await?);
    Ok(BrowserState {
        url: url.ok_or_else(|| "内置浏览器尚未加载任何页面".to_string())?,
        zoom,
        load_error,
    })
}

/// User-Agent for the embedded browser on WebKit platforms.
///
/// The default WKWebView / WebKitGTK User-Agent has no `Chrome` token. Many
/// Chinese government sites run a check such as
/// `ua.indexOf('chrome') == -1 && !isIE(11)` and then block the page with a
/// forced "upgrade your browser" screen, even on current Safari. Chromium
/// shells (Electron, WebView2) pass this check, so we present a desktop
/// Chrome User-Agent. Windows WebView2 already sends one and keeps its default.
#[cfg(target_os = "macos")]
const EMBEDDED_BROWSER_USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
);
#[cfg(all(unix, not(target_os = "macos")))]
const EMBEDDED_BROWSER_USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
);
#[cfg(not(unix))]
const EMBEDDED_BROWSER_USER_AGENT: Option<&str> = None;

fn browser_label(view_id: &str) -> Result<String, String> {
    if view_id.is_empty()
        || view_id.len() > 64
        || !view_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("invalid browser instance identifier".into());
    }
    Ok(format!("{LABEL_PREFIX}{view_id}"))
}

#[derive(Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    url: String,
    /// Current page zoom factor; reported by `browser_action`.
    #[serde(skip_serializing_if = "Option::is_none")]
    zoom: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    load_error: Option<navigation::LoadError>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCapabilities {
    navigation_control: bool,
    dom_snapshot: bool,
    screenshot: bool,
    tabs: bool,
    pointer_input: bool,
    keyboard_input: bool,
    select_input: bool,
}

pub fn capabilities() -> BrowserCapabilities {
    BrowserCapabilities {
        navigation_control: cfg!(any(windows, target_os = "macos")),
        dom_snapshot: cfg!(any(windows, target_os = "macos")),
        screenshot: cfg!(any(windows, target_os = "macos")),
        tabs: false,
        pointer_input: cfg!(any(windows, target_os = "macos")),
        keyboard_input: cfg!(any(windows, target_os = "macos")),
        select_input: cfg!(any(windows, target_os = "macos")),
    }
}

fn parse_url(value: &str) -> Result<tauri::Url, String> {
    let candidate = value.trim();
    let candidate = if candidate.contains("://") {
        candidate.to_string()
    } else {
        format!("https://{candidate}")
    };
    let url = candidate
        .parse::<tauri::Url>()
        .map_err(|error| format!("网址格式无效: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("内置浏览器只允许不含账号密码的 HTTP(S) 页面".into());
    }
    Ok(url)
}

fn validate_bounds(bounds: BrowserBounds) -> Result<(), String> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .into_iter()
        .all(f64::is_finite)
    {
        return Err("browser bounds must be finite".into());
    }
    if bounds.width < 0.0 || bounds.height < 0.0 {
        return Err("browser dimensions cannot be negative".into());
    }
    Ok(())
}

fn resize(webview: &tauri::Webview, bounds: BrowserBounds) -> Result<(), String> {
    validate_bounds(bounds)?;
    if bounds.width < 1.0 || bounds.height < 1.0 {
        return Ok(());
    }
    let bounds = viewport_bounds(webview.app_handle(), bounds)?;
    webview
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width, bounds.height).into(),
        })
        .map_err(|error| error.to_string())
}

fn viewport_bounds(app: &tauri::AppHandle, bounds: BrowserBounds) -> Result<BrowserBounds, String> {
    #[cfg(target_os = "macos")]
    {
        let main = app
            .get_webview("main")
            .ok_or_else(|| "找不到 miniQ 主页面".to_string())?;
        let scale = main
            .window()
            .scale_factor()
            .map_err(|error| error.to_string())?;
        let origin = main
            .bounds()
            .map_err(|error| error.to_string())?
            .position
            .to_logical::<f64>(scale);
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        main.with_webview(move |platform| {
            let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
            let safe_area = view.safeAreaInsets();
            let _ = sender.send((safe_area.left, safe_area.top));
        })
        .map_err(|error| error.to_string())?;
        // Wry runs with_webview immediately on the main thread and dispatches
        // it there for worker callers, matching its synchronous bounds getter.
        let (left, top) = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .map_err(|_| "无法读取主页面显示区域".to_string())?;
        // DOM client rects start below WKWebView's safe area. Child WebViews
        // use the window content view, including that area. Read the actual
        // insets each time so titlebars/fullscreen changes stay aligned.
        Ok(BrowserBounds {
            x: origin.x + left + bounds.x,
            y: origin.y + top + bounds.y,
            ..bounds
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(bounds)
    }
}

fn initial_size(bounds: BrowserBounds) -> LogicalSize<f64> {
    if bounds.width < 1.0 || bounds.height < 1.0 {
        LogicalSize::new(1280.0, 720.0)
    } else {
        LogicalSize::new(bounds.width, bounds.height)
    }
}

/// WKWebView hands us the JavaScript string itself, while WebView2 returns a
/// JSON-encoded JavaScript result. Keep both adapters on the same two-level
/// protocol so the caller can decode the outer result and then the observation.
#[cfg(target_os = "macos")]
fn encode_webkit_script_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("内嵌浏览器脚本结果编码失败: {error}"))
}

pub fn open(
    app: &tauri::AppHandle,
    view_id: &str,
    value: &str,
    bounds: BrowserBounds,
    visible: bool,
) -> Result<BrowserState, String> {
    validate_bounds(bounds)?;
    let url = parse_url(value)?;
    let label = browser_label(view_id)?;
    if let Some(webview) = app.get_webview(&label) {
        resize(&webview, bounds)?;
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| error.to_string())?;
        navigation::request(&label, url.as_str());
        webview
            .navigate(url.clone())
            .map_err(|error| error.to_string())?;
        return Ok(BrowserState {
            url: url.to_string(),
            zoom: None,
            load_error: navigation::snapshot(&label, None).1,
        });
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "找不到 miniQ 主窗口".to_string())?;
    // One profile for every browser view: logins carry over between tabs
    // and survive restarts.
    let data_directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(BROWSER_PROFILE_DIR);
    std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    navigation::request(&label, url.as_str());
    let navigation_app = app.clone();
    let navigation_label = label.clone();
    let window_app = app.clone();
    let window_label = label.clone();
    // Attach native observers before the first remote request, including very
    // fast local connection failures. A blank view never loads the app shell.
    #[cfg(any(target_os = "macos", windows))]
    let initial_url = "about:blank".parse().unwrap();
    #[cfg(not(any(target_os = "macos", windows)))]
    let initial_url = url.clone();
    let mut builder = WebviewBuilder::new(&label, WebviewUrl::External(initial_url));
    if let Some(user_agent) = EMBEDDED_BROWSER_USER_AGENT {
        builder = builder.user_agent(user_agent);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(BROWSER_DATA_STORE_ID);
    }
    let builder = builder
        .initialization_script(include_str!("browser_links.js"))
        .data_directory(data_directory)
        .incognito(false)
        .devtools(true)
        .on_navigation(move |target| match classify_navigation(target) {
            NavigationKind::Web => {
                remember_url(&navigation_label, target);
                true
            }
            NavigationKind::InPage => true,
            NavigationKind::External => {
                open_external(&navigation_app, &navigation_label, target);
                false
            }
            NavigationKind::Blocked => false,
        })
        .on_new_window(move |target, _| {
            forget_new_window_url(&window_label, &target);
            match classify_navigation(&target) {
                NavigationKind::Web => emit_to_main(
                    &window_app,
                    EVENT_NEW_WINDOW,
                    UrlPayload {
                        view_id: view_id_of(&window_label).to_owned(),
                        url: target.to_string(),
                    },
                ),
                NavigationKind::External => open_external(&window_app, &window_label, &target),
                NavigationKind::InPage | NavigationKind::Blocked => {}
            }
            NewWindowResponse::Deny
        })
        .on_page_load(|_webview, _payload| {
            // Native delegates own this lifecycle on macOS/Windows. Wry's
            // WebView2 Finished also runs on unsuccessful completions.
            #[cfg(not(any(target_os = "macos", windows)))]
            {
                let webview = _webview;
                let payload = _payload;
                let phase = match payload.event() {
                    PageLoadEvent::Started => "started",
                    PageLoadEvent::Finished => "finished",
                };
                navigation::page_load(
                    webview.app_handle(),
                    webview.label(),
                    0,
                    phase,
                    None,
                    Some(payload.url().to_string()),
                );
            }
        })
        .on_document_title_changed(|webview, title| {
            emit_to_main(
                webview.app_handle(),
                EVENT_TITLE,
                TitlePayload {
                    view_id: view_id_of(webview.label()).to_owned(),
                    title,
                },
            );
        })
        .on_download(|webview, event| handle_download(&webview, event));
    let native_bounds = viewport_bounds(app, bounds)?;
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(native_bounds.x, native_bounds.y),
            initial_size(bounds),
        )
        .map_err(|error| error.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        let label = label.clone();
        webview
            .with_webview(move |platform| {
                let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
                dialogs::install(view);
                if let Err(error) = navigation::install(view, app, label) {
                    eprintln!("[miniq] could not observe browser navigation: {error}");
                }
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(windows)]
    {
        let app = app.clone();
        let label = label.clone();
        webview
            .with_webview(move |platform| {
                if let Err(error) = navigation::install(&platform.controller(), app, label) {
                    eprintln!("[miniq] could not observe browser navigation: {error}");
                }
            })
            .map_err(|error| error.to_string())?;
    }
    #[cfg(any(target_os = "macos", windows))]
    webview
        .navigate(url.clone())
        .map_err(|error| error.to_string())?;
    if !visible {
        webview.hide().map_err(|error| error.to_string())?;
    }
    Ok(BrowserState {
        url: url.to_string(),
        zoom: None,
        load_error: navigation::snapshot(&label, None).1,
    })
}

fn print(webview: &tauri::Webview) -> tauri::Result<()> {
    #[cfg(target_os = "macos")]
    {
        webview.print()
    }
    // Tauri's native print is macOS-only; the page API works elsewhere.
    #[cfg(not(target_os = "macos"))]
    {
        webview.eval("window.print()")
    }
}

pub fn resize_current(
    app: &tauri::AppHandle,
    view_id: &str,
    bounds: BrowserBounds,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(view_id)?) {
        resize(&webview, bounds)?;
    }
    Ok(())
}

pub async fn action(
    app: &tauri::AppHandle,
    view_id: &str,
    action: &str,
) -> Result<BrowserState, String> {
    let label = browser_label(view_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    match action {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => {
            if let Some(url) = navigation::snapshot(&label, None).0 {
                navigation::request(&label, &url);
            }
            webview.reload()
        }
        "stop" => webview.eval("window.stop()"),
        "zoom_in" | "zoom_out" | "zoom_reset" => {
            let zoom = next_zoom(current_zoom(&label), action).unwrap_or(1.0);
            webview.set_zoom(zoom).inspect(|_| {
                if let Ok(mut levels) = zoom_levels().lock() {
                    levels.insert(label.clone(), zoom);
                }
            })
        }
        "print" => print(&webview),
        "devtools" => {
            webview.open_devtools();
            Ok(())
        }
        // Every browser view shares one profile, so this clears all of them.
        "clear_data" => webview.clear_all_browsing_data(),
        _ => return Err(format!("未知浏览器操作: {action}")),
    }
    .map_err(|error| error.to_string())?;
    browser_state(&webview, &label, Some(current_zoom(&label))).await
}

pub async fn current(app: &tauri::AppHandle, view_id: &str) -> Result<BrowserState, String> {
    let label = browser_label(view_id)?;
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    browser_state(&webview, &label, None).await
}

pub fn close(app: &tauri::AppHandle, view_id: &str) -> Result<(), String> {
    let label = browser_label(view_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|error| error.to_string())?;
    }
    navigation::remove(&label);
    if let Ok(mut levels) = zoom_levels().lock() {
        levels.remove(&label);
    }
    Ok(())
}

pub fn set_visible(app: &tauri::AppHandle, view_id: &str, visible: bool) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(view_id)?) {
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(windows)]
pub async fn evaluate(
    app: &tauri::AppHandle,
    view_id: &str,
    script: String,
) -> Result<String, String> {
    use webview2_com::ExecuteScriptCompletedHandler;
    use windows::core::HSTRING;

    let webview = app
        .get_webview(&browser_label(view_id)?)
        .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform| {
            let callback_sender = sender.clone();
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|webview| {
                    let handler =
                        ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
                            if let Some(sender) = callback_sender
                                .lock()
                                .ok()
                                .and_then(|mut value| value.take())
                            {
                                let _ = sender.send(
                                    status.map(|_| result).map_err(|error| error.to_string()),
                                );
                            }
                            Ok(())
                        }));
                    webview.ExecuteScript(&HSTRING::from(script), &handler)
                })
            };
            if let Err(error) = result {
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "内嵌浏览器脚本执行超时".to_string())?
        .map_err(|_| "内嵌浏览器脚本执行通道已关闭".to_string())?
}

#[cfg(not(windows))]
pub async fn evaluate(
    app: &tauri::AppHandle,
    view_id: &str,
    script: String,
) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2::runtime::AnyObject;
        use objc2_foundation::{NSError, NSString};

        let webview = app
            .get_webview(&browser_label(view_id)?)
            .ok_or_else(|| "内置浏览器尚未打开".to_string())?;
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
        webview
            .with_webview(move |platform| {
                let callback_sender = sender.clone();
                let completion =
                    RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                        let outcome = if !error.is_null() {
                            // WKWebView reports JavaScript exceptions and
                            // navigation failures through NSError.  Preserve
                            // the localized message so the caller can decide
                            // whether to retry or refresh the observation.
                            Err(unsafe { (&*error).to_string() })
                        } else if result.is_null() {
                            // `undefined` is represented by nil by WebKit. The
                            // automation contract requires a JSON string, so
                            // surface this as a recoverable driver error rather
                            // than handing the parser a misleading null value.
                            Err("内嵌浏览器脚本未返回字符串结果".to_string())
                        } else {
                            // browserAutomationScript deliberately returns
                            // JSON.stringify(...), so the WebKit result is an
                            // NSString. Validate the runtime class before
                            // downcasting; NSObject::description would change
                            // escaped JSON and break the observation parser.
                            let object = unsafe { &*result };
                            object
                                .downcast_ref::<NSString>()
                                .ok_or_else(|| "内嵌浏览器返回了非字符串脚本结果".to_string())
                                .and_then(|value| encode_webkit_script_string(&value.to_string()))
                        };
                        if let Some(sender) = callback_sender
                            .lock()
                            .ok()
                            .and_then(|mut value| value.take())
                        {
                            let _ = sender.send(outcome);
                        }
                    });
                // `inner` is owned by Tauri/Wry; this borrowed view remains
                // valid for the duration of the main-thread callback.
                let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
                let java_script = NSString::from_str(&script);
                unsafe {
                    view.evaluateJavaScript_completionHandler(&java_script, Some(&completion));
                }
            })
            .map_err(|error| error.to_string())?;
        return tokio::time::timeout(std::time::Duration::from_secs(15), receiver)
            .await
            .map_err(|_| "内嵌浏览器脚本执行超时".to_string())?
            .map_err(|_| "内嵌浏览器脚本执行通道已关闭".to_string())?;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, view_id, script);
        Err("此平台尚不支持内嵌浏览器 DOM 自动化".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn webkit_user_agent_passes_chrome_only_browser_checks() {
        let user_agent = EMBEDDED_BROWSER_USER_AGENT
            .expect("WebKit platforms set a User-Agent")
            .to_lowercase();
        assert!(user_agent.contains("chrome/"));
        for mobile_token in ["ipad", "iphone os", "android", "mobile", "msie", "trident/"] {
            assert!(
                !user_agent.contains(mobile_token),
                "unexpected token {mobile_token}"
            );
        }
    }

    #[test]
    fn zoom_steps_through_the_fixed_scale() {
        assert_eq!(next_zoom(1.0, "zoom_in"), Some(1.1));
        assert_eq!(next_zoom(1.0, "zoom_out"), Some(0.9));
        assert_eq!(next_zoom(0.67, "zoom_out"), Some(0.5));
        assert_eq!(next_zoom(3.0, "zoom_in"), Some(3.0));
        assert_eq!(next_zoom(0.5, "zoom_out"), Some(0.5));
        assert_eq!(next_zoom(2.2, "zoom_reset"), Some(1.0));
        // Off-grid factors snap to the neighbouring step.
        assert_eq!(next_zoom(1.3, "zoom_in"), Some(1.5));
        assert_eq!(next_zoom(1.3, "zoom_out"), Some(1.25));
        assert_eq!(next_zoom(1.0, "reload"), None);
    }

    #[test]
    fn classifies_navigation_schemes() {
        let kind = |value: &str| classify_navigation(&value.parse().unwrap());
        assert_eq!(kind("https://example.com/"), NavigationKind::Web);
        assert_eq!(kind("http://127.0.0.1:3000/"), NavigationKind::Web);
        assert_eq!(kind("mailto:someone@example.com"), NavigationKind::External);
        assert_eq!(kind("tel:+8610000000"), NavigationKind::External);
        assert_eq!(kind("about:blank"), NavigationKind::InPage);
        assert_eq!(
            kind("blob:https://example.com/1234"),
            NavigationKind::InPage
        );
        for blocked in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "https://user:pw@example.com/",
            "https://user@example.com/",
            "about:config",
            "ms-msdt:/id",
            "x-apple.systempreferences:com.apple.preference",
        ] {
            assert_eq!(kind(blocked), NavigationKind::Blocked, "{blocked}");
        }
    }

    #[test]
    fn requested_url_ignores_popup_urls_recorded_on_the_opener() {
        let label = "miniq-browser-popup-test";
        remember_url(label, &"https://a.example/".parse().unwrap());
        let popup: tauri::Url = "https://b.example/".parse().unwrap();
        remember_url(label, &popup);
        forget_new_window_url(label, &popup);
        assert_eq!(requested_url(label).as_deref(), Some("https://a.example/"));
    }

    #[test]
    fn download_names_never_overwrite_existing_files() {
        let dir = Path::new("/downloads");
        let taken = |existing: &'static [&'static str]| {
            move |path: &Path| existing.iter().any(|name| dir.join(name) == path)
        };
        assert_eq!(
            unique_download_path(dir, "report.pdf", taken(&[])),
            dir.join("report.pdf")
        );
        assert_eq!(
            unique_download_path(dir, "report.pdf", taken(&["report.pdf", "report (1).pdf"])),
            dir.join("report (2).pdf")
        );
        assert_eq!(
            unique_download_path(dir, "README", taken(&["README"])),
            dir.join("README (1)")
        );
        assert_eq!(
            unique_download_path(dir, "a.tar.gz", taken(&["a.tar.gz"])),
            dir.join("a.tar (1).gz")
        );
    }

    #[test]
    fn download_names_are_single_safe_components() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_file_name("a\\b:c.txt"), "a_b_c.txt");
        assert_eq!(sanitize_file_name("  "), "download");
        assert_eq!(sanitize_file_name(".."), "download");
        assert_eq!(sanitize_file_name("报告.pdf"), "报告.pdf");
        let url: tauri::Url = "https://example.com/files/%E6%8A%A5%E5%91%8A.pdf?x=1"
            .parse()
            .unwrap();
        assert_eq!(file_name_from_url(&url), "报告.pdf");
        let root: tauri::Url = "https://example.com/".parse().unwrap();
        assert_eq!(file_name_from_url(&root), "download");
    }

    #[test]
    fn reveal_only_accepts_files_inside_the_download_folder() {
        let root = tempfile::tempdir().unwrap();
        let downloads = root.path().join("Downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let inside = downloads.join("a.txt");
        std::fs::write(&inside, b"x").unwrap();
        let outside = root.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();

        assert!(validate_download_path(&downloads, &inside).is_ok());
        assert!(validate_download_path(&downloads, &outside).is_err());
        assert!(validate_download_path(&downloads, &downloads).is_err());
        assert!(validate_download_path(&downloads, &downloads.join("../secret.txt")).is_err());
        assert!(validate_download_path(&downloads, &downloads.join("missing.txt")).is_err());
        assert!(validate_download_path(&downloads, Path::new("a.txt")).is_err());
        #[cfg(unix)]
        {
            let link = downloads.join("link.txt");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(validate_download_path(&downloads, &link).is_err());
        }
    }

    #[test]
    fn browser_state_reports_zoom_only_when_known() {
        let plain = serde_json::to_value(BrowserState {
            url: "https://example.com/".into(),
            zoom: None,
            load_error: None,
        })
        .unwrap();
        assert!(plain.get("zoom").is_none());
        let zoomed = serde_json::to_value(BrowserState {
            url: "https://example.com/".into(),
            zoom: Some(1.25),
            load_error: None,
        })
        .unwrap();
        assert_eq!(zoomed["zoom"], 1.25);
    }

    #[test]
    fn failure_event_and_polling_state_share_the_error_contract() {
        let error = navigation::LoadError {
            code: "ERR_CONNECTION_REFUSED".into(),
            message: "目标服务器拒绝连接（NSURLErrorDomain -1004）".into(),
        };
        let event = serde_json::to_value(PageLoadPayload {
            view_id: "tab-1".into(),
            url: "http://127.0.0.1:1431/task-overview-preview.html".into(),
            phase: "failed",
            error: Some(error.clone()),
        })
        .unwrap();
        let state = serde_json::to_value(BrowserState {
            url: event["url"].as_str().unwrap().into(),
            zoom: None,
            load_error: Some(error),
        })
        .unwrap();
        assert_eq!(event["phase"], "failed");
        assert_eq!(event["error"]["code"], "ERR_CONNECTION_REFUSED");
        assert_eq!(event["error"], state["loadError"]);
        let success = serde_json::to_value(PageLoadPayload {
            view_id: "tab-1".into(),
            url: "https://success.example/".into(),
            phase: "finished",
            error: None,
        })
        .unwrap();
        assert!(success.get("error").is_none());
    }

    #[test]
    fn download_event_payload_uses_camel_case() {
        let payload = download_payload(
            "miniq-browser-tab-1",
            "id-1".into(),
            "https://example.com/a.pdf",
            Path::new("/downloads/a.pdf"),
            "started",
        );
        let value = serde_json::to_value(payload).unwrap();
        assert_eq!(value["viewId"], "tab-1");
        assert_eq!(value["fileName"], "a.pdf");
        assert_eq!(value["phase"], "started");
        assert_eq!(display_url(&"a".repeat(5000)).chars().count(), 2049);
    }

    #[test]
    fn rejects_nonfinite_or_negative_initial_bounds() {
        for width in [f64::NAN, f64::INFINITY, -1.0] {
            assert!(validate_bounds(BrowserBounds {
                x: 0.0,
                y: 0.0,
                width,
                height: 100.0
            })
            .is_err());
        }
    }

    #[test]
    fn hidden_browser_uses_an_automation_ready_initial_viewport() {
        let size = initial_size(BrowserBounds {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        });
        assert_eq!(size.width, 1280.0);
        assert_eq!(size.height, 720.0);

        let visible = initial_size(BrowserBounds {
            x: 10.0,
            y: 20.0,
            width: 900.0,
            height: 600.0,
        });
        assert_eq!(visible.width, 900.0);
        assert_eq!(visible.height, 600.0);
    }

    #[test]
    fn accepts_only_http_urls() {
        assert_eq!(parse_url("example.com").unwrap().scheme(), "https");
        assert!(parse_url("http://127.0.0.1:3000").is_ok());
        assert!(parse_url("file:///etc/passwd").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("https://user:password@example.com").is_err());
        assert!(parse_url("https://user@example.com").is_err());
        assert_eq!(
            parse_url("localhost:3000").unwrap().as_str(),
            "https://localhost:3000/"
        );
        assert!(parse_url("http://[::1]:3000").is_ok());
    }

    #[test]
    fn browser_instance_labels_cannot_address_the_main_webview() {
        assert_ne!(browser_label("main").unwrap(), "main");
        assert_ne!(
            browser_label("session-a").unwrap(),
            browser_label("session-b").unwrap()
        );
        for invalid in ["", "../main", "a:b", "a/b"] {
            assert!(browser_label(invalid).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn webkit_script_result_preserves_unicode_and_quotes_in_outer_protocol() {
        let inner = r#"{"title":"联想之星创业 \"问卷\"","line":"第一行\n第二行"}"#;
        let encoded = encode_webkit_script_string(inner).unwrap();
        let decoded_outer: String = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded_outer, inner);
        let value: serde_json::Value = serde_json::from_str(&decoded_outer).unwrap();
        assert_eq!(value["title"], "联想之星创业 \"问卷\"");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_browser_advertises_dom_and_native_screenshot_support() {
        let flags = capabilities();
        assert!(flags.navigation_control);
        assert!(flags.dom_snapshot);
        assert!(flags.pointer_input);
        assert!(flags.keyboard_input);
        assert!(flags.select_input);
        assert!(flags.screenshot);
    }
}
