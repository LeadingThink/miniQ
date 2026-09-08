use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "miniq",
    version,
    about = "miniQ terminal client. Shares tasks with desktop and mobile.",
    after_help = "Start: miniq configure --base-url https://your-endpoint/v1 --model MODEL\nThen: miniq, miniq exec 'task', or miniq resume --last\nNo desktop window is required. Computer-use still requires an interactive desktop and OS permissions."
)]
pub struct Cli {
    #[arg(long, global = true, env = "MINIQ_DATA_DIR")]
    pub data_dir: Option<PathBuf>,
    #[arg(long, global = true, env = "MINIQ_DAEMON_PATH")]
    pub daemon_path: Option<PathBuf>,
    /// Connect only; do not start a daemon.
    #[arg(long, global = true)]
    pub no_start: bool,
    #[command(flatten)]
    pub chat: ChatOptions,
    #[command(subcommand)]
    pub command: Option<Commands>,
    /// Initial prompt for interactive chat.
    pub prompt: Option<String>,
}

#[derive(Args, Default)]
pub struct ChatOptions {
    /// Project directory. Defaults to the current directory.
    #[arg(short = 'C', long, global = true)]
    pub directory: Option<PathBuf>,
    /// Add a project root, preserving existing roots. Only while project tasks are idle.
    #[arg(long, global = true)]
    pub add_dir: Vec<PathBuf>,
    /// Per-session model; never changes another session's selection.
    #[arg(short, long, global = true)]
    pub model: Option<String>,
    #[arg(long, global = true, value_parser = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"])]
    pub effort: Option<String>,
    #[arg(long, global = true, value_parser = ["auto", "responses", "chat_completions", "anthropic_messages"])]
    pub protocol: Option<String>,
    /// Attach local files (repeatable, at most 10). Paths are resolved before sending.
    #[arg(short = 'a', long = "attach", global = true)]
    pub attachments: Vec<PathBuf>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Run a task without an interactive prompt. Progress goes to stderr; final answer to stdout.
    Exec(ExecArgs),
    /// Resume an existing session, or the most recent session in this project.
    Resume {
        #[arg(required_unless_present = "last", conflicts_with = "last")]
        session: Option<String>,
        #[arg(long)]
        last: bool,
        prompt: Option<String>,
    },
    /// List sessions, scoped to the current project unless --all is supplied.
    Sessions {
        #[arg(long)]
        all: bool,
    },
    /// Page through session history as JSON. Use nextCursor as --before for older records.
    History {
        session: String,
        #[arg(long, default_value_t = 40, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        #[arg(long)]
        before: Option<String>,
    },
    /// Observe a running session without sending or restarting any task.
    Watch {
        session: String,
        #[arg(long)]
        json: bool,
    },
    /// Stop a session and its queued follow-ups/child agents.
    Cancel { session: String },
    /// Configure the shared provider. Key comes from MINIQ_API_KEY or a hidden prompt, never argv.
    Configure {
        #[arg(long)]
        base_url: String,
        #[arg(long)]
        model: String,
    },
    /// Inspect available models, or their advertised capabilities and reasoning efforts.
    Models { model: Option<String> },
    /// Check daemon, provider configuration, visual dependencies and desktop permissions.
    Doctor,
    /// Show the shared provider/permission settings, without keys.
    Status,
    /// Remove the shared saved provider key. Does not cancel running tasks.
    Logout,
    /// Issue an advanced authenticated daemon RPC (MCP, skills, agents, remote settings, etc.).
    Rpc {
        method: String,
        #[arg(default_value = "{}")]
        params: String,
    },
    /// Generate shell completions without connecting to the daemon.
    Completions { shell: clap_complete::Shell },
}

#[derive(Args)]
pub struct ExecArgs {
    /// Task; use - for stdin. Piped stdin with a prompt is additional context.
    pub prompt: Option<String>,
    #[arg(long)]
    pub session: Option<String>,
    /// JSONL: scoped daemon events followed by a terminal CLI result event.
    #[arg(long)]
    pub json: bool,
    #[arg(short = 'o', long)]
    pub output: Option<PathBuf>,
    /// Explicitly use the daemon's configured permissions (including existing session approvals).
    #[arg(long)]
    pub use_configured_permissions: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cli_contracts() {
        for args in [
            vec!["miniq"],
            vec!["miniq", "exec", "-", "--json", "-m", "gpt-5.6-sol"],
            vec!["miniq", "resume", "--last"],
            vec!["miniq", "resume", "sess-1", "continue"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
        assert!(Cli::try_parse_from(["miniq", "resume"]).is_err());
        assert!(Cli::try_parse_from(["miniq", "--effort", "invalid"]).is_err());
        assert!(Cli::try_parse_from(["miniq", "history", "s", "--limit", "101"]).is_err());
    }
}
