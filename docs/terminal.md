# miniQ Terminal

The `miniq` executable is a client of `miniq-daemon`, not a second agent engine. Desktop, terminal and the mobile relay share the same provider configuration, projects, messages, tools, approvals, agents, checkpoints and task state when connected to the same daemon data directory.

## Installation

Desktop releases from v0.1.19 include `miniQ_terminal_VERSION_TARGET.tar.gz` and a SHA-256 checksum for macOS Apple Silicon/Intel, Linux x86-64 and Windows x86-64. Download the matching archive from the [public release page](https://github.com/LeadingThink/miniQ-releases/releases), verify its checksum, extract it and put both executables in the same directory on PATH. Windows 10/11 can extract with `tar -xzf`; Unix extraction preserves executable permissions. Keep `miniq` and `miniq-daemon` together. There is no npm package, Homebrew formula or WinGet package; do not run guessed installation commands.

Source installation prerequisites: stable Rust (https://rustup.rs/), a C/C++ toolchain, and the repository. Prebuilt archives do not require Rust or Node.js; individual tools/MCP servers/plugins may need additional dependencies. Linux archives are built on Ubuntu 24.04 and require compatible system libraries. PDF vision on every platform requires Poppler.

macOS (Apple Silicon or Intel), from the checkout:

```sh
sh scripts/install-cli.sh
export PATH="$HOME/.local/bin:$PATH"
brew install poppler # Optional, required for PDF visual reading
miniq --version
```

Linux / WSL (Debian/Ubuntu system dependencies for the daemon's desktop capabilities):

```sh
sudo apt-get install build-essential pkg-config libclang-dev libxcb1-dev \
  libxrandr-dev libdbus-1-dev libpipewire-0.3-dev libwayland-dev libegl-dev \
  libgbm-dev libxkbcommon-dev libssl-dev libxdo-dev poppler-utils
sh scripts/install-cli.sh
export PATH="$HOME/.local/bin:$PATH"
```

Windows PowerShell, with Rust MSVC and Visual Studio C++ Build Tools:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-cli.ps1
$env:PATH = "$env:LOCALAPPDATA\miniQ\bin;$env:PATH"
miniq --version
```

Windows PDF vision needs a trusted Poppler distribution with `pdfinfo.exe` and `pdftoppm.exe` on PATH. The installer does not silently download unverified third-party executables. WSL is a separate Linux environment/data directory, not the Windows desktop daemon. Do not share a live SQLite database across the Windows/WSL boundary.

Set `MINIQ_INSTALL_DIR` to override the destination. Re-run the installer to update source builds. Both binaries are built before installation, and no running task/process is stopped. A running older daemon continues using its loaded code. When no tasks are active, exit/restart that daemon through the desktop workflow; do not start a second daemon against its database. On Windows replacement of an in-use binary can fail explicitly; retry when idle.

Uninstall only the two installed executables, using the exact installation directory. Keep the data directory unless you explicitly want to delete conversations, configuration and keys. No shell profile, registry entry or login service is modified automatically.

## First Use

```sh
miniq configure --base-url https://your-oneapi-endpoint/v1 --model MODEL_ID
miniq doctor
cd /path/to/project
miniq
```

`configure` prompts for the key with echo disabled, or uses `MINIQ_API_KEY` supplied by your secret manager. Never put a key in command-line arguments, shell history, shared logs or screenshots. It updates the same provider settings as desktop; session model changes are separate. Saved settings/connection files use atomic replacement and owner-only permissions on Unix. Windows inherits the local user's data-directory ACL: do not place it in a shared directory.

`miniq logout` removes the saved shared provider key without cancelling running tasks. Also remove `MINIQ_API_KEY` from your environment/secret manager when appropriate; a running request may already hold its key. A blank key keeps the saved key only for the same endpoint, never forwards it to a new endpoint.

`--protocol auto` uses miniQ's existing OneAPI protocol discovery. Explicit values are `responses`, `chat_completions`, `anthropic_messages`. Model/effort validity is still checked by the backend. No provider key or private file is automatically sent to a different provider.

## Interactive Tasks

```sh
miniq -C /project --add-dir /shared/reference -m MODEL --effort high
miniq -a /project/screenshot.png "Review this layout"
miniq resume --last
miniq resume SESSION_ID "Continue from the verified results"
miniq sessions
miniq sessions --all
```

Interactive commands: `/model ID`, `/effort LEVEL`, `/effort default`, `/attach PATH`, `/clear-attachments`, `/status`, `/history`, `/help`, `/exit`. Paths after `/attach` may contain spaces; they are not shell-evaluated. Line editing uses a standard terminal editor. Prompts are not copied to a separate plaintext CLI history file.

Approvals show the tool and full input; `y` approves once, anything else rejects. Questions accept free text and show supplied choices. Responses from desktop/mobile remain authoritative. Ctrl+C during a task started by this client requests cancellation of that session and its children. Ctrl+C while merely watching detaches without cancelling. `/exit` between turns leaves the daemon running. Resume reuses persisted context; it does not resend the earlier task.

`--add-dir` updates the shared project, preserving existing roots; the backend refuses while that project has active tasks. `-C` cannot move a resumed session. `resume --last` is scoped to the current project's most recently updated, non-archived local session, not a globally pinned session.

## Scripting

```sh
miniq exec "Explain this project" --use-configured-permissions
miniq exec - --json --use-configured-permissions < prompt.txt
git diff | miniq exec "Review this diff" --use-configured-permissions
miniq exec --session SESSION_ID "Check the previous result" --use-configured-permissions
miniq exec "Write a summary" -o summary.txt --use-configured-permissions
```

Scripts require either the target session's effective `approvalMode=alwaysAsk`, or explicit `--use-configured-permissions`. The latter inherits that session's current permissions, including full access if enabled: it is **not** a sandbox flag. New sessions inherit the global default; existing sessions may override it. The CLI checks before preparing the session and again before sending, and never changes permissions to make an unattended command run. `alwaysAsk` can be set deliberately for one session in desktop controls or `miniq rpc session.approval.update '{"sessionId":"SESSION_ID","mode":"alwaysAsk"}'`.

Without `--json`, progress is on stderr and only the final persisted answer is on stdout. `--json` emits session-scoped JSONL daemon events plus `cli_result`; reconnects add `cli_snapshot` with a paginated history snapshot. Consumers must honor `assistant_replaced`, use `message_created` as committed text and deduplicate by IDs/cursors. No base64 image is embedded in regular event output. `-o` creates a new file only on success; an existing file is never overwritten.

Preflight/startup errors in JSON mode use `cli_error`. Argument syntax errors remain the parser's stderr output with exit code 2. Relative attachment paths resolve from the invoking terminal directory; use absolute paths when resuming a session in a different directory.

Exit codes: `0` completed; `1` task/connection/configuration failure; `2` invalid command-line syntax; `3` waiting for approval/answer (task remains available for desktop/mobile/resume); `130` interrupted. A process exit is not always a task cancellation. Provider failures are retried by the existing agent runtime; CLI reconnects only restore observation, never replay a mutating request. Unknown send outcomes are reported for manual inspection. A task already running is rejected atomically, not silently queued behind another user's turn. Old daemons without this guarantee can still be inspected but must be updated before CLI task submission.

New turns persist their outcome separately from the sidebar badge. A cleared failure badge or an interrupted partial answer is not success. Older sessions without a recorded outcome are reported as unknown/incomplete when watched, not retroactively certified as successful.

## Other Controls

```sh
miniq watch SESSION_ID --json
miniq cancel SESSION_ID
miniq history SESSION_ID --limit 40
miniq history SESSION_ID --before '{"at":"TIMESTAMP","id":"ID"}'
miniq models
miniq models MODEL_ID
miniq status
miniq rpc tool.list
miniq rpc agent.list '{"sessionId":"SESSION_ID"}'
miniq rpc remote.status
miniq completions zsh
```

History is paged; use the returned `nextCursor` in `--before` until null. Large tool payloads remain accessible through the backend's `session.toolDetail`/history APIs. `rpc METHOD -` reads JSON parameters from stdin for advanced MCP, skill, agent, checkpoint and remote configuration without shell-escaping large objects. Avoid putting secrets in its argv.

The daemon is loopback-only and authenticated. Discovery uses `MINIQ_DATA_DIR` (Unix default `~/.local/share/miniq`; Windows `%LOCALAPPDATA%/miniq`), `MINIQ_DAEMON_PATH`, the binary next to the CLI, then installed locations/PATH. `--no-start` makes diagnostics connect-only. An OS lock prevents concurrent daemons from recovering/overwriting the same active database. To test independently, use a new `--data-dir` and a mock provider, not a copy of a live database.

Terminal-only servers can use file, code, document, model, MCP and existing browser automation tools; browser automation needs an installed compatible browser. Native computer use needs a logged-in graphical session and screen/accessibility permissions. SSH, containers, mobile browsers and WSL do not gain control of an unrelated desktop by installing the CLI. Mobile remote access still uses miniQ's authenticated relay; it is not a public shell service. `doctor` checks permission state without requesting changes or restarting processes.

## Multimodal Files

`view_image` sends real PNG/JPEG/WebP/static-GIF pixels using the existing Responses, Chat Completions or Anthropic image encoding. The decoder validates file content, applies orientation, preserves resolution and snapshots pixels in private storage. Animated images are explicitly rejected until frames are selected; none are silently dropped. Files over the image budget require an explicit crop or smaller input, not hidden resizing. Native `Read` on images routes here.

`view_pdf` uses Poppler to render selected pages, including scanned pages and diagrams, into image inputs for the **currently selected** model. Default batch: 3 pages; max: 10; `nextPage` identifies the remaining pages. Explicit `pages` accepts ranges such as `1-3,5`. Native PDF `Read` uses visual pages unless line-based text was specifically requested. `doc_read` remains the text/table extraction tool. OCR supplements exact transcription; it does not replace visual inspection.

Archive files must be safely extracted to the workspace, then their image/PDF files can be read visually. The ZIP itself is not an image. Explicit file attachments outside a project grant only read access to those exact canonical files, not writes or access to neighboring files. Desktop/mobile observation previews fetch one selected PDF page on demand through the existing chunked transport.

## Comparison Sources

- Codex CLI: https://learn.chatgpt.com/docs/codex/cli
- Codex scripting: https://learn.chatgpt.com/docs/non-interactive-mode
- Codex image inputs: https://learn.chatgpt.com/docs/image-inputs
- Claude Code installation: https://code.claude.com/docs/en/setup
- Claude Code CLI: https://code.claude.com/docs/en/cli-reference

The adopted patterns are a real terminal entry point, project-scoped resume, model selection, hidden key entry, stdin/JSONL automation, separated progress/final output, explicit permissions and diagnostics. This is not a claim to reproduce the competitors' private clients, subscription authentication, every TUI feature, or a provider's unavailable model capabilities. macOS is runtime-tested locally; Windows/Linux build jobs are provided for platform validation, not represented as already executed on this Mac.

## Verification

The macOS source installation was exercised in an isolated installation/data directory with the real daemon and a local fixture provider, without production keys or documents. Checks covered headless startup, configuration, stdin/final stdout, shared project/session discovery, durable outcomes, watch without replay, continued conversation context, native `Read` image pixels reaching the provider request, and logout. Provider encoding tests separately cover Responses, Chat Completions and Anthropic image content; these are protocol tests, not live-provider availability claims.

Targeted Rust, daemon RPC/queue, memory, frontend and provider tests passed, including an explicitly enabled five-page Poppler rendering test with nonblank-pixel and pagination assertions. CLI/local Clippy, workspace/Tauri compilation, Rust formatting, TypeScript checking, frontend build and shell syntax checks passed. PDF preview paging was inspected at desktop and 360px mobile widths using the isolated `visual-preview.html` fixture, including lazy image requests and object-URL cleanup.

The terminal starts its daemon in a separate process group so terminal interrupts do not signal the shared backend. A Unix regression test checks the spawned process group; an actual PTY check also verified `/help`, `/status`, `/exit` and continued daemon connectivity after terminal exit. Image decoding limits also cover GIF animation detection, including oversized logical canvases. Windows/Linux native execution remains to be verified by the supplied build matrix; macOS results do not substitute for those runs.
