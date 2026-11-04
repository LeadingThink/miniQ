//! Discoverable terminal commands and keyboard help.
pub(super) const COMMANDS: &[(&str, &str)] = &[
    ("/git", "Git management; --help lists actions"),
    ("/terminal", "terminal management; --help lists actions"),
    ("/file", "file management; --help lists actions"),
    ("/tool", "tool records; --help lists actions"),
    ("/review", "review management; --help lists actions"),
    ("/schedule", "scheduled tasks; --help lists actions"),
    ("/memory", "memory management; --help lists actions"),
    ("/external", "imported sessions; --help lists actions"),
    ("/workspace", "workspace management; --help lists actions"),
    ("/host", "host management; --help lists actions"),
    ("/voice", "voice management; --help lists actions"),
    ("/computer", "computer management; --help lists actions"),
    ("/session", "session management; --help lists actions"),
    ("/plugins", "list and manage plugins"),
    ("/approval", "approval inbox; --help lists actions"),
    ("/messages", "search messages, copy, edit, fork or undo"),
    ("/tools", "inspect and expand individual tools"),
    ("/attachments", "preview, open or remove attachments"),
    ("/drafts", "recover saved or unsent drafts"),
    ("/processes", "view local command output"),
    ("/settings", "theme, animations and editor preferences"),
    ("/theme", "choose dark, light or terminal colors"),
    ("/export", "export the complete structured conversation"),
    (
        "/redo",
        "restore the last undone exchange and its file changes",
    ),
    ("/help", "show commands and keys"),
    ("/commands", "open the command palette"),
    ("/models", "choose this session's model"),
    ("/sessions", "switch to another session"),
    ("/sidebar", "toggle session sidebar"),
    ("/details", "expand or collapse complete tool output"),
    ("/effort", "choose reasoning effort"),
    (
        "/permissions",
        "approval mode: alwaysAsk | auto | fullAccess",
    ),
    ("/approvals", "alias of /permissions"),
    ("/status", "session, model, mode and queue"),
    (
        "/remote",
        "远程连接设置：开启、关闭、设备名称和状态（这台电脑共用）",
    ),
    ("/new", "start a new session"),
    ("/resume", "switch to another session"),
    ("/fork", "fork this session at the latest message"),
    (
        "/undo",
        "remove the last prompt and its reply, restore edited files",
    ),
    ("/compact", "summarize the conversation now to free context"),
    ("/context", "estimated context window usage"),
    ("/rename", "rename this session"),
    ("/diff", "show files changed in this session"),
    ("/copy", "copy the last answer to the clipboard"),
    ("/init", "ask miniQ to write AGENTS.md"),
    ("/goal", "show or set the session goal"),
    ("/usage", "token usage of recent model calls"),
    ("/cost", "alias of /usage"),
    (
        "/queue",
        "list, update, move, remove or steer queued messages",
    ),
    ("/steer", "steer the running turn with a message"),
    ("/stop", "interrupt the running turn"),
    (
        "/pause",
        "pause the current turn and retain queued follow-ups",
    ),
    ("/resume-turn", "continue a paused turn"),
    (
        "/update",
        "check/install/activate updates; --help lists options",
    ),
    (
        "/manage",
        "run any session, queue, agent or domain management command",
    ),
    ("/attach", "attach a file to the next message"),
    ("/clear-attachments", "drop pending attachments"),
    (
        "/history",
        "readable history; --json preserves the structured page",
    ),
    ("/mcp", "list MCP servers"),
    ("/skills", "list skills"),
    ("/hooks", "list lifecycle hooks"),
    (
        "/agents",
        "list, output, history, message or stop sub-agents",
    ),
    ("/clear", "clear the screen"),
    ("/keybindings", "show the effective key bindings"),
    ("/vim", "toggle vim / emacs editing (saved to cli.json)"),
    (
        "/statusline",
        "show the custom status line command and result",
    ),
    ("/exit", "leave (the session is kept)"),
    ("/quit", "alias of /exit"),
];

pub fn list() -> Vec<(String, String)> {
    COMMANDS
        .iter()
        .map(|(name, description)| ((*name).to_owned(), (*description).to_owned()))
        .collect()
}

pub(super) const KEYS: &str = "Keys: Enter send (queues while running) · Tab steer running turn / complete · Shift+Enter, Alt+Enter or \\ Enter newline
  Esc interrupt · Ctrl+C clear/interrupt, twice to exit · Ctrl+D exit on empty line · Shift+Tab cycle permissions
  Ctrl+P commands · Ctrl+X then N new / L sessions / M models / B sidebar / D tool details
  PgUp/PgDn or mouse wheel scroll · Ctrl+Home older history · Ctrl+End latest
  Alt+Up/Down previous/next message · drag to select text, Ctrl+Y copy · Ctrl+V paste text/image
  Lists: Ctrl+R reload · Models: Ctrl+F favorite, Ctrl+D details · Sessions: Ctrl+D actions
  Messages: Ctrl+F search all history, Ctrl+H earlier results · Questions: Space toggle, Enter on Submit
  Up/Down history · Ctrl+R search history · Ctrl+L redraw screen · Ctrl+G edit in $EDITOR
  Customize keys, editorMode (emacs|vim) and statusLine in cli.json: see /keybindings, /vim, /statusline
  Vim mode: Esc for NORMAL (h j k l w b e 0 ^ $ i a I A o O x X dd D C cc dw cw db d$ yy p P u r G gg)
  @path attaches an existing file (Tab completes paths) · !cmd runs a local shell command, output is not sent";
