use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePreviewCapabilities {
    available: bool,
    formats: &'static [&'static str],
    technology: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficePdfPreview {
    mime_type: &'static str,
    data_base64: String,
}

const FORMATS: &[&str] = &["doc", "xls", "ppt", "wps", "et", "dps"];

pub fn capabilities() -> OfficePreviewCapabilities {
    OfficePreviewCapabilities {
        available: cfg!(windows),
        formats: FORMATS,
        technology: if cfg!(windows) {
            "WebView2 + WPS/Office COM PDF conversion"
        } else if cfg!(target_os = "macos") {
            "WKWebView"
        } else {
            "WebKitGTK"
        },
    }
}

fn document_family(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase()
        .as_str()
    {
        "doc" | "wps" => Some("word"),
        "xls" | "et" => Some("sheet"),
        "ppt" | "dps" => Some("slides"),
        _ => None,
    }
}

#[cfg(windows)]
const CONVERT_SCRIPT: &str = r#"Option Explicit
Dim source, output, family, app, document, progId, errors, fso
Set fso = CreateObject("Scripting.FileSystemObject")
source = WScript.Arguments(0)
output = WScript.Arguments(1)
family = WScript.Arguments(2)
errors = ""

If family = "word" Then
    ConvertWith "KWPS.Application", "Word.Application"
ElseIf family = "sheet" Then
    ConvertWith "KET.Application", "Excel.Application"
ElseIf family = "slides" Then
    ConvertWith "KWPP.Application", "PowerPoint.Application"
Else
    WScript.Echo "Unsupported office document family"
    WScript.Quit 2
End If

WScript.Echo errors
WScript.Quit 1

Sub ConvertWith(wpsProgId, officeProgId)
    Dim progIds, index
    progIds = Array(wpsProgId, officeProgId)
    For index = 0 To UBound(progIds)
        progId = progIds(index)
        Set app = Nothing
        Set document = Nothing
        On Error Resume Next
        Err.Clear
        Set app = CreateObject(progId)
        If Err.Number = 0 Then
            If family = "word" Then
                app.Visible = False
                Set document = app.Documents.Open(source, False, True)
                document.ExportAsFixedFormat output, 17
            ElseIf family = "sheet" Then
                Set document = app.Workbooks.Open(source, 0, True)
                document.ExportAsFixedFormat 0, output
            Else
                Set document = app.Presentations.Open(source, True, False, False)
                document.SaveAs output, 32
            End If
        End If
        If Err.Number = 0 And fso.FileExists(output) Then
            On Error GoTo 0
            On Error Resume Next
            document.Close False
            app.Quit
            On Error GoTo 0
            WScript.Quit 0
        End If
        errors = errors & progId & ": " & Err.Description & vbCrLf
        On Error Resume Next
        document.Close False
        app.Quit
        On Error GoTo 0
    Next
End Sub
"#;

#[cfg(windows)]
fn convert_to_pdf(source: &Path, output: &Path, family: &str) -> Result<(), String> {
    let cscript = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join("System32").join("cscript.exe"))
        .filter(|path| path.is_file());
    let executable = cscript
        .as_deref()
        .unwrap_or_else(|| Path::new("cscript.exe"));
    let script = output.with_extension("vbs");
    std::fs::write(&script, CONVERT_SCRIPT)
        .map_err(|error| format!("无法创建 WPS/Office 转换脚本: {error}"))?;
    let result = std::process::Command::new(executable)
        .args([
            "//NoLogo",
            &script.to_string_lossy(),
            &source.to_string_lossy(),
            &output.to_string_lossy(),
            family,
        ])
        .output()
        .map_err(|error| {
            format!(
                "无法启动 WPS/Office 转换程序 {}: {error}",
                executable.display()
            )
        });
    let _ = std::fs::remove_file(&script);
    let result = result?;
    if result.status.success() && output.is_file() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "WPS/Office 文档转换未生成 PDF".into()
    })
}

#[cfg(not(windows))]
fn convert_to_pdf(_source: &Path, _output: &Path, _family: &str) -> Result<(), String> {
    Err("旧版 Office/WPS 内嵌预览目前仅支持 Windows 桌面端".into())
}

pub fn convert(
    app: &AppHandle,
    path: &str,
    workspace_path: &str,
    workspace_paths: &[String],
    authorized_files: &[String],
) -> Result<OfficePdfPreview, String> {
    let source = miniq_local::files::validated_file_with_authorization(
        path,
        workspace_path,
        workspace_paths,
        authorized_files,
    )?;
    let family = document_family(&source)
        .ok_or_else(|| "此文件不是支持的旧版 Office/WPS 格式".to_string())?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("无法访问应用缓存目录: {error}"))?
        .join("office-previews");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("无法创建 Office 预览缓存: {error}"))?;
    let output = temporary_pdf_path(&directory);
    let result = convert_to_pdf(&source, &output, family).and_then(|()| {
        let bytes =
            std::fs::read(&output).map_err(|error| format!("无法读取转换后的 PDF: {error}"))?;
        if bytes.len() as u64 > miniq_local::files::MAX_PREVIEW_BYTES {
            return Err("转换后的 PDF 超过 64 MB 预览上限".into());
        }
        Ok(OfficePdfPreview {
            mime_type: "application/pdf",
            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        })
    });
    let _ = std::fs::remove_file(output);
    result
}

fn temporary_pdf_path(directory: &Path) -> PathBuf {
    directory.join(format!("{}.pdf", uuid::Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_wps_and_legacy_office_extensions_to_com_families() {
        for (name, expected) in [
            ("draft.doc", "word"),
            ("draft.wps", "word"),
            ("ledger.xls", "sheet"),
            ("ledger.et", "sheet"),
            ("briefing.ppt", "slides"),
            ("briefing.dps", "slides"),
        ] {
            assert_eq!(document_family(Path::new(name)), Some(expected));
        }
        assert_eq!(document_family(Path::new("modern.docx")), None);
    }

    #[test]
    fn reports_platform_capability_and_all_supported_formats() {
        let capability = capabilities();
        assert_eq!(capability.available, cfg!(windows));
        assert_eq!(capability.formats, FORMATS);
        assert!(!capability.technology.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn conversion_script_prefers_wps_and_exports_each_family_as_pdf() {
        assert!(CONVERT_SCRIPT.contains("ConvertWith \"KWPS.Application\", \"Word.Application\""));
        assert!(CONVERT_SCRIPT.contains("ConvertWith \"KET.Application\", \"Excel.Application\""));
        assert!(
            CONVERT_SCRIPT.contains("ConvertWith \"KWPP.Application\", \"PowerPoint.Application\"")
        );
        assert!(CONVERT_SCRIPT.contains("document.ExportAsFixedFormat output, 17"));
        assert!(CONVERT_SCRIPT.contains("document.ExportAsFixedFormat 0, output"));
        assert!(CONVERT_SCRIPT.contains("document.SaveAs output, 32"));
    }
}
