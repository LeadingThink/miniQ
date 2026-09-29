use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

const SHORT_HELP: &str = "\
Start:     miniq                      (first launch guides API Key and model setup)
Sessions:  miniq sessions · miniq resume --last · miniq history ID · miniq watch ID
Scripts:   miniq exec 'task' · echo task | miniq exec -
Run `miniq --help` for the full quick reference, or `miniq help COMMAND` for examples.";

const LONG_HELP: &str = "\
Get started:
  miniq                          Interactive chat in the current directory's project
  miniq \"Review this repo\"       Start interactive chat with a first prompt
  miniq -C /path/to/project      Use another project directory
  miniq doctor                   Check daemon, provider, dependencies and permissions
  miniq configure                Re-run API Key / model setup

Find sessions:
  miniq sessions                 Sessions in the current project (title, status, updated, ID)
  miniq sessions --all           Sessions across all projects
  miniq -C /path/to/project sessions
  miniq sessions --all | jq '.sessions[] | {id, title, status, updatedAt}'

Work with a session (use an ID from `miniq sessions`):
  miniq history SESSION_ID --limit 40   Read recent messages (JSON; page with --before)
  miniq watch SESSION_ID                Follow a running session without sending anything
  miniq resume SESSION_ID               Continue a session
  miniq resume                          Pick a session in this project interactively
  miniq resume --last                   Continue this project's most recent session
  miniq cancel SESSION_ID               Stop a session's running task

Scripting:
  miniq exec \"Summarize CHANGELOG.md\"   Final answer on stdout, progress on stderr
  git diff | miniq exec \"Review this diff\"
  miniq exec - < task.md -o answer.md
  miniq exec --json \"task\"              JSONL events for automation

Maintenance:
  miniq update [--check] · miniq status · miniq models · miniq logout
  miniq completions zsh > ~/.zfunc/_miniq

Good to know:
  - Without --all, only sessions of the current working directory's project are listed.
  - The `miniq resume` picker hides archived and imported (external) sessions;
    `miniq sessions` lists them and marks them.
  - Terminal, desktop and phone share sessions when they use the same daemon data directory.
  - Over SSH, `miniq sessions` shows that computer's sessions. The same API Key does not
    merge local sessions from different computers.
  - To view them from the phone, first select the matching remote desktop or SSH host.
  - Inside a chat, type /help for slash commands (/model, /effort, /attach, /history, /exit).

Full guide: https://github.com/LeadingThink/miniQ/blob/main/docs/terminal.md";

#[derive(Parser)]
#[command(
    name = "miniq",
    version,
    about = "miniQ terminal client. Shares tasks with desktop and mobile.",
    after_help = SHORT_HELP,
    after_long_help = LONG_HELP
)]
pub struct Cli {
    /// Daemon data directory shared with desktop. Defaults to the platform data dir.
    #[arg(long, global = true, env = "MINIQ_DATA_DIR", value_name = "DIR")]
    pub data_dir: Option<PathBuf>,
    /// Path to the miniq-daemon binary used when starting a daemon.
    #[arg(long, global = true, env = "MINIQ_DAEMON_PATH", value_name = "PATH")]
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
    #[arg(short = 'C', long, global = true, value_name = "DIR")]
    pub directory: Option<PathBuf>,
    /// Add a project root, preserving existing roots. Only while project tasks are idle.
    #[arg(long, global = true, value_name = "DIR")]
    pub add_dir: Vec<PathBuf>,
    /// Per-session model; never changes another session's selection. See `miniq models`.
    #[arg(short, long, global = true)]
    pub model: Option<String>,
    /// Reasoning effort for this session; `default` clears the override.
    #[arg(long, global = true, value_parser = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "default"])]
    pub effort: Option<String>,
    /// Provider API protocol. `auto` keeps miniQ's OneAPI discovery.
    #[arg(long, global = true, value_parser = ["auto", "responses", "chat_completions", "anthropic_messages"])]
    pub protocol: Option<String>,
    /// Attach local files (repeatable, at most 10). Paths are resolved before sending.
    #[arg(short = 'a', long = "attach", global = true, value_name = "FILE")]
    pub attachments: Vec<PathBuf>,
}

