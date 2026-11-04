//! Portable true-color image preview: two pixels per terminal cell, original kept intact.
use image::RgbImage;
use ratatui::{layout::Rect, style::Color, Frame};

pub struct ImagePreview {
    image: RgbImage,
    scaled: Option<(Rect, RgbImage)>,
}

impl ImagePreview {
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        let width = u32::try_from(value["width"].as_u64()?).ok()?;
        let height = u32::try_from(value["height"].as_u64()?).ok()?;
        let pixels: Vec<u8> = serde_json::from_value(value["pixels"].clone()).ok()?;
        Some(Self {
            image: RgbImage::from_raw(width, height, pixels)?,
            scaled: None,
        })
    }

    pub fn draw(&mut self, frame: &mut Frame, area: Rect) {
        if area.is_empty() {
            return;
        }
        if self
            .scaled
            .as_ref()
            .is_none_or(|(previous, _)| *previous != area)
        {
            self.scaled = Some((
                area,
                image::imageops::thumbnail(
                    &self.image,
                    u32::from(area.width),
                    u32::from(area.height) * 2,
                ),
            ));
        }
        let image = &self.scaled.as_ref().unwrap().1;
        let left = area.x + (area.width - image.width() as u16) / 2;
        let top = area.y + (area.height - image.height().div_ceil(2) as u16) / 2;
        for y in (0..image.height()).step_by(2) {
            for x in 0..image.width() {
                let a = image.get_pixel(x, y).0;
                let b = image.get_pixel(x, (y + 1).min(image.height() - 1)).0;
                frame.buffer_mut()[(left + x as u16, top + (y / 2) as u16)]
                    .set_symbol("▀")
                    .set_fg(Color::Rgb(a[0], a[1], a[2]))
                    .set_bg(Color::Rgb(b[0], b[1], b[2]));
            }
        }
    }
}
