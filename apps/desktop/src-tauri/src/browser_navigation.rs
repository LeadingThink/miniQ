//! Navigation lifecycle and native failure reporting for embedded browsers.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub(super) struct LoadError {
    pub code: String,
    pub message: String,
}

#[derive(Default)]
struct NavigationState {
    requested: String,
    previous: Option<String>,
    active: Option<u64>,
    active_url: Option<String>,
    pending: bool,
    error: Option<LoadError>,
}

impl NavigationState {
    fn request(&mut self, url: &str) {
        self.remember(url);
        self.active = None;
        self.error = None;
        self.pending = true;
    }

    fn remember(&mut self, url: &str) {
        if self.requested != url {
            self.previous = Some(std::mem::replace(&mut self.requested, url.to_owned()));
        }
    }

    fn started(&mut self, id: u64) {
        self.active = Some(id);
        self.active_url = Some(self.requested.clone());
        self.error = None;
        self.pending = true;
    }

    fn failed(&mut self, id: u64, error: LoadError, url: Option<&str>) -> bool {
        if url
            .or(self.active_url.as_deref())
            .is_some_and(|url| url != self.requested)
        {
            return false;
        }
        if !self.finished(id) {
            return false;
        }
        self.error = Some(error);
        true
    }

    fn finished(&mut self, id: u64) -> bool {
        if self.active != Some(id) {
            return false;
        }
        self.active = None;
        self.error = None;
        self.pending = false;
        true
    }

    fn reported_url(&self, committed: Option<String>) -> Option<String> {
        let requested = Some(self.requested.clone()).filter(|url| !url.is_empty());
        if self.error.is_some() || self.pending {
            requested.or(committed)
        } else {
            committed.or(requested)
        }
    }
}

fn states() -> &'static Mutex<HashMap<String, NavigationState>> {
    static STATES: OnceLock<Mutex<HashMap<String, NavigationState>>> = OnceLock::new();
    STATES.get_or_init(Default::default)
}

pub(super) fn request(label: &str, url: &str) {
    if let Ok(mut states) = states().lock() {
        states.entry(label.into()).or_default().request(url);
    }
}

pub(super) fn remember(label: &str, url: &str) {
    if let Ok(mut states) = states().lock() {
        states.entry(label.into()).or_default().remember(url);
    }
}

pub(super) fn forget_popup(label: &str, url: &str) {
    if let Ok(mut states) = states().lock() {
        if let Some(state) = states.get_mut(label) {
            if state.requested == url {
                if let Some(previous) = state.previous.take() {
                    state.requested = previous;
                }
            }
        }
    }
}

pub(super) fn snapshot(
    label: &str,
    committed: Option<String>,
) -> (Option<String>, Option<LoadError>) {
    states()
        .lock()
        .ok()
        .and_then(|states| {
            states
                .get(label)
                .map(|state| (state.reported_url(committed.clone()), state.error.clone()))
        })
        .unwrap_or((committed, None))
}

pub(super) fn remove(label: &str) {
    if let Ok(mut states) = states().lock() {
        states.remove(label);
    }
    #[cfg(target_os = "macos")]
    macos::remove(label);
}

pub(super) fn page_load(
    app: &tauri::AppHandle,
    label: &str,
    id: u64,
    phase: &'static str,
    error: Option<LoadError>,
    url: Option<String>,
) {
    let payload = states().lock().ok().and_then(|mut states| {
        let state = states.get_mut(label)?;
        let accepted = match phase {
            "started" => {
                state.started(id);
                true
            }
            "failed" => state.failed(id, error.clone()?, url.as_deref()),
            _ => state.finished(id),
        };
        if !accepted {
            return None;
        }
        if phase == "finished" {
            if let Some(url) = url {
                state.remember(&url);
            }
        }
        Some(super::PageLoadPayload {
            view_id: super::view_id_of(label).into(),
            url: state.requested.clone(),
            phase,
            error,
        })
    });
    if let Some(payload) = payload {
        super::emit_to_main(app, super::EVENT_PAGE_LOAD, payload);
    }
}