#[derive(Subcommand)]
pub enum Commands {
    /// Run a task without an interactive prompt. Progress goes to stderr; final answer to stdout.
    #[command(
        after_help = "Examples:\n  miniq exec \"Summarize CHANGELOG.md\"\n  git diff | miniq exec \"Review this diff\"\n  miniq exec - < task.md -o answer.md\n  miniq exec --session SESSION_ID \"Follow up on the last result\"\n  miniq exec --json \"task\" | jq -c 'select(.type == \"cli_result\")'\n\nBy default exec runs only when the effective approvalMode is alwaysAsk (tool approvals\nare not granted unattended). --use-configured-permissions accepts the configured mode."
    )]
    Exec(ExecArgs),
    /// Continue a session: pick one in this project, supply its ID, or use --last.
    #[command(
        after_help = "Examples:\n  miniq resume                      Searchable picker for this project's sessions\n  miniq resume --last               Most recently updated session in this project\n  miniq resume SESSION_ID           Continue a specific session (IDs: miniq sessions)\n  miniq resume SESSION_ID \"Continue from the verified results\"\n\nThe picker hides archived and imported sessions; imported sessions cannot be resumed.\nResuming reuses saved context; it does not resend the earlier task."
    )]
    Resume {
        /// Session ID from `miniq sessions`. Omit to pick interactively.
        #[arg(conflicts_with = "last", value_name = "SESSION_ID")]
        session: Option<String>,
        /// Resume this project's most recent non-archived local session.
        #[arg(long)]
        last: bool,
        /// Message to send immediately after resuming.
        prompt: Option<String>,
    },
    /// List sessions with title, status, last update and ID.
    #[command(
        after_help = "Examples:\n  miniq sessions                    Current project only\n  miniq sessions --all              All projects\n  miniq -C /path/to/project sessions\n  miniq sessions --all | jq '.sessions[] | {id, title, status, updatedAt}'\n\nIn a terminal the list is human-readable; when piped (or with --json) it prints JSON.\nArchived and imported sessions are marked; `miniq resume` hides them.\nNext: miniq history SESSION_ID · miniq watch SESSION_ID · miniq resume SESSION_ID"
    )]
    Sessions {
        /// Include sessions from every project, not only the current directory's.
        #[arg(long)]
        all: bool,
        /// Always print JSON, even in an interactive terminal.
        #[arg(long)]
        json: bool,
    },
    /// Page through session history as JSON. Use nextCursor as --before for older records.
    #[command(
        after_help = "Examples:\n  miniq history SESSION_ID\n  miniq history SESSION_ID --limit 100\n  miniq history SESSION_ID --before '<nextCursor from the previous page>'"
    )]
    History {
        /// Session ID from `miniq sessions`.
        #[arg(value_name = "SESSION_ID")]
        session: String,
        /// Records per page (1-100).
        #[arg(long, default_value_t = 40, value_parser = clap::value_parser!(u32).range(1..=100))]
        limit: u32,
        /// Cursor (the previous page's nextCursor JSON) to read older records.
        #[arg(long, value_name = "CURSOR")]
        before: Option<String>,
    },
    /// Observe a running session without sending or restarting any task.
    #[command(
        after_help = "Examples:\n  miniq watch SESSION_ID\n  miniq watch SESSION_ID --json\n\nCtrl+C detaches without cancelling. To stop the task: miniq cancel SESSION_ID"
    )]
    Watch {
        /// Session ID from `miniq sessions`.
        #[arg(value_name = "SESSION_ID")]
        session: String,
        /// Emit JSONL events instead of readable progress.
        #[arg(long)]
        json: bool,
    },
    /// Stop a session and its queued follow-ups/child agents.
    Cancel {
        /// Session ID from `miniq sessions`.
        #[arg(value_name = "SESSION_ID")]
        session: String,
    },
    /// Guided provider setup. Defaults to OneAPI; Key is read from a hidden prompt or MINIQ_API_KEY.
    #[command(
        after_help = "Examples:\n  miniq configure\n  miniq configure --model MODEL\n  MINIQ_API_KEY=... miniq configure --base-url https://oneapi.zaiwenai.com/v1\n\nNever pass a key as a command-line argument."
    )]
    Configure {
        /// Provider base URL. Keeps the saved endpoint when omitted.
        #[arg(long)]
        base_url: Option<String>,
        /// Default text model.
        #[arg(long)]
        model: Option<String>,
    },
    /// Inspect available models, or their advertised capabilities and reasoning efforts.
    Models {
        /// Model ID to describe. Omit to list all text models.
        model: Option<String>,
    },
    /// Check daemon, provider configuration, visual dependencies and desktop permissions.
    Doctor,
    /// Show the shared provider/permission settings, without keys.
    Status,
    /// Remove the shared saved provider key. Does not cancel running tasks.
    Logout,
    /// Issue an advanced authenticated daemon RPC (MCP, skills, agents, remote settings, etc.).
    #[command(
        after_help = "Examples:\n  miniq rpc daemon.health\n  miniq rpc session.list '{\"workspaceId\":null}'\n  echo '{}' | miniq rpc settings.get -"
    )]
    Rpc {
        /// Method name, for example session.list.
        method: String,
        /// JSON params, or - to read them from stdin.
        #[arg(default_value = "{}")]
        params: String,
    },
    /// Authenticated JSONL stdio transport for desktop SSH connections. EOF detaches only.
    #[command(hide = true)]
    Bridge,
    /// Generate shell completions without connecting to the daemon.
    #[command(
        after_help = "Examples:\n  miniq completions zsh > ~/.zfunc/_miniq\n  miniq completions bash > ~/.local/share/bash-completion/completions/miniq\n  miniq completions fish > ~/.config/fish/completions/miniq.fish"
    )]
    Completions { shell: clap_complete::Shell },
    /// Update the terminal binaries without interrupting running desktop or terminal tasks.
    Update {
        /// Check for a new version without installing it.
        #[arg(long)]
        check: bool,
    },
}

