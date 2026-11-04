//! Semantic palette remapping keeps every overlay consistent with the selected theme.
use super::{text, Repl};
use ratatui::{style::Color, Frame};

pub fn apply(frame: &mut Frame, theme: &str) {
    if theme != "light" && theme != "system" {
        return;
    }
    for cell in &mut frame.buffer_mut().content {
        if cell.symbol() == "▀" {
            continue;
        }
        if theme == "system" {
            cell.fg = Color::Reset;
            cell.bg = Color::Reset;
            continue;
        }
        cell.fg = light(cell.fg);
        cell.bg = light(cell.bg);
    }
}

fn light(color: Color) -> Color {
    match color {
        text::TEXT => Color::Rgb(28, 32, 40),
        text::BACKGROUND => Color::Rgb(250, 250, 250),
        text::PANEL => Color::Rgb(238, 240, 243),
        text::SELECTED => Color::Rgb(213, 225, 241),
        text::MUTED => Color::Rgb(90, 98, 112),
        text::ACCENT => Color::Rgb(0, 92, 160),
        color => color,
    }
}

impl Repl {
    pub(super) fn save_preferences(&mut self) -> anyhow::Result<()> {
        super::prefs::save_values(
            &self.prefs_dir,
            serde_json::json!({
                "editorMode":self.preferences.editor_mode.as_str(), "theme":self.preferences.theme,
                "animations":self.preferences.animations, "favoriteModels":self.preferences.favorite_models,
                "recentModels":self.preferences.recent_models,
            }),
        )?;
        Ok(())
    }
}
