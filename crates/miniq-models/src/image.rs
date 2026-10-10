use std::io::{Cursor, Read};
use std::path::Path;

use base64::Engine;
use image::{AnimationDecoder, ImageDecoder, ImageFormat};

use crate::{ChatImage, ImageDetail, ProviderError};

const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 128 * 1024 * 1024;
// Anthropic limits the decoded image in a base64 source block to 10 MB. Keep
// a margin because the surrounding JSON and base64 representation add bytes
// to the HTTP request.
const MAX_PROVIDER_IMAGE_BYTES: usize = 7 * 1024 * 1024;
const MAX_PROVIDER_IMAGE_DIMENSION: u32 = 4096;

pub(crate) struct EncodedImage {
    pub mime_type: String,
    pub base64: String,
}

pub(crate) fn encode_image(image: &ChatImage) -> Result<EncodedImage, ProviderError> {
    encode_image_payload(image).map_err(|error| ProviderError::Attachment {
        path: image.path.clone(),
        detail: error.to_string(),
    })
}

fn encode_image_payload(image: &ChatImage) -> Result<EncodedImage, ProviderError> {
    let mut bytes = read_image_bytes(Path::new(&image.path))?;
    let mut mime_type = image.mime_type.clone();
    if image.detail == ImageDetail::Preview {
        let pixels = decode_static_image(&bytes)?;
        let target = image
            .detail
            .target_dimensions(pixels.width(), pixels.height());
        if target != (pixels.width(), pixels.height()) {
            let preview =
                pixels.resize_exact(target.0, target.1, image::imageops::FilterType::Triangle);
            let mut png = Cursor::new(Vec::new());
            preview
                .write_to(&mut png, ImageFormat::Png)
                .map_err(invalid)?;
            bytes = png.into_inner();
            mime_type = "image/png".into();
        }
    }
    if bytes.len() > MAX_PROVIDER_IMAGE_BYTES {
        bytes = compress_for_provider(&bytes)?;
        mime_type = "image/jpeg".into();
    }
    Ok(EncodedImage {
        mime_type,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// Prepare a provider-only copy below Anthropic's per-image limit.
/// The source file is never modified.
fn compress_for_provider(bytes: &[u8]) -> Result<Vec<u8>, ProviderError> {
    let pixels = decode_static_image(bytes)?;
    let max_dimension = pixels.width().max(pixels.height());
    let initial_scale =
        (f64::from(MAX_PROVIDER_IMAGE_DIMENSION) / f64::from(max_dimension.max(1))).min(1.0);

    // Try progressively smaller dimensions and JPEG qualities. The first
    // result under the budget keeps the most detail possible.
    for scale in [1.0_f64, 0.88, 0.75, 0.62, 0.5, 0.4, 0.3, 0.22] {
        let scale = (initial_scale * scale).min(1.0);
        let width = ((f64::from(pixels.width()) * scale).round() as u32).max(1);
        let height = ((f64::from(pixels.height()) * scale).round() as u32).max(1);
        let candidate = if width == pixels.width() && height == pixels.height() {
            pixels.clone()
        } else {
            pixels.resize(width, height, image::imageops::FilterType::Triangle)
        };
        for quality in [82_u8, 72, 62, 52] {
            let mut output = Cursor::new(Vec::new());
            let mut encoder =
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality);
            encoder.encode_image(&candidate).map_err(invalid)?;
            let encoded = output.into_inner();
            if encoded.len() <= MAX_PROVIDER_IMAGE_BYTES {
                return Ok(encoded);
            }
        }
    }

    Err(ProviderError::Config(format!(
        "image remains larger than {} MB after safe compression",
        MAX_PROVIDER_IMAGE_BYTES / (1024 * 1024)
    )))
}

fn open_image_file(path: &Path) -> Result<std::fs::File, ProviderError> {
    let error = |error| {
        ProviderError::Config(format!(
            "cannot read attached image {}: {error}",
            path.display()
        ))
    };
    let metadata = std::fs::symlink_metadata(path).map_err(error)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProviderError::Config(format!(
            "attached image must be a regular file, not a symlink: {}",
            path.display()
        )));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Refuse symlink swaps and avoid blocking if the path becomes a FIFO.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    let file = options.open(path).map_err(error)?;
    let metadata = file.metadata().map_err(error)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(ProviderError::Config(
            "attached image must be a regular file".into(),
        ));
    }
    if metadata.len() > MAX_IMAGE_BYTES {
        return Err(ProviderError::Config("attached image exceeds 20 MB".into()));
    }
    Ok(file)
}

