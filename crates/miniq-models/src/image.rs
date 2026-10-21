use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use base64::Engine;
use image::{AnimationDecoder, ImageDecoder, ImageFormat};
use sha2::{Digest, Sha256};

use crate::{ChatImage, ImageDetail, ProviderError};

// Sanity guards for pathological inputs, not target sizes. What actually
// reaches the model is bounded by the geometry applied before encoding.
const MAX_IMAGE_BYTES: u64 = 256 * 1024 * 1024;
// A 100 MP photo needs roughly 400 MB as RGBA8.
const MAX_DECODED_BYTES: u64 = 512 * 1024 * 1024;
// Anthropic limits the decoded image in a base64 source block to 10 MB. Keep
// a margin because the surrounding JSON and base64 representation add bytes
// to the HTTP request.
const MAX_PROVIDER_IMAGE_BYTES: usize = 7 * 1024 * 1024;
// Geometry is decided once, before encoding. Retrying on encoded size instead
// re-encodes the same pixels up to dozens of times and produces unpredictable
// downscale steps; a fixed budget keeps coordinates and cost reproducible.
const PROMPT_IMAGE_PATCH_SIZE: u32 = 32;
const ORIGINAL_MAX_DIMENSION: u32 = 6000;
const ORIGINAL_MAX_PATCHES: u32 = 10_000;
const JPEG_QUALITY: u8 = 85;
// Decoding and re-encoding dominate every turn of a long conversation, so the
// finished payload is cached by content rather than by path. Sized like Codex's
// prompt image cache: 32 entries, 64 MB of encoded payloads.
const MAX_CACHE_ENTRIES: usize = 32;
const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;

/// Recorded whenever the payload that reaches the provider no longer has the
/// source image's pixels, so the model can be told it is not looking at exact
/// evidence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ResizeInfo {
    pub source: (u32, u32),
    pub prepared: (u32, u32),
}

#[derive(Clone)]
pub(crate) struct EncodedImage {
    pub mime_type: String,
    pub base64: String,
    /// `None` when the original bytes were forwarded unchanged.
    pub resize: Option<ResizeInfo>,
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct CacheKey {
    digest: [u8; 32],
    detail: ImageDetail,
    mime_type: String,
}

struct CacheEntry {
    encoded: EncodedImage,
    tick: u64,
}

#[derive(Default)]
struct ImageCache {
    entries: HashMap<CacheKey, CacheEntry>,
    bytes: usize,
    tick: u64,
}

static ENCODED_IMAGES: OnceLock<Mutex<ImageCache>> = OnceLock::new();

fn cache() -> &'static Mutex<ImageCache> {
    ENCODED_IMAGES.get_or_init(|| Mutex::new(ImageCache::default()))
}

fn cached(key: &CacheKey) -> Option<EncodedImage> {
    let mut cache = cache().lock().ok()?;
    cache.tick += 1;
    let tick = cache.tick;
    let entry = cache.entries.get_mut(key)?;
    entry.tick = tick;
    Some(entry.encoded.clone())
}

fn remember(key: CacheKey, encoded: &EncodedImage) {
    let bytes = encoded.base64.len();
    if bytes > MAX_CACHE_BYTES {
        return;
    }
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    cache.tick += 1;
    let tick = cache.tick;
    if let Some(replaced) = cache.entries.insert(
        key,
        CacheEntry {
            encoded: encoded.clone(),
            tick,
        },
    ) {
        cache.bytes -= replaced.encoded.base64.len();
    }
    cache.bytes += bytes;
    while cache.bytes > MAX_CACHE_BYTES || cache.entries.len() > MAX_CACHE_ENTRIES {
        let Some(oldest) = cache
            .entries
            .iter()
            .min_by_key(|(_, entry)| entry.tick)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        if let Some(evicted) = cache.entries.remove(&oldest) {
            cache.bytes -= evicted.encoded.base64.len();
        }
    }
}

pub(crate) fn encode_image(image: &ChatImage) -> Result<EncodedImage, ProviderError> {
    encode_image_payload(image).map_err(|error| ProviderError::Attachment {
        path: image.path.clone(),
        detail: error.to_string(),
    })
}

fn encode_image_payload(image: &ChatImage) -> Result<EncodedImage, ProviderError> {
    let bytes = read_image_bytes(Path::new(&image.path))?;
    // Content addressing keeps the cache correct when a file is rewritten in
    // place, and lets identical attachments share one payload.
    let key = CacheKey {
        digest: Sha256::digest(&bytes).into(),
        detail: image.detail,
        mime_type: image.mime_type.clone(),
    };
    if let Some(encoded) = cached(&key) {
        return Ok(encoded);
    }
    let encoded = build_encoded(image, &bytes)?;
    remember(key, &encoded);
    Ok(encoded)
}

