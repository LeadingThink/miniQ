use base64::Engine;

use crate::{ChatImage, ProviderError};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;

pub(crate) struct EncodedImage {
    pub mime_type: String,
    pub base64: String,
}

pub(crate) fn encode_image(image: &ChatImage) -> Result<EncodedImage, ProviderError> {
    let metadata = std::fs::metadata(&image.path).map_err(|error| {
        ProviderError::Config(format!(
            "cannot read attached image {}: {error}",
            image.path
        ))
    })?;
    if !metadata.is_file() {
        return Err(ProviderError::Config(format!(
            "attached image is not a file: {}",
            image.path
        )));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ProviderError::Config(format!(
            "attached image exceeds 20 MB: {}",
            image.path
        )));
    }
    let bytes = std::fs::read(&image.path).map_err(|error| {
        ProviderError::Config(format!(
            "cannot read attached image {}: {error}",
            image.path
        ))
    })?;
    Ok(EncodedImage {
        mime_type: image.mime_type.clone(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}
