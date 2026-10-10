//! Native JavaScript `alert` / `confirm` / `prompt` panels for embedded
//! browser views on macOS.
//!
//! Wry's `WryWebViewUIDelegate` does not implement the WKUIDelegate dialog
//! methods, so WebKit silently answers every dialog with its default. We
//! register a runtime subclass of wry's delegate class that only adds the
//! three dialog methods, then swap the class of each browser view's delegate
//! instance. Everything else (file upload panel, media permissions, new
//! window requests) is inherited unchanged, and the main miniQ webview keeps
//! wry's original class.

use std::cell::Cell;
use std::ffi::CStr;
use std::ptr;
use std::sync::OnceLock;

use block2::{DynBlock, RcBlock};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSModalResponse, NSTextField, NSView};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};
use objc2_web_kit::{WKFrameInfo, WKWebView};

const SUBCLASS_NAME: &CStr = c"MiniQBrowserUIDelegate";

/// (wry delegate class, miniQ subclass). `None` if the subclass could not be
/// created; dialogs then keep WebKit's default behavior.
struct DelegateClasses {
    base: &'static AnyClass,
    subclass: &'static AnyClass,
}

static CLASSES: OnceLock<Option<DelegateClasses>> = OnceLock::new();

fn build_subclass(base: &'static AnyClass) -> Option<DelegateClasses> {
    let mut builder = ClassBuilder::new(SUBCLASS_NAME, base)?;
    // SAFETY: the signatures match the WKUIDelegate declarations in
    // objc2-web-kit (WKUIDelegate.rs) argument for argument.
    unsafe {
        builder.add_method(
            sel!(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:),
            run_alert as unsafe extern "C-unwind" fn(_, _, _, _, _, _),
        );
        builder.add_method(
            sel!(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:),
            run_confirm as unsafe extern "C-unwind" fn(_, _, _, _, _, _),
        );
        builder.add_method(
            sel!(webView:runJavaScriptTextInputPanelWithPrompt:defaultText:initiatedByFrame:completionHandler:),
            run_prompt as unsafe extern "C-unwind" fn(_, _, _, _, _, _, _),
        );
    }
    Some(DelegateClasses {
        base,
        subclass: builder.register(),
    })
}

/// Enable native dialogs on one browser view. Must run on the main thread
/// (inside `Webview::with_webview`).
pub fn install(view: &WKWebView) {
    let Some(delegate) = (unsafe { view.UIDelegate() }) else {
        return;
    };
    // SAFETY: every protocol object is an Objective-C object.
    let object: &AnyObject = unsafe { &*(Retained::as_ptr(&delegate) as *const AnyObject) };
    let current = object.class();
    let Some(classes) = CLASSES.get_or_init(|| build_subclass(current)) else {
        return;
    };
    if ptr::eq(current, classes.subclass) || !ptr::eq(current, classes.base) {
        return;
    }
    // SAFETY: the subclass derives from the object's class and adds no
    // instance variables, so the instance layout is unchanged.
    unsafe {
        AnyObject::set_class(object, classes.subclass);
        // WebKit caches `respondsToSelector:` results when the delegate is
        // assigned. Re-assign so it sees the new dialog methods. Wry keeps a
        // strong reference to the delegate, and so does `delegate` here.
        view.setUIDelegate(None);
        view.setUIDelegate(Some(&delegate));
    }
}

fn page_title(frame: &WKFrameInfo) -> String {
    let host = unsafe { frame.securityOrigin().host() }.to_string();
    if host.is_empty() {
        "网页消息".to_string()
    } else {
        format!("来自 {host} 的网页")
    }
}

fn new_alert(mtm: MainThreadMarker, frame: &WKFrameInfo, message: &NSString) -> Retained<NSAlert> {
    let alert = NSAlert::new(mtm);
    alert.setMessageText(&NSString::from_str(&page_title(frame)));
    alert.setInformativeText(message);
    alert
}

/// Show `alert` as a sheet on the view's window (or app-modal without a
/// window) and call `on_end` exactly once with the response.
fn present(view: &WKWebView, alert: &NSAlert, on_end: Box<dyn FnOnce(NSModalResponse)>) {
    match view.window() {
        Some(window) => {
            let on_end = Cell::new(Some(on_end));
            let block = RcBlock::new(move |response: NSModalResponse| {
                if let Some(on_end) = on_end.take() {
                    on_end(response);
                }
            });
            alert.beginSheetModalForWindow_completionHandler(&window, Some(&block));
        }
        None => {
            let response = alert.runModal();
            on_end(response);
        }
    }
}

unsafe extern "C-unwind" fn run_alert(
    _this: &AnyObject,
    _cmd: Sel,
    view: &WKWebView,
    message: &NSString,
    frame: &WKFrameInfo,
    handler: &DynBlock<dyn Fn()>,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        handler.call(());
        return;
    };
    let handler = handler.copy();
    let alert = new_alert(mtm, frame, message);
    alert.addButtonWithTitle(&NSString::from_str("确定"));
    present(view, &alert, Box::new(move |_| handler.call(())));
}

unsafe extern "C-unwind" fn run_confirm(
    _this: &AnyObject,
    _cmd: Sel,
    view: &WKWebView,
    message: &NSString,
    frame: &WKFrameInfo,
    handler: &DynBlock<dyn Fn(Bool)>,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        handler.call((Bool::NO,));
        return;
    };
    let handler = handler.copy();
    let alert = new_alert(mtm, frame, message);
    alert.addButtonWithTitle(&NSString::from_str("确定"));
    alert.addButtonWithTitle(&NSString::from_str("取消"));
    present(
        view,
        &alert,
        Box::new(move |response| {
            handler.call((Bool::new(response == NSAlertFirstButtonReturn),));
        }),
    );
}

unsafe extern "C-unwind" fn run_prompt(
    _this: &AnyObject,
    _cmd: Sel,
    view: &WKWebView,
    prompt: &NSString,
    default_text: Option<&NSString>,
    frame: &WKFrameInfo,
    handler: &DynBlock<dyn Fn(*mut NSString)>,
) {
    let Some(mtm) = MainThreadMarker::new() else {
        handler.call((ptr::null_mut(),));
        return;
    };
    let handler = handler.copy();
    let alert = new_alert(mtm, frame, prompt);
    alert.addButtonWithTitle(&NSString::from_str("确定"));
    alert.addButtonWithTitle(&NSString::from_str("取消"));
    let initial = default_text
        .map(|text| text.to_string())
        .unwrap_or_default();
    let field = NSTextField::textFieldWithString(&NSString::from_str(&initial), mtm);
    field.setFrame(NSRect::new(
        NSPoint::new(0.0, 0.0),
        NSSize::new(320.0, 24.0),
    ));
    let field_view: &NSView = &field;
    alert.setAccessoryView(Some(field_view));
    alert.window().setInitialFirstResponder(Some(field_view));
    present(
        view,
        &alert,
        Box::new(move |response| {
            if response == NSAlertFirstButtonReturn {
                let value = field.stringValue();
                handler.call((Retained::as_ptr(&value) as *mut NSString,));
            } else {
                handler.call((ptr::null_mut(),));
            }
        }),
    );
}
