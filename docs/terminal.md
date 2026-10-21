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

Linux / WSL (x86_64, glibc 2.31+):

```sh
curl -fsSL https://oss.zaiwen.top/releases/miniq/install.sh | sh
```

The installer uses the published terminal manifest for the current platform. A release may include only selected platforms; if its manifest has no matching archive, installation/update fails explicitly. To select another published version, set `MINIQ_VERSION=x.y.z` and verify that version includes the target platform on the public release page.

Open a new terminal, enter your project directory and run `miniq`. No Rust, Node.js, administrator access or desktop window is required. The installer selects the correct architecture, downloads the official release over HTTPS and verifies its SHA-256 checksum before changing anything. Desktop **Settings → Services & remote → Terminal** offers the same installation action. There is no npm package, Homebrew formula or WinGet package; do not run guessed package names.

Default installation: `~/.local/bin` on Unix; `%LOCALAPPDATA%\miniQ\bin` on Windows. The installer adds that directory to the current user's shell profile/User PATH. Set `MINIQ_INSTALL_DIR` to an absolute custom directory or `MINIQ_NO_MODIFY_PATH=1` to manage PATH yourself. The Unix script chooses zsh, bash, fish or POSIX profile syntax. A GUI-launched macOS install without `SHELL` defaults to zsh. Re-running the installer is safe. `miniq update` uses the same installation mechanism; `miniq update --check` only checks availability.

CLI and daemon are an immutable pair under `bin/.miniq/versions/VERSION`. A single atomic version pointer selects the installed pair; old payloads remain available to already running processes. Unix exposes two stable symlinks; Windows uses native launchers, preserving arguments, standard streams and the child exit code. Concurrent installers are rejected. The installer preserves running tasks and shared provider/conversation data. An old daemon keeps its loaded code until it exits safely. Migrating an older Windows installation whose binary is in use fails before replacing either executable; retry after that process exits. Upgrading an already managed Windows installation does not overwrite its busy launchers.

`miniq update` and `miniq update --check` report both the installed CLI version and the running backend version. These can differ while tasks continue on an older daemon. Use `miniq rpc daemon.health` or `miniq doctor` to inspect the backend independently.

Linux prebuilt terminals require x86-64, **glibc 2.31+** and `libgcc_s`; Alpine/musl and Linux ARM are not supported. They need no X11, Wayland or PipeWire libraries, and include agent, shell, file, browser and plugin tools. Native desktop mouse/screenshot tools require the separate graphical desktop edition. Browser automation still requires a compatible browser runtime. PDF vision requires Poppler (`brew install poppler` or `apt install poppler-utils`; on Windows put trusted `pdfinfo.exe`/`pdftoppm.exe` on PATH). The installer does not download third-party tool dependencies. WSL has a separate data directory; never share a live SQLite database across the Windows/WSL boundary.

