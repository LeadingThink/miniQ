//! One owner restores terminal modes on normal exit, errors and unwinding.
#[cfg(unix)]
use crossterm::event::{
    KeyboardEnhancementFlags, PopKeyboardEnhancementFlags, PushKeyboardEnhancementFlags,
};
use crossterm::{
    cursor,
    event::{DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture},
    terminal,
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::io;

pub struct Surface {
    pub terminal: Terminal<CrosstermBackend<io::Stdout>>,
    active: bool,
}

impl Surface {
    pub fn enter() -> io::Result<Self> {
        let mut surface = Self {
            terminal: Terminal::new(CrosstermBackend::new(io::stdout()))?,
            active: false,
        };
        terminal::enable_raw_mode()?;
        surface.active = true;
        crossterm::execute!(
            io::stdout(),
            terminal::EnterAlternateScreen,
            EnableBracketedPaste,
            EnableMouseCapture
        )?;
        #[cfg(unix)]
        crossterm::execute!(
            io::stdout(),
            PushKeyboardEnhancementFlags(KeyboardEnhancementFlags::DISAMBIGUATE_ESCAPE_CODES)
        )?;
        surface.terminal.clear()?;
        Ok(surface)
    }
}

impl Drop for Surface {
    fn drop(&mut self) {
        if self.active {
            #[cfg(unix)]
            let _ = crossterm::execute!(io::stdout(), PopKeyboardEnhancementFlags);
            let _ = crossterm::execute!(
                io::stdout(),
                DisableMouseCapture,
                DisableBracketedPaste,
                cursor::Show,
                terminal::LeaveAlternateScreen
            );
            let _ = terminal::disable_raw_mode();
        }
    }
}
