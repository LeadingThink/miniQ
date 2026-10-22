//! NSWorkspace / LaunchServices public APIs. All Objective-C objects remain on
//! the main thread; only owned Rust data crosses the Tauri command boundary.
use std::collections::HashSet;
use std::ffi::c_void;
use std::path::{Path, PathBuf};

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send, MainThreadMarker};
use objc2_foundation::{NSString, NSURL};
use tauri::AppHandle;
use tokio::sync::oneshot;

use super::{selected_application, FileOpenApplication};

// LaunchServices supports the application's existing macOS 10.13 deployment
// target. NSWorkspace's newer handler-array selector requires macOS 12.
#[repr(C)]
struct LaunchUrlSpec {
    application_url: *const c_void,
    item_urls: *const c_void,
    pass_thru_params: *const c_void,
    launch_flags: u32,
    async_ref_con: *mut c_void,
}

#[link(name = "CoreServices", kind = "framework")]
extern "C" {
    fn LSCopyApplicationURLsForURL(url: *const c_void, roles: u32) -> *mut AnyObject;
    fn LSOpenFromURLSpec(spec: *const LaunchUrlSpec, launched_url: *mut *const c_void) -> i32;
}

async fn on_main_thread<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(MainThreadMarker) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let result = MainThreadMarker::new()
            .ok_or_else(|| "无法在系统主线程执行文件操作".to_string())
            .and_then(action);
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

fn file_url(path: &Path) -> Result<Retained<NSURL>, String> {
    let path = path
        .to_str()
        .ok_or_else(|| "文件路径不是有效的 Unicode 字符串".to_string())?;
    let path = NSString::from_str(path);
    // SAFETY: NSURL's public +fileURLWithPath: takes an NSString and returns
    // a nonnull NSURL. Retained handles its Objective-C ownership convention.
    Ok(unsafe { msg_send![class!(NSURL), fileURLWithPath: &*path] })
}

fn url_path(url: &NSURL) -> Option<String> {
    // SAFETY: NSURL's nullable path property is an NSString.
    let path: Option<Retained<NSString>> = unsafe { msg_send![url, path] };
    path.map(|path| path.to_string())
}

fn current_applications(
    file: &Path,
    _main_thread: MainThreadMarker,
) -> Result<Vec<FileOpenApplication>, String> {
    let file = file_url(file)?;
    // SAFETY: all receivers and selector signatures below are the public
    // NSWorkspace / NSArray / NSFileManager APIs. They run on the main thread.
    let workspace: Retained<AnyObject> = unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
    // SAFETY: kLSRolesAll is 0xffffffff. This Copy function returns an owned
    // nullable CFArray, toll-free bridged to NSArray and released by Retained.
    let urls = unsafe {
        Retained::from_raw(LSCopyApplicationURLsForURL(
            Retained::as_ptr(&file).cast(),
            u32::MAX,
        ))
    };
    let default_url: Option<Retained<NSURL>> =
        unsafe { msg_send![&*workspace, URLForApplicationToOpenURL: &*file] };
    let default_path = default_url.as_deref().and_then(url_path);
    let manager: Retained<AnyObject> = unsafe { msg_send![class!(NSFileManager), defaultManager] };
    let mut candidates = Vec::new();
    if let Some(urls) = urls {
        let count: usize = unsafe { msg_send![&*urls, count] };
        for index in 0..count {
            let url: Retained<NSURL> = unsafe { msg_send![&*urls, objectAtIndex: index] };
            candidates.push(url);
        }
    }
    // The default is itself a real handler, even if LaunchServices did not
    // repeat it in its handler array.
    candidates.extend(default_url);

    let mut seen = HashSet::new();
    let mut applications = Vec::new();
    for url in candidates {
        let Some(path) = url_path(&url) else {
            continue;
        };
        if !seen.insert(path.clone()) || !Path::new(&path).is_dir() {
            continue;
        }
        let ns_path = NSString::from_str(&path);
        let name: Retained<NSString> =
            unsafe { msg_send![&*manager, displayNameAtPath: &*ns_path] };
        let name = name.to_string();
        let name = name.strip_suffix(".app").unwrap_or(&name).to_string();
        applications.push(FileOpenApplication {
            id: format!("macos:{path}"),
            name,
            is_default: default_path.as_deref() == Some(path.as_str()),
        });
    }
    applications
        .sort_by_key(|application| (!application.is_default, application.name.to_lowercase()));
    Ok(applications)
}

pub async fn applications(
    app: AppHandle,
    file: PathBuf,
) -> Result<Vec<FileOpenApplication>, String> {
    on_main_thread(app, move |main_thread| {
        current_applications(&file, main_thread)
    })
    .await
}

fn open_registered(file: &Path, id: &str, main_thread: MainThreadMarker) -> Result<(), String> {
    let applications = current_applications(file, main_thread)?;
    let selected = selected_application(&applications, id)?;
    let application_path = selected
        .id
        .strip_prefix("macos:")
        .ok_or_else(|| "系统应用 ID 无效".to_string())?;
    let file = file_url(file)?;
    let application = file_url(Path::new(application_path))?;
    // SAFETY: NSArray and CFArray are toll-free bridged. The launch spec and
    // retained URLs stay alive throughout this synchronous public API call.
    let urls: Retained<AnyObject> = unsafe { msg_send![class!(NSArray), arrayWithObject: &*file] };
    let spec = LaunchUrlSpec {
        application_url: Retained::as_ptr(&application).cast(),
        item_urls: Retained::as_ptr(&urls).cast(),
        pass_thru_params: std::ptr::null(),
        launch_flags: 1, // kLSLaunchDefaults, without kLSLaunchAsync.
        async_ref_con: std::ptr::null_mut(),
    };
    let status = unsafe { LSOpenFromURLSpec(&spec, std::ptr::null_mut()) };
    if status != 0 {
        return Err(format!("无法使用所选应用打开文件（系统错误 {status}）"));
    }
    Ok(())
}

pub async fn open(app: AppHandle, file: PathBuf, id: String) -> Result<(), String> {
    on_main_thread(app, move |main_thread| {
        open_registered(&file, &id, main_thread)
    })
    .await
}
