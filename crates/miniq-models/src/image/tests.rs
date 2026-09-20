use super::*;

fn attachment(path: &Path, detail: ImageDetail) -> ChatImage {
    ChatImage {
        path: path.to_string_lossy().into_owned(),
        mime_type: "image/png".into(),
        detail,
    }
}

fn decoded_bytes(encoded: &EncodedImage) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD
        .decode(&encoded.base64)
        .unwrap()
}

#[test]
fn preview_fits_both_pixel_and_dimension_budgets_without_upscaling() {
    for (width, height) in [
        (3200, 2400),
        (2400, 3200),
        (4096, 4096),
        (9000, 250),
        (1, 10000),
    ] {
        let (w, h) = ImageDetail::Preview.target_dimensions(width, height);
        assert!(w <= 2048 && h <= 2048);
        assert!(u64::from(w) * u64::from(h) <= 2_500_000);
        assert!(w <= width && h <= height);
        let expected_height = f64::from(height) * f64::from(w) / f64::from(width);
        // At most one rounded source-pixel step on each scaled dimension.
        assert!(
            (expected_height - f64::from(h)).abs() <= 1.0 + f64::from(height) / f64::from(width)
        );
    }
    assert_eq!(ImageDetail::Preview.target_dimensions(100, 50), (100, 50));
    assert_eq!(
        ImageDetail::High.target_dimensions(9000, 4000),
        (9000, 4000)
    );
    assert_eq!(
        ImageDetail::Auto.target_dimensions(9000, 4000),
        (9000, 4000)
    );
}

#[test]
fn large_preview_has_reported_dimensions_and_keeps_original_snapshot_intact() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scan.png");
    image::RgbImage::from_pixel(3200, 2400, image::Rgb([15, 100, 210]))
        .save(&path)
        .unwrap();
    let original = std::fs::read(&path).unwrap();
    let encoded = encode_image(&attachment(&path, ImageDetail::Preview)).unwrap();
    let sent = image::load_from_memory(&decoded_bytes(&encoded)).unwrap();
    assert_eq!(
        (sent.width(), sent.height()),
        ImageDetail::Preview.target_dimensions(3200, 2400)
    );
    assert_eq!(encoded.mime_type, "image/png");
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn small_preview_preserves_png_and_jpeg_bytes_exactly() {
    let dir = tempfile::tempdir().unwrap();
    for (name, format, mime) in [
        ("small.png", ImageFormat::Png, "image/png"),
        ("small.jpg", ImageFormat::Jpeg, "image/jpeg"),
    ] {
        let path = dir.path().join(name);
        image::RgbImage::from_pixel(120, 80, image::Rgb([15, 100, 210]))
            .save_with_format(&path, format)
            .unwrap();
        let original = std::fs::read(&path).unwrap();
        let mut attached = attachment(&path, ImageDetail::Preview);
        attached.mime_type = mime.into();
        let encoded = encode_image(&attached).unwrap();
        assert_eq!(decoded_bytes(&encoded), original);
        assert_eq!(encoded.mime_type, mime);
    }
}

#[test]
fn original_and_auto_preserve_large_coordinate_sensitive_screenshots_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("screen.png");
    image::RgbImage::from_pixel(3200, 2400, image::Rgb([12, 18, 37]))
        .save(&path)
        .unwrap();
    let original = std::fs::read(&path).unwrap();
    for detail in [ImageDetail::High, ImageDetail::Auto] {
        let encoded = encode_image(&attachment(&path, detail)).unwrap();
        assert_eq!(decoded_bytes(&encoded), original);
        let sent = image::load_from_memory(&decoded_bytes(&encoded)).unwrap();
        assert_eq!((sent.width(), sent.height()), (3200, 2400));
    }
}

#[test]
fn preview_rejects_animated_gif_even_when_small() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("animated.gif");
    let mut bytes = Vec::new();
    {
        let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
        for _ in 0..2 {
            encoder
                .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
                .unwrap();
        }
    }
    std::fs::write(&path, bytes).unwrap();
    let error = encode_image(&attachment(&path, ImageDetail::Preview))
        .err()
        .unwrap();
    assert!(error.to_string().contains("animated image"), "{error}");
}

#[test]
fn enormous_gif_canvas_fails_before_allocation() {
    let mut bytes = Vec::new();
    image::codecs::gif::GifEncoder::new(&mut bytes)
        .encode_frame(image::Frame::new(image::RgbaImage::new(2, 2)))
        .unwrap();
    bytes[6..10].copy_from_slice(&[255, 255, 255, 255]);
    let error = decode_static_image(&bytes).unwrap_err();
    assert!(error.to_string().contains("limit"), "{error}");
}

#[test]
fn unreadable_nonregular_and_oversized_paths_fail_validation_and_encoding() {
    let dir = tempfile::tempdir().unwrap();
    let large = dir.path().join("too-large.png");
    std::fs::File::create(&large)
        .unwrap()
        .set_len(MAX_IMAGE_BYTES + 1)
        .unwrap();
    for path in [dir.path().to_owned(), large, dir.path().join("missing.png")] {
        let attached = attachment(&path, ImageDetail::High);
        assert!(validate_image_path(&attached).is_err());
        assert!(encode_image(&attached).is_err());
    }
}

#[cfg(unix)]
#[test]
fn symlinked_image_cannot_escape_an_original_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("private.png");
    let link = dir.path().join("swapped.png");
    std::fs::write(&original, b"private").unwrap();
    std::os::unix::fs::symlink(&original, &link).unwrap();
    let attached = attachment(&link, ImageDetail::High);
    assert!(validate_image_path(&attached).is_err());
    assert!(encode_image(&attached).is_err());
    assert!(load_static_image(&link).is_err());
}

#[test]
fn preview_is_persisted_as_a_local_policy_and_never_sent_as_a_wire_detail() {
    assert_eq!(
        serde_json::to_string(&ImageDetail::Preview).unwrap(),
        "\"preview\""
    );
    assert_eq!(ImageDetail::Preview.wire_detail(), "high");
    assert_eq!(ImageDetail::High.wire_detail(), "high");
    assert_eq!(ImageDetail::Auto.wire_detail(), "auto");
}