fn cancel(label: &str, id: u64) {
    if let Ok(mut states) = states().lock() {
        if let Some(state) = states.get_mut(label) {
            state.finished(id);
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn webkit_error(domain: &str, code: isize, description: &str) -> Option<LoadError> {
    let (name, message) = if domain == "NSURLErrorDomain" {
        match code {
            -999 => return None,
            -1004 => ("ERR_CONNECTION_REFUSED", "目标服务器拒绝连接"),
            -1001 => ("ERR_TIMED_OUT", "连接目标服务器超时"),
            -1003 => ("ERR_NAME_NOT_RESOLVED", "无法解析目标服务器的域名"),
            -1009 => ("ERR_INTERNET_DISCONNECTED", "网络连接已断开"),
            -1005 => ("ERR_CONNECTION_CLOSED", "网络连接在加载期间中断"),
            -1006 => ("ERR_NAME_NOT_RESOLVED", "DNS 查询失败"),
            -1022 => (
                "ERR_ATS_REQUIRES_SECURE_CONNECTION",
                "系统安全策略要求使用安全连接",
            ),
            -1200 => ("ERR_SSL_PROTOCOL_ERROR", "无法建立安全连接"),
            -1206..=-1201 => ("ERR_CERTIFICATE", "服务器证书验证失败"),
            _ => ("", description),
        }
    } else {
        ("", description)
    };
    Some(LoadError {
        code: if name.is_empty() {
            format!("{domain}:{code}")
        } else {
            name.into()
        },
        message: format!("{message}（{domain} {code}）"),
    })
}

#[cfg(target_os = "macos")]
fn failing_url(error: &objc2_foundation::NSError) -> Option<String> {
    use objc2_foundation::{NSString, NSURL};

    let info = error.userInfo();
    // Foundation uses these keys for NSURL and its string representation.
    let value = info
        .objectForKey(&NSString::from_str("NSErrorFailingURLKey"))
        .or_else(|| info.objectForKey(&NSString::from_str("NSErrorFailingURLStringKey")))?;
    let url = if let Some(url) = value.downcast_ref::<NSURL>() {
        url.absoluteString()?.to_string()
    } else {
        value.downcast_ref::<NSString>()?.to_string()
    };
    Some(
        tauri::Url::parse(&url)
            .map(|url| url.to_string())
            .unwrap_or(url),
    )
}

#[cfg(target_os = "macos")]
pub(super) use macos::install;

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
        sel,
    };
    use objc2_foundation::{NSError, NSString, NSURL};
    use objc2_web_kit::{WKNavigation, WKWebView};

    struct Classes {
        base: &'static AnyClass,
        subclass: &'static AnyClass,
    }
    static CLASSES: OnceLock<Option<Classes>> = OnceLock::new();

    #[derive(Clone)]
    struct Context {
        app: tauri::AppHandle,
        label: String,
    }

    fn contexts() -> &'static Mutex<HashMap<usize, Context>> {
        static CONTEXTS: OnceLock<Mutex<HashMap<usize, Context>>> = OnceLock::new();
        CONTEXTS.get_or_init(Default::default)
    }

    pub(super) fn remove(label: &str) {
        if let Ok(mut contexts) = contexts().lock() {
            contexts.retain(|_, context| context.label != label);
        }
    }

    fn context(view: &WKWebView) -> Option<Context> {
        contexts()
            .lock()
            .ok()?
            .get(&(view as *const WKWebView as usize))
            .cloned()
    }

    fn build(base: &'static AnyClass) -> Option<Classes> {
        let mut builder = ClassBuilder::new(c"MiniQBrowserNavigationDelegate", base)?;
        // SAFETY: exactly the WKNavigationDelegate ABI; no ivars are added.
        unsafe {
            builder.add_method(
                sel!(webView:didStartProvisionalNavigation:),
                started as unsafe extern "C-unwind" fn(_, _, _, _),
            );
            builder.add_method(
                sel!(webView:didFinishNavigation:),
                finished as unsafe extern "C-unwind" fn(_, _, _, _),
            );
            builder.add_method(
                sel!(webView:didFailProvisionalNavigation:withError:),
                failed as unsafe extern "C-unwind" fn(_, _, _, _, _),
            );
            builder.add_method(
                sel!(webView:didFailNavigation:withError:),
                failed as unsafe extern "C-unwind" fn(_, _, _, _, _),
            );
        }
        Some(Classes {
            base,
            subclass: builder.register(),
        })
    }

    pub(in super::super) fn install(
        view: &WKWebView,
        app: tauri::AppHandle,
        label: String,
    ) -> Result<(), String> {
        let delegate = unsafe { view.navigationDelegate() }.ok_or("浏览器导航 delegate 不存在")?;
        // SAFETY: protocol objects are Objective-C objects; the subclass has the same instance layout.
        let object: &AnyObject = unsafe { &*(Retained::as_ptr(&delegate) as *const AnyObject) };
        let classes = CLASSES
            .get_or_init(|| build(object.class()))
            .as_ref()
            .ok_or("无法注册浏览器导航 delegate")?;
        if !std::ptr::eq(object.class(), classes.base)
            && !std::ptr::eq(object.class(), classes.subclass)
        {
            return Err("浏览器导航 delegate 类型不匹配".into());
        }
        contexts()
            .lock()
            .map_err(|error| error.to_string())?
            .insert(view as *const WKWebView as usize, Context { app, label });
        unsafe {
            AnyObject::set_class(object, classes.subclass);
            // Refresh WebKit's cached optional selector availability.
            view.setNavigationDelegate(None);
            view.setNavigationDelegate(Some(&delegate));
        }
        Ok(())
    }

    unsafe fn forward(
        this: &AnyObject,
        cmd: Sel,
        view: &WKWebView,
        navigation: Option<&WKNavigation>,
    ) {
        if let Some(classes) = CLASSES.get().and_then(Option::as_ref) {
            if classes.base.instance_method(cmd).is_some() {
                // SAFETY: the selector is one of the two navigation-only methods above.
                if cmd == sel!(webView:didStartProvisionalNavigation:) {
                    let _: () = msg_send![super(this, classes.base), webView: view, didStartProvisionalNavigation: navigation];
                } else {
                    let _: () = msg_send![super(this, classes.base), webView: view, didFinishNavigation: navigation];
                }
            }
        }
    }

    unsafe extern "C-unwind" fn started(
        this: &AnyObject,
        cmd: Sel,
        view: &WKWebView,
        navigation: Option<&WKNavigation>,
    ) {
        if let (Some(context), Some(navigation)) = (context(view), navigation) {
            page_load(
                &context.app,
                &context.label,
                navigation as *const WKNavigation as u64,
                "started",
                None,
                None,
            );
        }
        forward(this, cmd, view, navigation);
    }

    unsafe extern "C-unwind" fn finished(
        this: &AnyObject,
        cmd: Sel,
        view: &WKWebView,
        navigation: Option<&WKNavigation>,
    ) {
        if let (Some(context), Some(navigation)) = (context(view), navigation) {
            let url = view
                .URL()
                .and_then(|url| url.absoluteString())
                .map(|url| url.to_string());
            if url.as_deref() != Some("about:blank") {
                page_load(
                    &context.app,
                    &context.label,
                    navigation as *const WKNavigation as u64,
                    "finished",
                    None,
                    url,
                );
            }
        }
        forward(this, cmd, view, navigation);
    }

    #[test]
    fn extracts_actual_nserror_failing_url_without_a_committed_page() {
        use objc2_foundation::NSDictionary;
        let domain = NSString::from_str("NSURLErrorDomain");
        let target = NSString::from_str("http://127.0.0.1:1431/task-overview-preview.html");
        let url = NSURL::URLWithString(&target).unwrap();
        let key = NSString::from_str("NSErrorFailingURLKey");
        let info = NSDictionary::from_slices(&[&*key], &[&*url as &AnyObject]);
        let error = unsafe { NSError::errorWithDomain_code_userInfo(&domain, -1004, Some(&info)) };
        assert_eq!(
            super::failing_url(&error).as_deref(),
            Some(target.to_string().as_str())
        );
        assert_eq!(
            webkit_error(
                &error.domain().to_string(),
                error.code(),
                &error.localizedDescription().to_string()
            )
            .unwrap()
            .code,
            "ERR_CONNECTION_REFUSED"
        );
    }

    unsafe extern "C-unwind" fn failed(
        this: &AnyObject,
        cmd: Sel,
        view: &WKWebView,
        navigation: Option<&WKNavigation>,
        error: &NSError,
    ) {
        if let (Some(context), Some(navigation)) = (context(view), navigation) {
            let id = navigation as *const WKNavigation as u64;
            let url = super::failing_url(error);
            if let Some(error) = webkit_error(
                &error.domain().to_string(),
                error.code(),
                &error.localizedDescription().to_string(),
            ) {
                page_load(&context.app, &context.label, id, "failed", Some(error), url);
            } else {
                cancel(&context.label, id);
            }
        }
        if let Some(classes) = CLASSES.get().and_then(Option::as_ref) {
            if classes.base.instance_method(cmd).is_some() {
                // SAFETY: preserve the matching optional superclass failure callback.
                if cmd == sel!(webView:didFailProvisionalNavigation:withError:) {
                    let _: () = msg_send![super(this, classes.base), webView: view, didFailProvisionalNavigation: navigation, withError: error];
                } else {
                    let _: () = msg_send![super(this, classes.base), webView: view, didFailNavigation: navigation, withError: error];
                }
            }
        }
    }
}