fn build_encoded(image: &ChatImage, bytes: &[u8]) -> Result<EncodedImage, ProviderError> {
    let fits = bytes.len() <= MAX_PROVIDER_IMAGE_BYTES;
    if image.detail != ImageDetail::Preview && fits {
        // Full detail is forwarded byte-for-byte: screenshot coordinates and
        // exact-scale inspection must not drift through a re-encode.
        return Ok(passthrough(bytes, &image.mime_type));
    }
    let pixels = decode_static_image(bytes)?;
    let source_format = image::guess_format(bytes).map_err(invalid)?;
    let target = if image.detail == ImageDetail::Preview {
        image
            .detail
            .target_dimensions(pixels.width(), pixels.height())
    } else {
        prompt_image_dimensions(
            pixels.width(),
            pixels.height(),
            ORIGINAL_MAX_DIMENSION,
            ORIGINAL_MAX_PATCHES,
        )
    };
    let source = (pixels.width(), pixels.height());
    let resized = target != source;
    if !resized && fits {
        return Ok(passthrough(bytes, &image.mime_type));
    }
    let reduced = if resized {
        pixels.resize_exact(target.0, target.1, image::imageops::FilterType::Triangle)
    } else {
        pixels
    };
    encode_within_provider_limit(
        &reduced,
        source_format,
        resized.then_some(ResizeInfo {
            source,
            prepared: target,
        }),
    )
}

fn passthrough(bytes: &[u8], mime_type: &str) -> EncodedImage {
    EncodedImage {
        mime_type: mime_type.to_owned(),
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        resize: None,
    }
}

/// Shrink by longest edge, then by patch budget. Mirrors the geometry Codex
/// applies to prompt images so the same source yields the same pixels.
fn prompt_image_dimensions(
    width: u32,
    height: u32,
    max_dimension: u32,
    max_patches: u32,
) -> (u32, u32) {
    let width = width.max(1);
    let height = height.max(1);
    if dimensions_fit(width, height, max_dimension, max_patches) {
        return (width, height);
    }
    let edge_scale = (f64::from(max_dimension) / f64::from(width.max(height))).min(1.0);
    let shaped = (
        ((f64::from(width) * edge_scale).round() as u32).max(1),
        ((f64::from(height) * edge_scale).round() as u32).max(1),
    );
    if dimensions_fit(shaped.0, shaped.1, max_dimension, max_patches) {
        return shaped;
    }
    let patch = f64::from(PROMPT_IMAGE_PATCH_SIZE);
    let mut scale =
        (patch * patch * f64::from(max_patches) / f64::from(shaped.0) / f64::from(shaped.1)).sqrt();
    // Shrink by area, then round the scaled patch grid down so integer output
    // dimensions stay within the budget.
    let wide = f64::from(shaped.0) * scale / patch;
    let high = f64::from(shaped.1) * scale / patch;
    scale *= (wide.floor() / wide).min(high.floor() / high);
    (
        ((f64::from(shaped.0) * scale).floor() as u32).max(1),
        ((f64::from(shaped.1) * scale).floor() as u32).max(1),
    )
}

fn dimensions_fit(width: u32, height: u32, max_dimension: u32, max_patches: u32) -> bool {
    let patches = u64::from(width.div_ceil(PROMPT_IMAGE_PATCH_SIZE))
        * u64::from(height.div_ceil(PROMPT_IMAGE_PATCH_SIZE));
    width <= max_dimension && height <= max_dimension && patches <= u64::from(max_patches)
}

/// Encode once in the source format, then degrade to JPEG only if the result
/// still exceeds the provider's per-image block limit. Lossless is preferred
/// so text and flat UI colours survive; JPEG avoids a huge PNG of a photo.
fn encode_within_provider_limit(
    pixels: &image::DynamicImage,
    source_format: ImageFormat,
    resize: Option<ResizeInfo>,
) -> Result<EncodedImage, ProviderError> {
    let mut attempts = Vec::with_capacity(5);
    if source_format != ImageFormat::Jpeg {
        attempts.push(None);
    }
    attempts.extend([Some(JPEG_QUALITY), Some(72), Some(62), Some(52)]);
    for quality in attempts {
        let (bytes, mime_type) = match quality {
            None => encode_png(pixels)?,
            Some(quality) => encode_jpeg(pixels, quality)?,
        };
        if bytes.len() <= MAX_PROVIDER_IMAGE_BYTES {
            let mut encoded = passthrough(&bytes, &mime_type);
            encoded.resize = resize;
            return Ok(encoded);
        }
    }
    Err(ProviderError::Config(format!(
        "image remains larger than {} MB after safe compression",
        MAX_PROVIDER_IMAGE_BYTES / (1024 * 1024)
    )))
}

fn encode_png(pixels: &image::DynamicImage) -> Result<(Vec<u8>, String), ProviderError> {
    let mut output = Cursor::new(Vec::new());
    pixels
        .write_to(&mut output, ImageFormat::Png)
        .map_err(invalid)?;
    Ok((output.into_inner(), "image/png".into()))
}

fn encode_jpeg(
    pixels: &image::DynamicImage,
    quality: u8,
) -> Result<(Vec<u8>, String), ProviderError> {
    let rgb = pixels.to_rgb8();
    let mut output = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut output, quality)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(invalid)?;
    Ok((output, "image/jpeg".into()))
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
        return Err(ProviderError::Config(oversized_message()));
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
        return Err(ProviderError::Config(oversized_message()));
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
        return Err(ProviderError::Config(oversized_message()));
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

fn oversized_message() -> String {
    format!(
        "attached image exceeds {} MB",
        MAX_IMAGE_BYTES / (1024 * 1024)
    )
}

#[cfg(test)]
mod tests;
