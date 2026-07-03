//! miniq-sandbox: workspace path constraints and command risk grading.
//!
//! This crate only decides *whether and how risky* an operation is. It never
//! executes anything and never persists anything.

mod command;
mod paths;

pub use command::{classify_command, Risk};
pub use paths::{resolve_in_workspace, PathError};
