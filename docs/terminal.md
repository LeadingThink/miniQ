# miniQ Terminal

The `miniq` executable is a client of `miniq-daemon`, not a second agent engine. Desktop, terminal and the mobile relay share the same provider configuration, projects, messages, tools, approvals, agents, checkpoints and task state when connected to the same daemon data directory.

## Installation

macOS (Apple Silicon/Intel):

```sh
curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | sh
```

Windows 10/11 x64, in PowerShell:

```powershell
irm https://oss.zaiwen.top/releases/miniq/install.ps1 | iex
```

Linux / WSL (x86_64, glibc 2.31+), using the currently available terminal release 0.1.54:

```sh
curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | MINIQ_VERSION=0.1.54 sh
```

Version 0.1.55 did not publish a Linux terminal package. The current default terminal manifest only lists macOS and Windows, so Linux / WSL must use the version-pinned command above; plain installation and `miniq update` cannot currently select a Linux release.

Open a new terminal, enter your project directory and run `miniq`. No Rust, Node.js, administrator access or desktop window is required. The installer selects the correct architecture, downloads the official release over HTTPS and verifies its SHA-256 checksum before changing anything. Desktop **Settings → Services & remote → Terminal** offers the same installation action. There is no npm package, Homebrew formula or WinGet package; do not run guessed package names.

Default installation: `~/.local/bin` on Unix; `%LOCALAPPDATA%\miniQ\bin` on Windows. The installer adds that directory to the current user's shell profile/User PATH. Set `MINIQ_INSTALL_DIR` to an absolute custom directory, `MINIQ_NO_MODIFY_PATH=1` to manage PATH yourself, or `MINIQ_VERSION=x.y.z` to install a specific published version from v0.1.54 onward, provided it includes your platform. The Unix script chooses zsh, bash, fish or POSIX profile syntax. A GUI-launched macOS install without `SHELL` defaults to zsh. Re-running the installer is safe. On macOS / Windows, `miniq update` uses the same installation mechanism and `miniq update --check` only checks availability. For Linux / WSL, use the pinned command above until a newer release includes that platform.

CLI and daemon are an immutable pair under `bin/.miniq/versions/VERSION`. A single atomic version pointer activates the pair; old payloads remain available to already running processes. Unix exposes two stable symlinks; Windows uses native launchers, preserving arguments, standard streams and the child exit code. Concurrent installers are rejected. No installer stops a task, restarts the shared daemon or edits provider keys/conversations. An old daemon keeps its loaded code until it exits safely. Migrating an older Windows installation whose binary is in use fails before replacing either executable; retry after that process exits. Upgrading an already managed Windows installation does not overwrite its busy launchers.

Linux prebuilt terminals require x86-64, **glibc 2.31+** and `libgcc_s`; Alpine/musl and Linux ARM are not supported. They need no X11, Wayland or PipeWire libraries, and include agent, shell, file, browser and plugin tools. Native desktop mouse/screenshot tools require the separate graphical desktop edition. Browser automation still requires a compatible browser runtime. PDF vision requires Poppler (`brew install poppler` or `apt install poppler-utils`; on Windows put trusted `pdfinfo.exe`/`pdftoppm.exe` on PATH). The installer does not download third-party tool dependencies. WSL has a separate data directory; never share a live SQLite database across the Windows/WSL boundary.