/// Check an archived image without decoding or reading its payload.
pub fn validate_image_path(image: &ChatImage) -> Result<(), ProviderError> {
    open_image_file(Path::new(&image.path)).map(|_| ())
}

/// Read bounded original bytes without following a substituted symlink.
/// Attachment ingestion shares this path with provider request encoding.
pub fn read_image_bytes(path: &Path) -> Result<Vec<u8>, ProviderError> {
    let file = open_image_file(path)?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            ProviderError::Config(format!(
                "cannot read attached image {}: {error}",
                path.display()
            ))
        })?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ProviderError::Config("attached image exceeds 20 MB".into()));
    }
    Ok(bytes)
}

/// Safely read a regular image file without following a substituted symlink.
pub fn load_static_image(path: &Path) -> Result<image::DynamicImage, ProviderError> {
    decode_static_image(&read_image_bytes(path)?)
}

/// Decode bounded, static visual evidence and normalize its EXIF orientation.
/// Shared by local image snapshots and model preview preparation.
pub fn decode_static_image(bytes: &[u8]) -> Result<image::DynamicImage, ProviderError> {
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ProviderError::Config("image exceeds 20 MB".into()));
    }
    let format = image::guess_format(bytes).map_err(invalid)?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Gif
    ) {
        return Err(ProviderError::Config(
            "supported image formats: PNG, JPEG, WebP, static GIF".into(),
        ));
    }
    reject_animation(bytes, format)?;
    let mut reader = image::ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decode_limits());
    let mut decoder = reader.into_decoder().map_err(invalid)?;
    if decoder.total_bytes() > MAX_DECODED_BYTES {
        return Err(ProviderError::Config(
            "decoded image exceeds the 128 MB allocation limit".into(),
        ));
    }
    let orientation = decoder.orientation().map_err(invalid)?;
    let mut pixels = image::DynamicImage::from_decoder(decoder).map_err(invalid)?;
    pixels.apply_orientation(orientation);
    Ok(pixels)
}

fn decode_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODED_BYTES);
    limits
}

fn reject_animation(bytes: &[u8], format: ImageFormat) -> Result<(), ProviderError> {
    let animated = match format {
        ImageFormat::Gif => {
            let mut decoder =
                image::codecs::gif::GifDecoder::new(Cursor::new(bytes)).map_err(invalid)?;
            decoder.set_limits(decode_limits()).map_err(invalid)?;
            let mut frames = decoder.into_frames();
            let first = frames.next().transpose().map_err(invalid)?.is_some();
            first && frames.next().transpose().map_err(invalid)?.is_some()
        }
        ImageFormat::Png => image::codecs::png::PngDecoder::new(Cursor::new(bytes))
            .map_err(invalid)?
            .is_apng()
            .map_err(invalid)?,
        ImageFormat::WebP => image::codecs::webp::WebPDecoder::new(Cursor::new(bytes))
            .map_err(invalid)?
            .has_animation(),
        _ => false,
    };
    if animated {
        return Err(ProviderError::Config("animated image: extract and inspect explicit frames; no frames were silently discarded".into()));
    }
    Ok(())
}

fn invalid(error: impl std::fmt::Display) -> ProviderError {
    ProviderError::Config(format!("cannot decode attached image: {error}"))
}

#[cfg(test)]
mod tests;
