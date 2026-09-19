use std::cell::RefCell;
use std::rc::Rc;

use webview2_com::CapturePreviewCompletedHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
use windows::Win32::Foundation::HGLOBAL;
use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

/// Capture only the embedded browser, without foregrounding the desktop or
/// accessing other applications. COM objects remain on WebView2's UI thread;
/// only the completed PNG bytes cross the asynchronous channel.
pub async fn capture(webview: tauri::Webview) -> Result<Vec<u8>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let sender = Rc::new(RefCell::new(Some(sender)));
            let callback_sender = sender.clone();
            let result = unsafe {
                platform.controller().CoreWebView2().and_then(|browser| {
                    // The stream owns its global allocation and frees it when
                    // the last COM reference is released, including on errors.
                    let stream = CreateStreamOnHGlobal(HGLOBAL::default(), true)?;
                    let output = stream.clone();
                    let handler = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                        if let Some(sender) = callback_sender.borrow_mut().take() {
                            // A timeout or cancelled IPC may drop the receiver.
                            // Keep the stream alive until WebView2 completes,
                            // but do not copy the image for an abandoned request.
                            if !sender.is_closed() {
                                let result = status
                                    .map_err(|error| format!("内嵌浏览器截图失败: {error}"))
                                    .and_then(|_| read_png(&output));
                                let _ = sender.send(result);
                            }
                        }
                        Ok(())
                    }));
                    browser.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &handler,
                    )
                })
            };
            if let Err(error) = result {
                if let Some(sender) = sender.borrow_mut().take() {
                    let _ = sender.send(Err(format!("内嵌浏览器截图启动失败: {error}")));
                }
            }
        })
        .map_err(|error| format!("无法访问内嵌浏览器截图: {error}"))?;
    receiver
        .await
        .map_err(|_| "内嵌浏览器截图通道已关闭".to_string())?
}

fn read_png(stream: &IStream) -> Result<Vec<u8>, String> {
    let mut stat = STATSTG::default();
    unsafe { stream.Stat(&mut stat, STATFLAG_NONAME) }
        .map_err(|error| format!("读取截图大小失败: {error}"))?;
    let length = usize::try_from(stat.cbSize).map_err(|_| "截图大小超出平台范围".to_string())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|error| format!("无法分配截图内存: {error}"))?;
    bytes.resize(length, 0);
    unsafe { stream.Seek(0, STREAM_SEEK_SET, None) }
        .map_err(|error| format!("定位截图数据失败: {error}"))?;
    let mut offset = 0;
    while offset < length {
        let count = (length - offset).min(u32::MAX as usize) as u32;
        let mut read = 0;
        unsafe { stream.Read(bytes[offset..].as_mut_ptr().cast(), count, Some(&mut read)) }
            .ok()
            .map_err(|error| format!("读取截图数据失败: {error}"))?;
        if read == 0 || read > count {
            return Err("内嵌浏览器返回了不完整的截图数据".to_string());
        }
        offset += read as usize;
    }
    Ok(bytes)
}
