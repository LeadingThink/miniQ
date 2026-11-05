//! Bounded reads of user-dropped files for the shared remote upload pipeline.
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

// Keep aligned with remoteUploadSource.ts.
const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
const CHUNK_BYTES: usize = 1024 * 1024;

#[derive(Debug, serde::Serialize)]
pub struct UploadFileInfo {
    name: String,
    size: u64,
    modified: String,
}

fn file_info(path: &str, metadata: &std::fs::Metadata) -> Result<UploadFileInfo, String> {
    if !Path::new(path).is_absolute() {
        return Err("上传文件必须使用本机绝对路径".into());
    }
    if !metadata.is_file() {
        return Err("暂不支持上传文件夹，请选择文件".into());
    }
    if metadata.len() > MAX_FILE_BYTES {
        return Err("单个文件不能超过 200 MiB".into());
    }
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("无法读取上传文件名")?
        .to_owned();
    let modified = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos()
        .to_string();
    Ok(UploadFileInfo {
        name,
        size: metadata.len(),
        modified,
    })
}

#[tauri::command]
pub async fn local_upload_file_info(
    webview: tauri::Webview,
    path: String,
) -> Result<UploadFileInfo, String> {
    crate::companion::authorized(webview.label())?;
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("无法读取本机文件: {error}"))?;
    file_info(&path, &metadata)
}

async fn read_chunk(
    path: &str,
    offset: u64,
    length: usize,
    expected_size: u64,
    expected_modified: &str,
) -> Result<Vec<u8>, String> {
    if length == 0
        || length > CHUNK_BYTES
        || offset
            .checked_add(length as u64)
            .is_none_or(|end| end > expected_size)
    {
        return Err("上传文件分块范围无效".into());
    }
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|error| format!("无法打开本机文件: {error}"))?;
    let verify = |metadata: std::fs::Metadata| -> Result<(), String> {
        let info = file_info(path, &metadata)?;
        if info.size != expected_size || info.modified != expected_modified {
            return Err("上传文件内容已变化，请重新添加".into());
        }
        Ok(())
    };
    verify(file.metadata().await.map_err(|error| error.to_string())?)?;
    file.seek(std::io::SeekFrom::Start(offset))
        .await
        .map_err(|error| error.to_string())?;
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)
        .await
        .map_err(|error| format!("无法完整读取上传文件: {error}"))?;
    verify(file.metadata().await.map_err(|error| error.to_string())?)?;
    Ok(bytes)
}

#[tauri::command]
pub async fn read_local_upload_chunk(
    webview: tauri::Webview,
    path: String,
    offset: u64,
    length: usize,
    expected_size: u64,
    expected_modified: String,
) -> Result<tauri::ipc::Response, String> {
    crate::companion::authorized(webview.label())?;
    read_chunk(&path, offset, length, expected_size, &expected_modified)
        .await
        .map(tauri::ipc::Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reads_every_byte_in_bounded_chunks_and_preserves_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("完整原件.bin");
        let bytes: Vec<u8> = (0..CHUNK_BYTES * 2 + 17).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let path = path.to_str().unwrap();
        let info = file_info(path, &std::fs::metadata(path).unwrap()).unwrap();
        assert_eq!(info.name, "完整原件.bin");
        let mut actual = Vec::new();
        for offset in (0..bytes.len()).step_by(CHUNK_BYTES) {
            let length = CHUNK_BYTES.min(bytes.len() - offset);
            actual.extend(
                read_chunk(path, offset as u64, length, info.size, &info.modified)
                    .await
                    .unwrap(),
            );
        }
        assert_eq!(actual, bytes);
        for (offset, length) in [(0, 0), (0, CHUNK_BYTES + 1), (info.size, 1), (u64::MAX, 1)] {
            assert!(read_chunk(path, offset, length, info.size, &info.modified)
                .await
                .unwrap_err()
                .contains("范围无效"));
        }
    }

    #[tokio::test]
    async fn rejects_changed_files_instead_of_silently_uploading_partial_data() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_str().unwrap();
        std::fs::write(path, "original").unwrap();
        let info = file_info(path, &file.as_file().metadata().unwrap()).unwrap();
        assert!(read_chunk(path, 0, 1, info.size, "stale")
            .await
            .unwrap_err()
            .contains("已变化"));
        std::fs::write(path, "changed size").unwrap();
        assert!(read_chunk(path, 0, 1, info.size, &info.modified)
            .await
            .unwrap_err()
            .contains("已变化"));
    }

    #[test]
    fn rejects_directories_and_oversize_files_but_accepts_empty_files() {
        let dir = tempfile::tempdir().unwrap();
        assert!(file_info(
            dir.path().to_str().unwrap(),
            &dir.path().metadata().unwrap()
        )
        .unwrap_err()
        .contains("文件夹"));
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_str().unwrap();
        assert_eq!(
            file_info(path, &file.as_file().metadata().unwrap())
                .unwrap()
                .size,
            0
        );
        file.as_file().set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(file_info(path, &file.as_file().metadata().unwrap())
            .unwrap_err()
            .contains("200 MiB"));
    }
}
