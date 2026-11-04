//! Styled terminal text and cell-aware wrapping shared by all full-screen views.
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub const BACKGROUND: Color = Color::Rgb(20, 20, 20);
pub const PANEL: Color = Color::Rgb(30, 30, 30);
pub const TEXT: Color = Color::Rgb(238, 238, 238);
pub const MUTED: Color = Color::Rgb(145, 145, 145);
pub const ACCENT: Color = Color::Rgb(250, 178, 131);
pub const SELECTED: Color = Color::Rgb(48, 48, 48);
pub const SUCCESS: Color = Color::Rgb(127, 190, 137);

/// Decode only the SGR styles emitted by our renderer. Other escape sequences
/// are never executed; untrusted content is sanitized at its input boundary.
pub fn styled(text: &str) -> Vec<Line<'static>> {
    let mut style = Style::default();
    text.split('\n')
        .map(|line| {
            let mut spans = Vec::new();
            let mut rest = line;
            while let Some(start) = rest.find("\x1b[") {
                if start > 0 {
                    spans.push(Span::styled(rest[..start].to_owned(), style));
                }
                let after = &rest[start + 2..];
                let Some(end) = after.find('m') else { break };
                for code in after[..end].split(';') {
                    style = match code {
                        "0" | "" => Style::default(),
                        "1" => style.add_modifier(Modifier::BOLD),
                        "2" => style.fg(MUTED),
                        "3" => style.add_modifier(Modifier::ITALIC),
                        "31" => style.fg(Color::Rgb(235, 111, 111)),
                        "32" => style.fg(SUCCESS),
                        "33" => style.fg(ACCENT),
                        "36" => style.fg(Color::Rgb(125, 207, 255)),
                        "35" => style.fg(Color::Rgb(187, 154, 247)),
                        _ => style,
                    };
                }
                rest = &after[end + 1..];
            }
            if !rest.is_empty() {
                spans.push(Span::styled(rest.to_owned(), style));
            }
            Line::from(spans)
        })
        .collect()
}

/// Wrap for a viewport, retaining every grapheme and style. No ellipsis or data
/// cap: callers page the resulting rows, and resizing reflows the same content.
pub fn wrap(lines: &[Line<'static>], width: usize) -> Vec<Line<'static>> {
    let width = width.max(1);
    let mut result = Vec::new();
    for line in lines {
        let mut row = Line::default().style(line.style);
        let mut column = 0;
        for span in &line.spans {
            let mut segment = String::new();
            for grapheme in span.content.graphemes(true) {
                let cells = grapheme.width();
                if column > 0 && column + cells > width {
                    if !segment.is_empty() {
                        row.spans
                            .push(Span::styled(std::mem::take(&mut segment), span.style));
                    }
                    result.push(row);
                    row = Line::default().style(line.style);
                    column = 0;
                }
                segment.push_str(grapheme);
                column += cells;
            }
            if !segment.is_empty() {
                row.spans.push(Span::styled(segment, span.style));
            }
        }
        result.push(row);
    }
    result
}

pub fn input(view: &super::editor::View, width: usize) -> (Vec<Line<'static>>, (usize, usize)) {
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut cursor = (0, 0);
    for (index, line) in view.lines.iter().enumerate() {
        let mut row = String::new();
        let mut column = 0;
        let mut original = 0;
        for grapheme in line.graphemes(true) {
            let cells = grapheme.width();
            if column > 0 && column + cells > width {
                rows.push(Line::raw(std::mem::take(&mut row)));
                column = 0;
            }
            if index == view.cursor.0 && original == view.cursor.1 {
                cursor = (rows.len(), column);
            }
            row.push_str(grapheme);
            column += cells;
            original += cells;
        }
        if index == view.cursor.0 && original == view.cursor.1 {
            if column >= width {
                rows.push(Line::raw(std::mem::take(&mut row)));
                column = 0;
            }
            cursor = (rows.len(), column);
        }
        rows.push(Line::raw(row));
    }
    (rows, cursor)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wraps_without_losing_unicode_or_styles() {
        let input = "中文e\u{301}👩‍💻0123456789";
        let rows = wrap(
            &[Line::from(Span::styled(input, Style::default().fg(ACCENT)))],
            5,
        );
        let joined: String = rows
            .iter()
            .flat_map(|l| &l.spans)
            .map(|s| s.content.as_ref())
            .collect();
        assert_eq!(joined, input);
        assert!(rows.iter().all(|line| line.width() <= 5));
        assert!(rows
            .iter()
            .flat_map(|l| &l.spans)
            .all(|s| s.style.fg == Some(ACCENT)));
    }
    #[test]
    fn caret_tracks_cjk_wrap_and_exact_width() {
        let view = super::super::editor::View {
            lines: vec!["abc中d".into()],
            cursor: (0, 5),
        };
        let (_, caret) = input(&view, 4);
        assert_eq!(caret, (1, 2));
        let view = super::super::editor::View {
            lines: vec!["abcd".into()],
            cursor: (0, 4),
        };
        let (rows, caret) = input(&view, 4);
        assert_eq!(caret, (1, 0));
        assert_eq!(rows.len(), 2);
    }
}