Manual archives and SHA-256 sidecars remain available on the [public release page](https://github.com/LeadingThink/miniQ-releases/releases). Keep `miniq` and `miniq-daemon` together. Source builds require stable Rust and a C/C++ toolchain: `cargo build --release --locked --no-default-features -p miniq-daemon -p miniq-cli --bin miniq --bin miniq-daemon` builds the server edition; omit `--no-default-features` for native desktop control. The release pipeline verifies Linux ELF dependencies and glibc symbols and boots its daemon/SSH bridge in a clean Debian 11 image.

To uninstall, remove only the exact installed `miniq`/`miniq-daemon` links or launchers and their `.miniq` binary store, then remove the installer-marked PATH line (Windows: the user PATH entry). Keep the separate daemon data directory unless you explicitly want to delete conversations/configuration. No login service is installed.

## Updating Safely

```sh
miniq update --check                 # versions and availability; no installation
miniq update                         # install the published pair
miniq update --activate              # activate the installed backend when idle
miniq update --activate --stop-running
```

Installation and backend activation are separate. A script running `miniq update` installs without stopping work. In a terminal, when the backend needs activation, miniQ offers activation or **Later**; Later is the default. Activation first asks the daemon to shut down through an atomic idle check. Running turns, agents, requests or queued messages defer activation. Interactive activation then offers to stop **all** backend work, or leave everything running; leaving it running is the default. `--activate --stop-running` explicitly selects stopping all work. Queued messages are retained by this update shutdown. An older backend without safe idle-shutdown support requires a normal restart after its tasks finish.

Explicit `--activate` returns exit code `3` when deferred. A newly launched CLI uses the installed executable; an already open terminal client keeps its current executable. After activation, miniQ verifies the running backend version. This affects every client using that shared daemon, including desktop and mobile.

Rich interactive chats check for updates asynchronously after startup and periodically while open. The same version is reminded at most once per day; a newer version can produce a new reminder. Check failures stay quiet and back off. Reminders only offer an update command; installing and stopping tasks still require the choices above. Inside a chat, `/update --check` and `/update --activate` use the same workflow.

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

`miniq resume` opens a project-scoped session picker; `resume --last` or `miniq -c` resumes immediately. Resume reuses saved context without resending the earlier task. The rich terminal provides streaming Markdown, tool/plan progress, pending input cards, a queue and a status bar. Its main commands are:

| Commands | Purpose |
| --- | --- |
| `/model [ID]`, `/effort [LEVEL]` | Select a session model and supported reasoning effort; `default` clears the effort override. |
| `/permissions [alwaysAsk\|auto\|fullAccess]` | Inspect/change this session's permission mode; `/approvals` is an alias. |
| `/new`, `/resume`, `/fork`, `/rename TITLE` | Create, switch, branch or rename sessions. |
| `/undo`, `/diff`, `/compact`, `/context` | Undo the latest turn, inspect changes, compact context or inspect estimated usage. |
| `/pause`, `/resume-turn`, `/stop`, `/steer MESSAGE` | Pause/resume or interrupt/steer the active turn. |
| `/goal [TEXT\|pause\|resume\|cancel\|done]` | Read/set a goal or explicitly control its state. |
| `/queue [ACTION …]`, `/agents [ACTION …]` | Manage queued follow-ups and inspect/stop child agents. |
| `/attach PATH`, `/clear-attachments`, `/history [OPTIONS]` | Attach files or read saved conversation history. |
| `/status`, `/usage`, `/remote`, `/update`, `/help`, `/exit` | Inspect session/usage, control remote access, update or leave. |
| `/mcp`, `/skills`, `/plugins`, `/hooks` | Inspect extensions; skills/plugins also accept their management subcommands. |
| `/keybindings`, `/vim`, `/statusline` | Inspect/customize keys, editing mode and status line in the data directory's `cli.json`. |
| `/manage COMMAND …` | Use the shell's session, queue, agent or domain command parser. |

`/pause`, `/resume-turn`, `/goal`, `/queue`, `/agents` and `/history` automatically target the current session. Domain shortcuts such as `/file`, `/git`, `/review`, `/schedule`, `/approval` and `/workspace` accept the same explicit arguments as their shell commands. For example, `/queue move QUEUED_ID up`, `/agents output AGENT_ID` and `/manage session events SESSION_ID --limit 20`.

Enter sends; while a turn is running it queues a follow-up. Tab with a prompt during a running turn steers it; otherwise Tab completes. Shift+Enter, Alt+Enter or backslash followed by Enter inserts a newline. Esc interrupts, Ctrl+C clears/interrupts and a second Ctrl+C exits; Ctrl+D exits on an empty line. Shift+Tab cycles permission modes. Up/Down recalls prompts, Ctrl+R searches history, Ctrl+G opens `$EDITOR`, and Ctrl+L clears the screen. The rich editor saves prompt recall in the data directory's private `cli_history` file; set `MINIQ_NO_HISTORY=1` to disable disk history. Keep sensitive content out of prompts/history when possible. `@path` attaches existing files; `!command` runs a local shell command whose output stays on screen. Paths after `/attach` may contain spaces and are not shell-evaluated.

Approvals display the tool, risk and complete input. Choose `1`/`y` to approve once, `2` for the session, `3` to always allow that tool or `4`/`n` to reject. `/approval inbox` and `/approval rules` manage the shared inbox and saved rules; `/permissions` changes the session mode. Questions display option descriptions, support numbered choices or a custom answer, and show a countdown/default answer when the daemon supplies an automatic continuation deadline. Answers and approval decisions from desktop/mobile remove the matching pending card.

The rich editor is used when stdin/stdout are terminals and `TERM` supports it. `MINIQ_REPL=line` selects the simpler line terminal with in-memory prompt recall; it shares the management parser and `/manage` commands, while advanced keys and cards belong to the rich editor. `miniq watch` detaches on Ctrl+C without cancelling. `/exit` leaves the shared daemon running.

`--add-dir` updates the shared project, preserving existing roots; the backend refuses while that project has active tasks. `-C` cannot move a resumed session. `resume --last` is scoped to the current project's most recently updated, non-archived local session, not a globally pinned session.

## Finding and Reading Sessions

`miniq --help` prints the same quick reference; `miniq help COMMAND` shows per-command examples.

```sh
# Sessions in the current directory's project
miniq sessions
# Sessions across all projects
miniq sessions --all
# Sessions of a specific project
miniq -C /path/to/project sessions
```

In a terminal, `miniq sessions` prints each session's title, status, relative update time, turn count, ID and last-message preview; archived and imported sessions are marked, and `--all` adds the project directory. When stdout is piped, or with `--json`, it prints the `session.list` JSON instead:

```sh
miniq sessions --all | jq '.sessions[] | {id, title, status, updatedAt}'
```

With a session ID:

```sh
miniq history SESSION_ID --limit 40   # readable history in a terminal
miniq history SESSION_ID --json       # complete page including nextCursor
miniq watch SESSION_ID                # follow a running session without sending anything
miniq resume SESSION_ID               # continue it
miniq resume                          # pick a session of the current project
miniq resume --last                   # continue the current project's most recent session
```

Inside a chat, `/help` prints the current session ID with the matching `resume`, `watch` and `history` commands.

History prints a readable transcript in a terminal and complete JSON when piped or given `--json`. It retains message metadata, attachments and tool records. Pass the exact returned `nextCursor` JSON as `--before` to read older pages. `miniq session events`, `model-calls`, `process` and `tool-detail` expose execution details separately.

Notes:

- Without `--all`, only sessions of the current working directory's project are listed.
- The `miniq resume` picker hides archived and imported (external) sessions; `miniq sessions` lists them.
- Terminal, desktop and phone share sessions when they connect to the same daemon data directory.
- Over SSH, `miniq sessions` shows the remote computer's sessions. The same API Key does not merge local sessions from different computers.
- To view them from the phone, first select the matching remote desktop or SSH host.

## Scripting

```sh
miniq exec "Explain this project" --use-configured-permissions
miniq exec - --json --use-configured-permissions < prompt.txt
git diff | miniq exec "Review this diff" --use-configured-permissions
miniq exec --session SESSION_ID "Check the previous result" --use-configured-permissions
miniq exec "Write a summary" -o summary.txt --use-configured-permissions
```

Without an explicit permission option, scripts require the target session's effective `approvalMode=alwaysAsk`. `--use-configured-permissions` explicitly accepts the session's saved permissions, including full access if enabled: it is **not** a sandbox flag. New sessions inherit the global default; existing sessions may override it. Without an override, the CLI checks before preparing the session and again before sending. `alwaysAsk` can be set deliberately for one session in desktop controls or `miniq rpc session.approval.update '{"sessionId":"SESSION_ID","mode":"alwaysAsk"}'`.

Alternatively, explicitly set the opened session's permission mode with `--approval always-ask|auto|full-access` (alias `--permission-mode`). `--full-auto` and `--dangerously-bypass-approvals` select full access, including editing/deleting files and executing commands unattended. `--max-turns N` limits a submitted turn to 1–1000 model requests. `miniq -p "task"` is print mode; `--output-format json` returns one result object, while `--output-format stream-json` or `exec --json` emits JSONL. `--output-schema FILE_OR_JSON` validates the final JSON answer; a validation failure exits `1`.

Without `--json`, progress is on stderr and only the final persisted answer is on stdout. `--json` emits session-scoped JSONL daemon events plus `cli_result`; reconnects add `cli_snapshot` with a paginated history snapshot. Consumers must honor `assistant_replaced`, use `message_created` as committed text and deduplicate by IDs/cursors. No base64 image is embedded in regular event output. `-o` creates a new file only on success; an existing file is never overwritten.

Preflight/startup errors in JSON mode use `cli_error`. Argument syntax errors remain the parser's stderr output with exit code 2. Relative attachment paths resolve from the invoking terminal directory; use absolute paths when resuming a session in a different directory.

Exit codes: `0` completed or explicitly queued; `1` task/connection/configuration failure; `2` invalid command-line syntax; `3` waiting for approval/answer or a paused turn (the task remains available for desktop/mobile/resume); `130` interrupted or a busy-session prompt left unsent. A process exit is not always a task cancellation. Provider failures are retried by the existing agent runtime; CLI reconnects only restore observation, never replay a mutating request. Unknown send outcomes are reported for manual inspection. Old daemons without atomic CLI turn admission can still be inspected but must be updated before CLI task submission.

New turns persist their outcome and redacted failure reason separately from the sidebar badge. Reopening a session or reconnecting later shows the saved reason even after its failure badge has been acknowledged on another client. `miniq watch SESSION_ID`, `miniq resume SESSION_ID` and `miniq session events SESSION_ID` expose this saved failure. A cleared badge or partial answer is not success. Older records without a reason say that no specific reason was saved; older turns without a recorded outcome remain unknown/incomplete.

## Busy Sessions and Queued Follow-Ups

When an `exec` or line-terminal submission encounters a busy session, a terminal offers three choices: queue the new prompt, stop this session's task and queued follow-ups before sending, or return without sending. Returning is the default. Scripts reject busy sessions unless given an explicit policy:

```sh
miniq exec --session SESSION_ID --on-busy reject "Follow up" --use-configured-permissions
miniq exec --session SESSION_ID --on-busy queue "After this, run the checks" --use-configured-permissions
miniq exec --session SESSION_ID --on-busy stop "Replace the current work" --use-configured-permissions
miniq queue list SESSION_ID --json
```

`--on-busy stop` cancels that session's active task, children and queued follow-ups, waits for it to stop, then submits once. It does not stop unrelated sessions. The rich chat queues submissions while a turn is running, including an initial prompt supplied with `resume`; Enter queues and Tab steers the running turn. `/queue` lets you inspect, edit, reorder, remove or steer a retained message.

Queued `exec` returns immediately with exit code `0`, confirming acceptance into the queue. Text mode prints the queued ID on stderr and no final answer. JSON/JSONL mode prints a `cli_queued` object with `sessionId`, `queuedMessageId` and `status: "queued"`; it does not emit `cli_result` or create `-o` output. Follow the later execution using `watch`, history or queue state. This is distinct from a completed answer.

The queue currently does not store per-message `--max-turns` limits. A busy submission with this limit fails explicitly before enqueueing; wait for the task to finish, choose `stop`, or omit the limit when queueing. Limits remain enforced on turns that start immediately.

## Session, Queue and Agent Controls

These shell commands operate on the same saved state as desktop/mobile. History/process pages have readable transcripts; other management commands display structured data. Piping output or adding `--json` preserves the original response JSON.

```sh
miniq session pause SESSION_ID
miniq session resume SESSION_ID
miniq session goal get SESSION_ID
miniq session goal set SESSION_ID "Finish and verify the migration" --token-budget 100000
miniq session goal status SESSION_ID paused
miniq session goal status SESSION_ID active
miniq session search "download timeout" --limit 20
miniq session events SESSION_ID --limit 20 --json
miniq session model-calls SESSION_ID --limit 20 --json
miniq session process SESSION_ID --turn USER_MESSAGE_ID --json
miniq session tool-detail SESSION_ID TOOL_CALL_ID --json
miniq queue update SESSION_ID QUEUED_ID "Updated follow-up"
miniq queue move SESSION_ID QUEUED_ID up
miniq queue remove SESSION_ID QUEUED_ID
miniq queue steer SESSION_ID QUEUED_ID
miniq agent list SESSION_ID
miniq agent output SESSION_ID AGENT_ID
miniq agent history SESSION_ID AGENT_ID --limit 20 --json
miniq agent message SESSION_ID AGENT_ID --revision REVISION --index INDEX --json
miniq agent stop SESSION_ID AGENT_ID
```

Pause retains queued messages; resume also supports a pause saved before a daemon restart. Goal `set` changes saved goal text/budget without submitting a prompt or silently changing goal state. Goal `status active|paused|cancelled|completed` explicitly controls the goal and its turn. `--clear-token-budget` removes a saved budget. Queue updates retain attachments and use an atomic content check; moves use the observed position. `steer` promotes the selected message and interrupts the active turn. Agent `message` **reads** one historical message using the revision/index returned by history; there is no `agent send` command.

Session lifecycle and recovery commands include:

```sh
miniq session pin SESSION_ID               # --off to unpin
miniq session archive SESSION_ID           # --off to restore
miniq session rewrite SESSION_ID USER_MESSAGE_ID "Corrected prompt"
miniq session revert-turn SESSION_ID USER_MESSAGE_ID
miniq session acknowledge-failure SESSION_ID --updated-at EXACT_UPDATED_AT
miniq session delete SESSION_ID --yes
```

`rewrite` replaces a user message and reruns from it, preserving its attachments unless `--attach` or `--clear-attachments` is supplied. `revert-turn` restores the files changed by that turn; `--force` also allows overwriting later edits. `acknowledge-failure` (alias `ack`) clears only a badge matching the observed `updatedAt`; the saved reason remains. `delete --yes` removes the session and retained history.

Sharing requires an explicit selection of messages/files and creates a public link:

```sh
miniq session share create SESSION_ID --id 0123456789abcdef0123456789abcdef \
  --title "Selected result" --message MESSAGE_ID --days 7
miniq session share list SESSION_ID --json
miniq session share revoke SESSION_ID SHARE_ID
```

Use a unique 32-character lowercase hexadecimal ID for each new share; reuse it after an unknown request outcome. Repeat `--message`/`--artifact` for selected content. Unselected files stay private. Events, model calls and process pages accept `--before`; agent history uses `--cursor`; share listing uses `--after`. Keep and pass each response's exact cursor.

## Domain Commands

Domain commands print the complete daemon response as JSON, including continuation metadata. `skills list` and `plugins list` display tables in a terminal; use `--json` or pipe them to retain every response field. Complex operations accept an inline JSON object, `-` for stdin or `@FILE`; the CLI validates its shape and forwards the original JSON without dropping fields or shortening content. `@FILE` is read on the CLI computer; paths *inside* the JSON refer to the daemon computer. Avoid secrets in command arguments; prefer stdin or a private request file.

### Files, Git and PTYs

```sh
miniq git status SESSION_ID
miniq git diff SESSION_ID src/main.rs --staged
miniq file list SESSION_ID src
miniq file list SESSION_ID src --after "RETURNED_NEXT_CURSOR"
miniq file describe SESSION_ID README.md
miniq file read SESSION_ID README.md --revision RETURNED_REVISION --offset 0
miniq tool list
miniq tool detail SESSION_ID TOOL_CALL_ID
miniq terminal create SESSION_ID --rows 24 --cols 100
printf 'pwd\n' | miniq terminal input SESSION_ID TERMINAL_ID -
miniq terminal read SESSION_ID TERMINAL_ID --offset 0 --wait-ms 1000
miniq terminal resize SESSION_ID TERMINAL_ID 30 120
miniq terminal close SESSION_ID TERMINAL_ID
```

File list returns a `nextCursor` string for `--after`. File read returns `dataBase64`, `nextOffset`, `done` and a revision; continue with `nextOffset` and the same revision until done. If the file changes, describe it again and restart the read. PTY read retains output page metadata; pass `stdoutPage.nextOffset` as the next explicit `--offset`. PTY input sends exact text, with a newline only if supplied. Creating a PTY launches a shell on the daemon computer; input executes there directly, and close terminates that PTY. These commands do not start an agent turn.

### Approvals, Reviews and Schedules

```sh
miniq approval inbox
miniq approval rules
miniq approval resolve APPROVAL_ID approve_for_session
miniq approval revoke RULE_ID
miniq review start SESSION_ID ASSISTANT_MESSAGE_ID REVIEWER_MODEL
miniq review list SESSION_ID --limit 20
miniq review get SESSION_ID REVIEW_ID
miniq review cancel SESSION_ID REVIEW_ID
miniq schedule create '{"workspaceId":"WORKSPACE_ID","name":"Daily check","prompt":"Check the build","schedule":{"type":"daily","time":"09:00"}}'
miniq schedule list
miniq schedule runs TASK_ID --limit 20
miniq schedule disable TASK_ID
miniq schedule enable TASK_ID
miniq schedule run TASK_ID
miniq schedule update @reviewed-task-settings.json
miniq schedule delete TASK_ID
```

Approval decisions are `approve`, `approve_for_session`, `always_allow_tool` or `reject`. Always-allow saves a tool rule; revoke removes that rule. Reviews request a separate model opinion on a completed assistant message and are read by polling `get`. Review listing and schedule runs return string cursors for `--cursor`; the approval inbox returns cursor JSON for `--before`.

Schedule create/update JSON contains `name`, `prompt` and `schedule`; create also requires `workspaceId`, while update requires `id`. A heartbeat additionally needs `mode: "heartbeat"` and `targetSessionId` for an active local session in that project. **Update replaces task settings**: include mode/target for an existing heartbeat and retain its memory explicitly; omitted mode becomes `newSession` and omitted memory becomes empty. Omitted `workspaceId` preserves the project. Enable/disable sends an explicit boolean; run starts an execution immediately. Delete removes the saved schedule, and is distinct from cancelling a running session.

### Memory, External Conversations, Projects and SSH

```sh
miniq memory list '{"target":{"scope":"global"},"limit":20}'
miniq memory list '{"target":{"scope":"workspace","workspaceId":"WORKSPACE_ID"},"limit":20}'
miniq memory delete @reviewed-memory-delete.json
miniq external scan
miniq external scan-status JOB_ID
miniq external import @selected-conversations.json
miniq external import-status JOB_ID
miniq workspace list
miniq workspace open /srv/project --name Project
miniq workspace create Scratch
miniq workspace rename WORKSPACE_ID "New name"
miniq workspace roots '{"workspaceId":"WORKSPACE_ID","paths":["/srv/project","/srv/reference"]}'
miniq workspace model-get WORKSPACE_ID
miniq workspace model-set '{"workspaceId":"WORKSPACE_ID","settings":{"model":"MODEL_ID","apiProtocol":"auto"}}'
miniq host list
miniq host save my-server
miniq host connect my-server
miniq host disconnect my-server
miniq host remove my-server
```

Memory addresses one exact global/project scope. Pass returned `nextCursor` as JSON `before` in the next request. Delete requires `target`, `id`, `expectedUpdatedAt` and `expectedContent` from the displayed record, protecting against deleting a changed record. External import accepts `{"sessions":[{"provider":"codex","externalId":"…","sourcePath":"…","workspaceId":"…"}]}`; supported provider IDs are `codex`, `claude_code` and `opencode`. Discovery/import return jobs to inspect with their status commands.

Workspace roots replace the **complete** root list: the first path is the primary directory and the remaining paths are additional directories. Existing sessions keep their working directory; new sessions use the new primary directory. Roots changes require idle project tasks; `--add-dir` is the additive chat alternative. Model-set replaces the project's model settings: omitted/null model inherits the global model, omitted/null effort uses the provider default, and omitted protocol becomes `auto`. `miniq workspace delete WORKSPACE_ID` deletes the project registration, its sessions/history, schedules and project memories according to daemon rules; project files remain on disk.

`host` (alias `ssh`) manages the daemon's saved aliases. **`host save` only registers an existing SSH configuration alias** in miniQ; SSH configuration stays authoritative and is edited separately. Remove deletes the saved registration and disconnects it. Disconnect closes the transport while remote tasks continue on their daemon. These commands do not edit `~/.ssh/config` or delete remote files.

### Skills, Plugins, Voice and Computer Permissions

```sh
miniq skills list --workspace WORKSPACE_ID --json
miniq skills read SKILL_NAME --workspace WORKSPACE_ID
miniq skills disable SKILL_NAME
miniq skills enable SKILL_NAME
miniq skills import /srv/skill-package
miniq skills create '{"goal":"Summarize this project consistently"}'
miniq skills distill '{"sessionId":"SESSION_ID"}'
miniq skills refine '{"sessionId":"SESSION_ID","name":"SKILL_NAME"}'
miniq skills job list
miniq skills job get JOB_ID
miniq skills job cancel JOB_ID
miniq skills validate @draft.json
miniq skills save @reviewed-draft.json
miniq skills delete SKILL_NAME
miniq plugins list --json
miniq plugins install /srv/plugin-package --update
miniq plugins diagnostics PLUGIN_ID
miniq plugins enable PLUGIN_ID --trust-code
miniq plugins reload PLUGIN_ID
miniq plugins disable PLUGIN_ID
miniq plugins uninstall PLUGIN_ID
miniq voice capabilities
miniq voice transcribe @audio-request.json
miniq voice speak '{"text":"The task completed","voice":"eve","responseFormat":"mp3"}'
miniq computer permissions
miniq computer request accessibility
```

Skill create/distill/refine return generation jobs. `skills job start` is the equivalent asynchronous entry with `kind: "create"|"distill"|"refine"`. Inspect the job result, then validate/save reviewed `{"content":"…"}` explicitly. `force: true` on save overrides sensitive-content warnings. Import can replace same-name user skills. Delete removes only user skills; project/bundled skills are protected. Enable/disable is a shared name-based setting.

Plugin install accepts a daemon-local package/directory; `--update` explicitly replaces an installed plugin. Enabling executable plugin code may require `--trust-code`. Uninstall removes the plugin; bundled plugins can only be disabled. Voice transcription takes `audioBase64`, optional `filename`, `preview` and `transcribeModel`; speech returns encoded audio with its metadata. `computer request accessibility|screenRecording` requests OS permission on the daemon computer. Native control still requires that computer's graphical session and permissions.

These commands expose shared daemon capabilities through terminal workflows. Desktop/mobile visual editors, previews and platform-specific interactions can still differ; use each command's `--help` for the supported parameters.

## Other Controls

```sh
miniq watch SESSION_ID --json
miniq cancel SESSION_ID
miniq history SESSION_ID --limit 40
miniq history SESSION_ID --before '{"at":"TIMESTAMP","id":"ID"}'
miniq models
miniq models MODEL_ID
miniq status
miniq tool list
miniq agent list SESSION_ID
miniq rpc remote.status
miniq completions zsh
```

History is paged; use the returned `nextCursor` in `--before` until null. Large tool payloads remain accessible with `session tool-detail`/`tool detail`. `rpc METHOD -` reads JSON parameters from stdin for advanced capabilities without shell-escaping large objects. Avoid putting secrets in its argv. Domain and management commands keep response cursors and full payloads; use each endpoint's pages/chunks to retrieve large data.

The daemon is loopback-only and authenticated. Discovery uses `MINIQ_DATA_DIR` (Unix default `~/.local/share/miniq`; Windows `%LOCALAPPDATA%/miniq`), `MINIQ_DAEMON_PATH`, the binary next to the CLI, then installed locations/PATH. `--no-start` makes diagnostics connect-only. An OS lock prevents concurrent daemons from recovering/overwriting the same active database. To test independently, use a new `--data-dir` and a mock provider, not a copy of a live database.

Terminal-only servers can use file, code, document, model, MCP and existing browser automation tools; browser automation needs an installed compatible browser. Native computer use needs a logged-in graphical session and screen/accessibility permissions. SSH, containers, mobile browsers and WSL do not gain control of an unrelated desktop by installing the CLI. Mobile remote access still uses miniQ's authenticated relay; it is not a public shell service. `doctor` checks permission state without requesting changes or restarting processes.

## iPhone and iPad

The released miniQ app is available on the [App Store](https://apps.apple.com/cn/app/miniq/id6811485613) for iOS / iPadOS 15 or later. Mobile chat works independently of a computer. To access remote tasks, enable **Settings → Services & remote → Allow remote connections** on the computer, use the same Zaiwen API key on both devices, and keep the computer online and awake. The mobile app can view and continue tasks on that computer, including responding to questions and approvals.

The terminal client runs tasks on the computer or server where it is installed. The mobile app is a remote client of those computers; it does not install `miniq` or run desktop tools locally on iPhone or iPad.

### Terminal-only servers (no desktop app)

Remote access is provided by `miniq-daemon`, so a server with only the terminal package can also be reached from the mobile app. It is off by default. In a terminal chat, enter `/remote` to open the settings menu. Select an action to enable or disable access, change the device name, or refresh connection status. `/help` lists this command.

The setting applies to this computer's shared daemon, including its other sessions and desktop client. It does not change the session's approval mode. Use the same Zaiwen API key on the phone and computer.

Inside a chat, these commands also work directly:

```text
/remote on
/remote name my-server
/remote status
/remote off
```

Outside a chat, configure remote access with:

```sh
miniq configure                      # save the same Zaiwen API key used on the phone
miniq rpc settings.update - <<'EOF'
{"remoteAccess":{"enabled":true,"relayUrl":"wss://oneapi.zaiwenai.com/miniq-relay/ws","deviceName":"my-server"}}
EOF
miniq rpc remote.status              # should report the relay as connected
```

`deviceName` is the name shown on the phone (1–80 characters). Without a saved API key the status stays waiting for a key. Keep the daemon running and the server online; after a reboot run any `miniq` command (for example `miniq status`) to start it again. To turn remote access off, enter `/remote off` in a chat. The phone can view and continue tasks, answer questions and approvals, and browse files on the server; native computer use still requires a graphical session on that server.

## Multiple Remote Computers

Desktop and terminal daemons can use the same API key on separate computers. Each daemon has its own device identity, sessions, files and approvals. Give each computer a recognizable `deviceName` when enabling remote access.

1. Enable remote access on each computer with the same saved API key.
2. Open the mobile or browser remote client with that API key.
3. Select a computer from the device list.
4. Use the computer name at the top of the workspace to switch computers.

The client remembers the selected computer. If that computer goes offline, the client shows its offline state and reconnects to that computer. Switching computers leaves tasks running on the previous computer. Notifications identify their source computer; viewing another computer does not cancel an existing notification subscription.

The relay device list is separate from SSH connections configured inside a computer's workspace. Update the relay and clients together for multi-device selection. An older client cannot select a computer when its account has multiple known devices.

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

CLI tests cover command parsing, domain RPC mapping, typed JSON validation and preservation of long content/cursors. Mock-daemon tests cover busy policies, queued responses, uncertain send outcomes, safe update activation and retained failures. Management tests cover queue concurrency checks, goal state, sharing and complete history/tool output. Run the relevant CLI/daemon tests and formatting checks after behavior changes; the release workflow provides the platform build/runtime validation.

For end-to-end checks, use an isolated installation/data directory and a local fixture provider. Verify headless startup, configuration, final stdout/JSONL, shared project/session discovery, reconnect without replay, retained failures, queue/approval handling and update activation before applying the build to shared work. The terminal starts its daemon in a separate process group so terminal interrupts do not signal the shared backend. The SSH smoke described above also uses isolated keys and data; it can verify transport reconnects without restarting tasks. Platform-specific results should identify the platform actually exercised.
