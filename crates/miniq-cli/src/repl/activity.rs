//! Transient busy indicators driven by the terminal's existing redraw clock.
use super::Status;
use crate::repl::text;
use ratatui::{
    style::{Color, Modifier, Style},
    text::{Line, Span},
};
use std::time::Duration;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn response(status: &Status) -> Option<Line<'static>> {
    if !status.running || status.card.is_some() {
        return None;
    }
    let index = if status.animations {
        (status.elapsed.as_millis() / 80 % SPINNER.len() as u128) as usize
    } else {
        0
    };
    Some(Line::from(vec![
        Span::raw("  "),
        Span::styled(
            format!("{} {}", SPINNER[index], status.phase),
            Style::default()
                .fg(text::ACCENT)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("  {}s", status.elapsed.as_secs()),
            Style::default().fg(text::MUTED),
        ),
    ]))
}

pub fn footer(status: &Status) -> Line<'static> {
    if status.card.is_some() {
        return Line::styled(
            "Waiting for your response",
            Style::default().fg(text::ACCENT),
        );
    }
    if status.running {
        let mut spans = scanner(if status.animations {
            status.elapsed
        } else {
            Duration::ZERO
        });
        spans.push(Span::raw(format!(
            "  {}s  esc interrupt · enter queue · tab steer",
            status.elapsed.as_secs()
        )));
        return Line::from(spans);
    }
    Line::from(match &status.custom {
        Some((custom, true)) => custom.clone(),
        Some((custom, false)) => format!("{}  {custom}", status.cwd),
        None => status.cwd.clone(),
    })
}

// OpenCode's eight-block scanner: 40 ms frames, a fading trail and a pause
// at each end. Shape changes also keep the movement visible with NO_COLOR.
fn scanner(elapsed: Duration) -> Vec<Span<'static>> {
    let frame = (elapsed.as_millis() / 40 % 54) as i32;
    let (head, direction, fade, inactive) = match frame {
        0..=7 => (frame, 1, 0, 0.3 + frame as f32 / 7.0 * 0.7),
        8..=16 => (7, 1, frame - 8, 1.0 - (frame - 8) as f32 / 9.0 * 0.7),
        17..=23 => (23 - frame, -1, 0, 0.3 + (frame - 17) as f32 / 6.0 * 0.7),
        _ => (0, -1, frame - 24, 1.0 - (frame - 24) as f32 / 30.0 * 0.7),
    };
    (0..8)
        .map(|position| {
            let distance = (head - position) * direction;
            let trail = distance + fade;
            let active = distance >= 0 && (0..6).contains(&trail);
            let alpha = if active {
                match trail {
                    0 => 1.0,
                    1 => 0.9,
                    _ => 0.65_f32.powi(trail - 1),
                }
            } else {
                0.6 * inactive
            };
            Span::styled(
                if active { "■" } else { "⬝" },
                Style::default().fg(tint(alpha)),
            )
        })
        .collect()
}

fn tint(alpha: f32) -> Color {
    let Color::Rgb(r, g, b) = text::ACCENT else {
        unreachable!()
    };
    let Color::Rgb(br, bg, bb) = text::BACKGROUND else {
        unreachable!()
    };
    let blend = |fg: u8, bg: u8| (f32::from(bg) + (f32::from(fg) - f32::from(bg)) * alpha) as u8;
    Color::Rgb(blend(r, br), blend(g, bg), blend(b, bb))
}
