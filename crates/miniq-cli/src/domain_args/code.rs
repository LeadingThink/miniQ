use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum GitCommand {
    /// Repository status for SESSION.
    Status { session: String },
    /// Full diff of PATH; use --staged for the index.
    Diff {
        session: String,
        path: String,
        #[arg(long)]
        staged: bool,
    },
}

#[derive(Debug, Subcommand)]
pub enum TerminalCommand {
    /// Open a PTY in a session's working directory.
    Create {
        session: String,
        #[arg(long, default_value_t = 24, value_parser = clap::value_parser!(u16).range(1..=1000))]
        rows: u16,
        #[arg(long, default_value_t = 80, value_parser = clap::value_parser!(u16).range(1..=1000))]
        cols: u16,
    },
    /// Read an output chunk. Continue from the returned next offset.
    Read {
        session: String,
        terminal: String,
        #[arg(long)]
        offset: Option<u64>,
        #[arg(long, default_value_t = 0, value_parser = clap::value_parser!(u64).range(0..=30_000))]
        wait_ms: u64,
    },
    /// Send exact text (or - for stdin); a newline is sent only when present in the input.
    Input {
        session: String,
        terminal: String,
        data: String,
    },
    /// Change the PTY dimensions.
    Resize {
        session: String,
        terminal: String,
        #[arg(value_parser = clap::value_parser!(u16).range(1..=1000))]
        rows: u16,
        #[arg(value_parser = clap::value_parser!(u16).range(1..=1000))]
        cols: u16,
    },
    /// Close this PTY.
    Close { session: String, terminal: String },
}

#[derive(Debug, Subcommand)]
pub enum FileCommand {
    /// List one complete page; pass its nextCursor to --after for the next page.
    List {
        session: String,
        #[arg(default_value = "")]
        path: String,
        #[arg(long)]
        after: Option<String>,
    },
    /// Inspect metadata and obtain the current revision for read.
    Describe { session: String, path: String },
    /// Read one complete chunk; pass the returned offset to continue the same revision.
    Read {
        session: String,
        path: String,
        #[arg(long)]
        revision: String,
        #[arg(long, default_value_t = 0)]
        offset: u64,
    },
}

#[derive(Debug, Subcommand)]
pub enum ToolCommand {
    /// List available tools with their schemas.
    List,
    /// Full persisted input and output for a tool call in SESSION.
    Detail { session: String, tool_call: String },
}

#[derive(Debug, Subcommand)]
pub enum VoiceCommand {
    /// Discover available recognition and speech models.
    Capabilities,
    /// Transcribe JSON containing audioBase64, filename, optional preview/transcribeModel.
    #[command(after_help = "Example: miniq voice transcribe @audio-request.json")]
    Transcribe(super::JsonInput),
    /// Synthesize JSON containing text and optional voice/responseFormat. Returns complete audio data.
    #[command(after_help = "Example: miniq voice speak '{\"text\":\"Hello\"}'")]
    Speak(super::JsonInput),
}

#[derive(Debug, Subcommand)]
pub enum ComputerCommand {
    /// Inspect current permissions without prompting.
    Permissions,
    /// Request an OS permission; the OS may open its own settings UI.
    Request {
        #[arg(value_parser = ["screenRecording", "accessibility"])]
        permission: String,
    },
}