// WebView2's public enum values allow mapping tests on every platform.
#[cfg(any(windows, test))]
fn webview2_error(code: i32) -> Option<LoadError> {
    let (name, message) = match code {
        14 => return None, // OPERATION_CANCELED
        13 => ("ERR_NAME_NOT_RESOLVED", "无法解析目标服务器的域名"),
        9 => ("ERR_CONNECTION_ABORTED", "网络连接在加载期间中止"),
        10 => ("ERR_CONNECTION_RESET", "目标服务器重置了连接"),
        11 => ("ERR_INTERNET_DISCONNECTED", "网络连接已断开"),
        12 => ("ERR_CONNECTION_FAILED", "无法连接到目标服务器"),
        7 => ("ERR_TIMED_OUT", "连接目标服务器超时"),
        1..=5 => ("ERR_CERTIFICATE", "安全连接的证书验证失败"),
        _ => ("", "网页导航失败"),
    };
    Some(LoadError {
        code: if name.is_empty() {
            format!("WEBVIEW2_WEB_ERROR_STATUS:{code}")
        } else {
            name.into()
        },
        message: format!("{message}（WebView2 WebErrorStatus {code}）"),
    })
}

#[cfg(windows)]
pub(super) fn install(
    controller: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    app: tauri::AppHandle,
    label: String,
) -> windows::core::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS;
    use webview2_com::{NavigationCompletedEventHandler, NavigationStartingEventHandler};
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;

    // Add handlers without replacing Wry's handlers.
    unsafe {
        let view = controller.CoreWebView2()?;
        let start_app = app.clone();
        let start_label = label.clone();
        let mut token = 0;
        view.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut cancelled = BOOL::default();
                    args.Cancel(&mut cancelled)?;
                    if cancelled != 0 {
                        return Ok(());
                    }
                    let mut id = 0;
                    let mut uri = PWSTR::null();
                    args.NavigationId(&mut id)?;
                    args.Uri(&mut uri)?;
                    let url = uri.to_string();
                    CoTaskMemFree(Some(uri.0.cast()));
                    let url = url?;
                    if url == "about:blank" {
                        return Ok(());
                    }
                    remember(&start_label, &url);
                    page_load(&start_app, &start_label, id, "started", None, None);
                }
                Ok(())
            })),
            &mut token,
        )?;
        view.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut id = 0;
                    let mut success = BOOL::default();
                    args.NavigationId(&mut id)?;
                    args.IsSuccess(&mut success)?;
                    if success != 0 {
                        page_load(&app, &label, id, "finished", None, None);
                    } else {
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                        args.WebErrorStatus(&mut status)?;
                        if let Some(error) = webview2_error(status.0) {
                            page_load(&app, &label, id, "failed", Some(error), None);
                        } else {
                            cancel(&label, id);
                        }
                    }
                }
                Ok(())
            })),
            &mut token,
        )?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAILED: &str = "http://127.0.0.1:1431/task-overview-preview.html";

    fn refused() -> LoadError {
        LoadError {
            code: "ERR_CONNECTION_REFUSED".into(),
            message: "目标服务器拒绝连接（NSURLErrorDomain -1004）".into(),
        }
    }

    #[test]
    fn failed_navigation_preserves_target_and_error_for_polling() {
        let mut state = NavigationState::default();
        state.request(FAILED);
        state.started(1);
        assert!(state.failed(1, refused(), None));
        assert_eq!(state.error, Some(refused()));
        assert_eq!(
            state
                .reported_url(Some("https://old.example/".into()))
                .as_deref(),
            Some(FAILED)
        );
    }

    #[test]
    fn new_request_rejects_old_failure_even_before_started_and_at_same_url() {
        let mut state = NavigationState::default();
        state.request(FAILED);
        state.started(1);
        state.request(FAILED);
        assert!(!state.failed(1, refused(), None));
        assert!(!state.finished(1));
        state.started(2);
        assert!(!state.failed(1, refused(), None));
        assert!(state.failed(2, refused(), None));
    }

    #[test]
    fn started_and_success_clear_failure_and_duplicate_terminals_are_ignored() {
        let mut state = NavigationState::default();
        state.request(FAILED);
        state.started(1);
        assert!(state.failed(1, refused(), None));
        assert!(!state.failed(1, refused(), None));
        assert!(!state.finished(1));
        state.started(2);
        assert!(state.error.is_none());
        assert!(state.finished(2));
        assert!(state.error.is_none());
        assert!(!state.finished(2));
        assert_eq!(
            state
                .reported_url(Some("https://success.example/".into()))
                .as_deref(),
            Some("https://success.example/")
        );
    }

    #[test]
    fn failure_for_old_url_cannot_mark_a_pending_policy_navigation() {
        let mut state = NavigationState::default();
        state.request(FAILED);
        state.started(1);
        state.remember("https://new.example/");
        assert!(!state.failed(1, refused(), Some(FAILED)));
        assert!(!state.failed(1, refused(), None));
        assert!(state.error.is_none());
        // A redirect failure with the current target is still accepted.
        assert!(state.failed(1, refused(), Some("https://new.example/")));
    }

    #[test]
    fn platform_errors_distinguish_refusal_timeout_dns_offline_and_security() {
        for (number, code) in [
            (-1004, "ERR_CONNECTION_REFUSED"),
            (-1001, "ERR_TIMED_OUT"),
            (-1003, "ERR_NAME_NOT_RESOLVED"),
            (-1009, "ERR_INTERNET_DISCONNECTED"),
            (-1200, "ERR_SSL_PROTOCOL_ERROR"),
            (-1022, "ERR_ATS_REQUIRES_SECURE_CONNECTION"),
        ] {
            let error = webkit_error("NSURLErrorDomain", number, "native description").unwrap();
            assert_eq!(error.code, code);
            assert!(error.message.contains(&number.to_string()));
        }
        assert!(webkit_error("NSURLErrorDomain", -999, "cancelled").is_none());
        assert_eq!(
            webkit_error("WKErrorDomain", 42, "native description")
                .unwrap()
                .code,
            "WKErrorDomain:42"
        );
        assert_eq!(
            webkit_error("NSURLErrorDomain", -1202, "certificate")
                .unwrap()
                .code,
            "ERR_CERTIFICATE"
        );
        assert_eq!(webview2_error(13).unwrap().code, "ERR_NAME_NOT_RESOLVED");
        assert_eq!(webview2_error(7).unwrap().code, "ERR_TIMED_OUT");
        assert_eq!(webview2_error(12).unwrap().code, "ERR_CONNECTION_FAILED");
        assert_eq!(
            webview2_error(11).unwrap().code,
            "ERR_INTERNET_DISCONNECTED"
        );
        assert!(webview2_error(14).is_none());
        assert_eq!(
            webview2_error(99).unwrap().code,
            "WEBVIEW2_WEB_ERROR_STATUS:99"
        );
    }
}
