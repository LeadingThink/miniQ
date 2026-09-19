use block2::RcBlock;
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDictionary, NSError};

fn encode_png(image: &NSImage) -> Result<Vec<u8>, String> {
    let tiff = image
        .TIFFRepresentation()
        .ok_or_else(|| "无法读取内嵌浏览器截图像素".to_string())?;
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "无法解码内嵌浏览器截图像素".to_string())?;
    // The empty properties dictionary is valid for PNG; no lossy conversion
    // or desktop capture is involved.
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or_else(|| "无法将内嵌浏览器截图编码为 PNG".to_string())?;
    Ok(png.to_vec())
}

pub async fn capture(webview: tauri::Webview) -> Result<Vec<u8>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(sender)));
    webview
        .with_webview(move |platform| {
            let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if !error.is_null() {
                    Err(unsafe { (&*error).to_string() })
                } else if image.is_null() {
                    Err("内嵌浏览器未返回截图".to_string())
                } else {
                    encode_png(unsafe { &*image })
                };
                if let Some(sender) = sender.lock().ok().and_then(|mut value| value.take()) {
                    let _ = sender.send(result);
                }
            });
            // Tauri executes this callback on the view's main thread. WebKit
            // captures only this WKWebView, including CSS, images and canvas.
            let view: &objc2_web_kit::WKWebView = unsafe { &*platform.inner().cast() };
            unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &completion) };
        })
        .map_err(|error| error.to_string())?;
    receiver
        .await
        .map_err(|_| "内嵌浏览器截图通道已关闭".to_string())?
}
