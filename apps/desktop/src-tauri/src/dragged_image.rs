//! Images dragged from a browser carry pixels, not file paths. The native
//! drop handler consumes the drag before the page sees it, so the image is
//! read back from the macOS drag pasteboard, which keeps the last drag.
use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn save(app: &AppHandle) -> Result<Option<String>, String> {
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboard, NSPasteboardNameDrag,
        NSPasteboardTypePNG, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSDictionary, NSString};

    let pasteboard = unsafe { NSPasteboard::pasteboardWithName(NSPasteboardNameDrag) };
    let direct = [
        (unsafe { NSPasteboardTypePNG }.to_string(), "png"),
        ("public.jpeg".to_string(), "jpg"),
        ("com.compuserve.gif".to_string(), "gif"),
        ("org.webmproject.webp".to_string(), "webp"),
    ];
    for (kind, extension) in direct {
        if let Some(data) = pasteboard.dataForType(&NSString::from_str(&kind)) {
            return super::local_file::save_image(app, extension, &data.to_vec()).map(Some);
        }
    }
    let Some(tiff) = pasteboard.dataForType(unsafe { NSPasteboardTypeTIFF }) else {
        return Ok(None);
    };
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
        .ok_or_else(|| "无法解码拖入的图片".to_string())?;
    let png = unsafe {
        bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or_else(|| "无法将拖入的图片编码为 PNG".to_string())?;
    super::local_file::save_image(app, "png", &png.to_vec()).map(Some)
}

#[cfg(not(target_os = "macos"))]
pub fn save(_app: &AppHandle) -> Result<Option<String>, String> {
    Ok(None)
}
