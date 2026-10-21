//! Explicit consent for a prompt competing with an existing task.

use std::io::{self, BufRead, IsTerminal, Write};

use anyhow::Result;
use clap::ValueEnum;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, ValueEnum)]
pub enum BusyPolicy {
    #[default]
    Reject,
    Queue,
    Stop,
}

/// None means keep the existing task and leave the new prompt unsent.
pub fn choose() -> Result<Option<BusyPolicy>> {
    if !interactive() {
        return Ok(Some(BusyPolicy::Reject));
    }
    choose_with(&mut io::stdin().lock(), &mut io::stderr().lock())
}

pub fn interactive() -> bool {
    io::stdin().is_terminal() && io::stderr().is_terminal()
}

fn choose_with(input: &mut impl BufRead, output: &mut impl Write) -> Result<Option<BusyPolicy>> {
    writeln!(output, "This session already has a task running.")?;
    writeln!(output, "  1. Queue this prompt after it")?;
    writeln!(
        output,
        "  2. Stop this session's task and queued follow-ups, then send"
    )?;
    writeln!(output, "  3. Return without sending (default)")?;
    loop {
        write!(output, "Choose [1/2/3]: ")?;
        output.flush()?;
        let mut line = String::new();
        if input.read_line(&mut line)? == 0 {
            return Ok(None);
        }
        match line.trim() {
            "1" => return Ok(Some(BusyPolicy::Queue)),
            "2" => return Ok(Some(BusyPolicy::Stop)),
            "" | "3" => return Ok(None),
            _ => writeln!(output, "Enter 1, 2 or 3; no task has been stopped.")?,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_eof_and_invalid_choices_never_authorize_stop() {
        for input in ["", "\n", "3\n", "yes\n", "stop\n\n"] {
            assert_eq!(
                choose_with(&mut input.as_bytes(), &mut Vec::new()).unwrap(),
                None
            );
        }
        for (input, expected) in [("1\n", BusyPolicy::Queue), ("2\n", BusyPolicy::Stop)] {
            assert_eq!(
                choose_with(&mut input.as_bytes(), &mut Vec::new()).unwrap(),
                Some(expected)
            );
        }
    }
}
