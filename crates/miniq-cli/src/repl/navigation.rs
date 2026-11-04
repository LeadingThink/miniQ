//! App shortcuts and viewport input, separate from editing the prompt draft.
use super::{
    commands,
    editor::Editor,
    picker::{Outcome, Purpose},
    Card, Repl,
};
use crate::client::Client;
use anyhow::Result;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseEvent, MouseEventKind};

pub enum Flow {
    Ignored,
    Handled,
    Exit(u8),
}
fn flow(code: Option<u8>) -> Flow {
    code.map(Flow::Exit).unwrap_or(Flow::Handled)
}

pub async fn key(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    key: KeyEvent,
) -> Result<Flow> {
    if let Some(picker) = repl.ui.picker.as_mut() {
        return match picker.key(key) {
            Outcome::Close => {
                repl.ui.picker = None;
                Ok(Flow::Handled)
            }
            Outcome::Changed => Ok(Flow::Handled),
            Outcome::Choose(value) => Ok(flow(repl.choose(editor, client, &value).await?)),
        };
    }
    if repl
        .leader
        .take()
        .is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(2))
    {
        let command = match key.code {
            KeyCode::Char('b') => "/sidebar",
            KeyCode::Char('n') => "/new",
            KeyCode::Char('l') => "/sessions",
            KeyCode::Char('m') => "/models",
            KeyCode::Char('s') => "/status",
            KeyCode::Char('y') => "/copy",
            KeyCode::Char('u') => "/undo",
            KeyCode::Char('c') => "/compact",
            KeyCode::Char('q') => "/exit",
            KeyCode::Char('d') => "/details",
            KeyCode::Char('e') => {
                let text = super::runtime::external_editor(repl, editor.buffer())?;
                editor.set_buffer(&text);
                return Ok(Flow::Handled);
            }
            _ => return Ok(Flow::Handled),
        };
        return Ok(flow(commands::run(repl, editor, client, command).await?));
    }
    // Explicit cli.json editor bindings retain precedence over global shortcuts.
    if editor.keymap().lookup(&key).is_none() && key.modifiers == KeyModifiers::CONTROL {
        match key.code {
            KeyCode::Char('p') => {
                repl.open_picker(client, Purpose::Commands).await?;
                return Ok(Flow::Handled);
            }
            KeyCode::Char('o') => {
                repl.open_picker(client, Purpose::Sessions).await?;
                return Ok(Flow::Handled);
            }
            KeyCode::Char('x') => {
                repl.leader = Some(std::time::Instant::now());
                repl.notice =
                    "ctrl+x: n new · l sessions · m models · b sidebar · d tool details · q exit"
                        .into();
                return Ok(Flow::Handled);
            }
            _ => {}
        }
    }
    if key.modifiers == KeyModifiers::ALT && repl.cards.front().is_some() {
        match key.code {
            KeyCode::Up => {
                repl.ui.card_offset = repl.ui.card_offset.saturating_sub(1);
                return Ok(Flow::Handled);
            }
            KeyCode::Down => {
                repl.ui.card_offset += 1;
                return Ok(Flow::Handled);
            }
            _ => {}
        }
    }
    match key.code {
        KeyCode::PageUp if key.modifiers == KeyModifiers::ALT => {
            repl.ui.sidebar_offset = repl.ui.sidebar_offset.saturating_sub(6);
            return Ok(Flow::Handled);
        }
        KeyCode::PageDown if key.modifiers == KeyModifiers::ALT => {
            repl.ui.sidebar_offset = repl.ui.sidebar_offset.saturating_add(6);
            return Ok(Flow::Handled);
        }
        KeyCode::PageUp => {
            scroll(repl, client, -(repl.ui.page_height.max(2) as isize - 1)).await?;
            return Ok(Flow::Handled);
        }
        KeyCode::PageDown => {
            repl.ui.scroll_by(repl.ui.page_height.max(2) as isize - 1);
            return Ok(Flow::Handled);
        }
        KeyCode::Home if key.modifiers == KeyModifiers::CONTROL => {
            repl.ui.scroll = Some(0);
            if repl.ui.transcript.next_cursor.is_some() {
                repl.earlier(client).await?;
            }
            return Ok(Flow::Handled);
        }
        KeyCode::End if key.modifiers == KeyModifiers::CONTROL => {
            repl.ui.scroll = None;
            return Ok(Flow::Handled);
        }
        _ => {}
    }
    if editor.is_empty() && key.modifiers.is_empty() {
        let choices = match repl.cards.front() {
            Some(Card::Approval { .. }) => 4,
            Some(Card::Question {
                options,
                multi_select: false,
                ..
            }) => options.len(),
            _ => 0,
        };
        if choices > 0 {
            match key.code {
                KeyCode::Left => {
                    repl.ui.card_selected = (repl.ui.card_selected + choices - 1) % choices
                }
                KeyCode::Right => repl.ui.card_selected = (repl.ui.card_selected + 1) % choices,
                KeyCode::Enter => {
                    let answer = (repl.ui.card_selected + 1).to_string();
                    repl.resolve(client, &answer).await?;
                    repl.ui.card_selected = 0;
                }
                _ => return Ok(Flow::Ignored),
            }
            return Ok(Flow::Handled);
        }
    }
    Ok(Flow::Ignored)
}

async fn scroll(repl: &mut Repl, client: &mut Client, amount: isize) -> Result<()> {
    repl.ui.scroll_by(amount);
    let top = repl
        .ui
        .scroll
        .unwrap_or(repl.ui.total.saturating_sub(repl.ui.page_height));
    if amount < 0 && top == 0 && repl.ui.transcript.next_cursor.is_some() {
        repl.earlier(client).await?;
    }
    Ok(())
}

pub async fn mouse(
    repl: &mut Repl,
    editor: &mut Editor,
    client: &mut Client,
    event: MouseEvent,
) -> Result<Option<u8>> {
    if let Some(picker) = repl.ui.picker.as_mut() {
        match event.kind {
            MouseEventKind::ScrollUp => {
                picker.key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
            }
            MouseEventKind::ScrollDown => {
                picker.key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
            }
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                if let Some(value) = picker.click(event.column, event.row) {
                    return repl.choose(editor, client, &value).await;
                }
            }
            _ => {}
        }
        return Ok(None);
    }
    if repl
        .ui
        .sidebar_area
        .contains((event.column, event.row).into())
    {
        match event.kind {
            MouseEventKind::ScrollUp => {
                repl.ui.sidebar_offset = repl.ui.sidebar_offset.saturating_sub(3)
            }
            MouseEventKind::ScrollDown => {
                repl.ui.sidebar_offset = repl.ui.sidebar_offset.saturating_add(3)
            }
            _ => {}
        }
        return Ok(None);
    }
    match event.kind {
        MouseEventKind::ScrollUp => scroll(repl, client, -3).await?,
        MouseEventKind::ScrollDown => repl.ui.scroll_by(3),
        _ => {}
    }
    Ok(None)
}
