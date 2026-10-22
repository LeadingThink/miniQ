//! Windows currently exposes the real default association. Keeping its ProgID
//! binds invocation to that handler, including packaged applications and DDE.
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use tauri::AppHandle;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
use windows::Win32::UI::Shell::{
    AssocQueryStringW, ShellExecuteExW, ASSOCF_INIT_FOR_FILE, ASSOCSTR, ASSOCSTR_EXECUTABLE,
    ASSOCSTR_FRIENDLYAPPNAME, ASSOCSTR_PROGID, SEE_MASK_CLASSNAME, SEE_MASK_FLAG_NO_UI,
    SEE_MASK_NOASYNC, SHELLEXECUTEINFOW,
};

use super::{selected_application, FileOpenApplication};

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn association(file: &[u16], kind: ASSOCSTR) -> Result<Option<String>, String> {
    let mut length = 0;
    // The first call is a size query; S_FALSE is expected for a registered
    // association. No returned size means Windows has no such association.
    let _ = unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_FOR_FILE,
            kind,
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            None,
            &mut length,
        )
    };
    if length == 0 {
        return Ok(None);
    }
    let mut value = vec![0; length as usize];
    unsafe {
        AssocQueryStringW(
            ASSOCF_INIT_FOR_FILE,
            kind,
            PCWSTR(file.as_ptr()),
            PCWSTR::null(),
            Some(PWSTR(value.as_mut_ptr())),
            &mut length,
        )
        .ok()
    }
    .map_err(|error| format!("无法查询系统文件关联: {error}"))?;
    let end = value
        .iter()
        .position(|value| *value == 0)
        .unwrap_or(value.len());
    let value = String::from_utf16_lossy(&value[..end]);
    Ok((!value.is_empty()).then_some(value))
}

fn current_applications(file: &Path) -> Result<Vec<FileOpenApplication>, String> {
    let file = wide(file.as_os_str());
    let Some(progid) = association(&file, ASSOCSTR_PROGID)? else {
        return Ok(Vec::new());
    };
    let name = match association(&file, ASSOCSTR_FRIENDLYAPPNAME)? {
        Some(name) => name,
        None => association(&file, ASSOCSTR_EXECUTABLE)?
            .and_then(|executable| {
                Path::new(&executable)
                    .file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| progid.clone()),
    };
    Ok(vec![FileOpenApplication {
        id: format!("windows:{progid}"),
        name,
        is_default: true,
    }])
}

pub async fn applications(
    _app: AppHandle,
    file: PathBuf,
) -> Result<Vec<FileOpenApplication>, String> {
    tauri::async_runtime::spawn_blocking(move || current_applications(&file))
        .await
        .map_err(|error| error.to_string())?
}

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        // This guard exists only after this thread successfully initialized COM.
        unsafe { CoUninitialize() };
    }
}

fn open_registered(file: &Path, id: &str) -> Result<(), String> {
    let applications = current_applications(file)?;
    let selected = selected_application(&applications, id)?;
    let progid = selected
        .id
        .strip_prefix("windows:")
        .ok_or_else(|| "系统文件关联 ID 无效".to_string())?;
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
        .map_err(|error| format!("无法初始化系统文件打开服务: {error}"))?;
    let _apartment = ComApartment;
    let file = wide(file.as_os_str());
    let class = wide(std::ffi::OsStr::new(progid));
    let mut execute = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_CLASSNAME | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
        lpFile: PCWSTR(file.as_ptr()),
        lpClass: PCWSTR(class.as_ptr()),
        nShow: 1, // SW_SHOWNORMAL; the API field is an i32.
        ..Default::default()
    };
    // The file and ProgID are separate wide strings. ShellExecuteEx resolves
    // the registered invocation; no command string or shell is constructed.
    unsafe { ShellExecuteExW(&mut execute) }
        .map_err(|error| format!("无法使用所选应用打开文件: {error}"))
}

pub async fn open(_app: AppHandle, file: PathBuf, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_registered(&file, &id))
        .await
        .map_err(|error| error.to_string())?
}