#[derive(Args)]
pub struct ExecArgs {
    /// Task; use - for stdin. Piped stdin with a prompt is additional context.
    pub prompt: Option<String>,
    /// Continue an existing session instead of creating a new one.
    #[arg(long, value_name = "SESSION_ID")]
    pub session: Option<String>,
    /// JSONL: scoped daemon events followed by a terminal CLI result event.
    #[arg(long)]
    pub json: bool,
    /// Also write the final answer to a new file (refuses to overwrite).
    #[arg(short = 'o', long, value_name = "FILE")]
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
            vec!["miniq", "resume"],
            vec!["miniq", "resume", "sess-1", "continue"],
            vec!["miniq", "bridge", "--no-start"],
            vec!["miniq", "configure"],
            vec!["miniq", "update", "--check"],
            vec!["miniq", "sessions", "--all", "--json"],
            vec!["miniq", "-C", "/tmp", "sessions"],
        ] {
            assert!(Cli::try_parse_from(args).is_ok());
        }
        assert!(Cli::try_parse_from(["miniq", "resume", "sess-1", "--last"]).is_err());
        assert!(Cli::try_parse_from(["miniq", "--effort", "invalid"]).is_err());
        assert!(Cli::try_parse_from(["miniq", "history", "s", "--limit", "101"]).is_err());
        let configured =
            Cli::try_parse_from(["miniq", "configure", "--model", "custom-model"]).unwrap();
        assert!(
            matches!(configured.command, Some(Commands::Configure { model: Some(model), base_url: None }) if model == "custom-model")
        );
    }

    #[test]
    fn help_documents_session_workflow() {
        use clap::CommandFactory;
        let long = Cli::command().render_long_help().to_string();
        for needle in [
            "miniq sessions --all",
            "miniq -C /path/to/project sessions",
            "miniq history SESSION_ID --limit 40",
            "miniq watch SESSION_ID",
            "miniq resume SESSION_ID",
            "miniq resume --last",
            "jq '.sessions[] | {id, title, status, updatedAt}'",
            "hides archived and imported",
            "Over SSH",
        ] {
            assert!(long.contains(needle), "--help is missing {needle}");
        }
        let short = Cli::command().render_help().to_string();
        assert!(short.contains("miniq sessions") && short.contains("miniq --help"));
        assert!(!short.contains("bridge"));
        let mut cli = Cli::command();
        let sessions = cli
            .find_subcommand_mut("sessions")
            .unwrap()
            .render_help()
            .to_string();
        assert!(sessions.contains("--json") && sessions.contains("Next: miniq history"));
    }
}
