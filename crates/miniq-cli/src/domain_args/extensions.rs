use super::JsonInput;
use clap::Subcommand;

#[derive(Debug, Subcommand)]
pub enum SkillCommand {
    List {
        #[arg(long)]
        json: bool,
        #[arg(long)]
        workspace: Option<String>,
    },
    Read {
        name: String,
        #[arg(long)]
        workspace: Option<String>,
    },
    Enable {
        name: String,
    },
    Disable {
        name: String,
    },
    Delete {
        name: String,
        #[arg(long)]
        workspace: Option<String>,
    },
    /// Import a versioned skill directory/package on the daemon computer.
    Import {
        path: String,
    },
    /// Draft a skill. JSON: goal, optional name/deadlineMs. Save separately after reviewing.
    Create(JsonInput),
    /// Save reviewed SKILL.md. JSON: content, optional force.
    Save(JsonInput),
    /// Validate draft SKILL.md. JSON: content.
    Validate(JsonInput),
    /// Draft from a session. JSON: sessionId, optional deadlineMs.
    Distill(JsonInput),
    /// Refine from a session. JSON: sessionId, name, optional deadlineMs.
    Refine(JsonInput),
    /// Start, inspect or cancel asynchronous skill generation jobs.
    Job {
        #[command(subcommand)]
        command: SkillJobCommand,
    },
}

#[derive(Debug, Subcommand)]
pub enum SkillJobCommand {
    /// JSON: kind (create|distill|refine), plus that operation's parameters.
    Start(JsonInput),
    List {
        #[arg(long)]
        session: Option<String>,
    },
    Get {
        job: String,
        #[arg(long)]
        session: Option<String>,
    },
    Cancel {
        job: String,
        #[arg(long)]
        session: Option<String>,
    },
}

#[derive(Debug, Subcommand)]
pub enum PluginCommand {
    List {
        #[arg(long)]
        json: bool,
    },
    /// Install a plugin directory/package on the daemon computer.
    #[command(visible_alias = "import")]
    Install {
        path: String,
        #[arg(long)]
        update: bool,
    },
    Uninstall {
        id: String,
    },
    Reload {
        id: String,
    },
    /// Enable a plugin. --trust-code allows its executable code when required.
    Enable {
        id: String,
        #[arg(long)]
        trust_code: bool,
    },
    Disable {
        id: String,
    },
    Diagnostics {
        id: String,
    },
}