Manual archives and SHA-256 sidecars remain available on the [public release page](https://github.com/LeadingThink/miniQ-releases/releases). Keep `miniq` and `miniq-daemon` together. Source builds require stable Rust and a C/C++ toolchain: `cargo build --release --locked --no-default-features -p miniq-daemon -p miniq-cli --bin miniq --bin miniq-daemon` builds the server edition; omit `--no-default-features` for native desktop control. The release pipeline verifies Linux ELF dependencies and glibc symbols and boots its daemon/SSH bridge in a clean Debian 11 image.

To uninstall, remove only the exact installed `miniq`/`miniq-daemon` links or launchers and their `.miniq` binary store, then remove the installer-marked PATH line (Windows: the user PATH entry). Keep the separate daemon data directory unless you explicitly want to delete conversations/configuration. No login service is installed.

## First Use

```sh
cd /path/to/project
miniq
miniq doctor
```

First launch detects existing shared desktop settings. If no key is configured, it offers the default `https://oneapi.zaiwenai.com/v1` service, concealed key input and a searchable list of text models before creating a session. Get a key from [Zaiwen API](https://platform.zaiwenai.com/). `miniq configure` reopens setup; `--base-url` and `--model` are optional overrides. An existing saved endpoint is preserved. A secret manager may supply `MINIQ_API_KEY`. Never put a key in command-line arguments, shell history, logs or screenshots. Setup updates shared provider settings; session model changes are separate. Saved settings/connection files use atomic replacement and owner-only permissions on Unix; Windows inherits the current user's data-directory ACL. Do not use a shared data directory.

Desktop settings on another computer are not copied automatically. Configure each target computer separately; WSL also has its own configuration and conversations. In a session, use `/model` to select a model and `/effort` to choose its supported reasoning level for that session. From the shell, `miniq resume` continues a session in the current project and `miniq doctor` checks terminal/daemon versions and dependencies. See the platform-specific installation and update guidance above.

`miniq logout` removes the saved shared provider key without cancelling running tasks. Also remove `MINIQ_API_KEY` from your environment/secret manager when appropriate; a running request may already hold its key. A blank key keeps the saved key only for the same endpoint, never forwards it to a new endpoint.

`--protocol auto` uses miniQ's existing OneAPI protocol discovery. Explicit values are `responses`, `chat_completions`, `anthropic_messages`. Model/effort validity is still checked by the backend. No provider key or private file is automatically sent to a different provider.

## Interactive Tasks

```sh
miniq -C /project --add-dir /shared/reference -m MODEL --effort high
miniq -a /project/screenshot.png "Review this layout"
miniq resume --last
miniq resume
miniq resume SESSION_ID "Continue from the verified results"
miniq sessions
miniq sessions --all
```

Interactive commands: `/model` opens searchable text-model selection; `/model ID` switches directly for this session. `/effort` lists the selected model's supported reasoning choices; `/effort LEVEL` and `/effort default` remain available. `miniq resume` opens a project-scoped session picker; `resume --last` resumes immediately. Other commands: `/attach PATH`, `/clear-attachments`, `/status`, `/history`, `/help`, `/exit`. Paths after `/attach` may contain spaces and are not shell-evaluated. The editor supports arrow-key prompt recall in memory; prompts are not copied to a separate plaintext history file.

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

## iPhone and iPad

The released miniQ app is available on the [App Store](https://apps.apple.com/cn/app/miniq/id6811485613) for iOS / iPadOS 15 or later. Mobile chat works independently of a computer. To access remote tasks, enable **Settings → Services & remote → Allow remote connections** on the computer, use the same Zaiwen API key on both devices, and keep the computer online and awake. The mobile app can view and continue tasks on that computer, including responding to questions and approvals.

The terminal client runs tasks on the computer or server where it is installed. The mobile app is a remote client of those computers; it does not install `miniq` or run desktop tools locally on iPhone or iPad.

### Terminal-only servers (no desktop app)

Remote access is provided by `miniq-daemon`, so a server with only the terminal package can also be reached from the mobile app. It is off by default and the CLI has no dedicated switch; enable it once through the advanced RPC:

```sh
miniq configure                      # save the same Zaiwen API key used on the phone
miniq rpc settings.update - <<'EOF'
{"remoteAccess":{"enabled":true,"relayUrl":"wss://oneapi.zaiwenai.com/miniq-relay/ws","deviceName":"my-server"}}
EOF
miniq rpc remote.status              # should report the relay as connected
```

`deviceName` is the name shown on the phone (1–80 characters). Without a saved API key the status stays waiting for a key. Keep the daemon running and the server online; after a reboot run any `miniq` command (for example `miniq status`) to start it again. To turn remote access off, repeat the update with `"enabled":false`. The phone can view and continue tasks, answer questions and approvals, and browse files on the server; native computer use still requires a graphical session on that server.

## Desktop Connections over SSH

`miniq bridge` exposes the authenticated local daemon connection as JSONL on standard input/output for miniQ desktop's SSH transport. Install matching `miniq` and `miniq-daemon` binaries on the remote computer first. The bridge discovers the remote user's saved data directory and starts a detached daemon if needed; `--no-start`, `--data-dir` and `--daemon-path` have the same meaning as other CLI commands. It does not listen on a public network port and does not print the daemon token or copy the local computer's provider key to the remote computer.

After authenticated daemon health and protocol checks, the first stdout line is:

```json
{"type":"miniq_bridge_ready","protocolVersion":2,"version":"<installed version>"}
```

Send one JSON-RPC 2.0 request object per newline-terminated UTF-8 line, including an `id` and `method`. Responses and daemon events follow as JSON objects, one per line, in daemon order. Events received during startup follow the ready marker. Pretty-printed daemon JSON is normalized to one line without changing its content. Bridge input and output are limited to 16 MiB per message, matching the default daemon WebSocket frame limit; oversized messages fail explicitly instead of being truncated. Use the existing paginated and chunked file/history APIs for larger payloads.

EOF or Ctrl+C closes only this connection; active tasks remain owned by the daemon. A broken connection exits nonzero with diagnostics on stderr. No request is replayed automatically, including requests whose outcome is unknown. Reconnect and inspect persisted session state before submitting another task. Closing desktop's SSH connection does not log out the remote provider or stop its daemon. Native computer use on a remote host still requires that host's graphical session and OS permissions.

Developers can run `cargo build -p miniq-cli -p miniq-daemon` and then `node scripts/test-ssh-smoke.mjs` on macOS/Linux with OpenSSH installed. The optional smoke starts an isolated loopback SSH server with temporary keys, a fresh daemon data directory and a local mock model. While a task is running, it verifies encrypted mobile relay calls through the local daemon's host pool and real SSH bridge, including two host aliases, history, files, events and independent disconnect/reconnect. It then checks that the task completes with exactly one model request. It neither uses production credentials nor changes system SSH configuration. By default it cleans up its temporary keys and test services on completion. `--keep` retains the fixture for further isolated diagnostics until SIGTERM or SIGINT.

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
