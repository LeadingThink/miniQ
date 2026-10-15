# Managed command and agent sessions

## Commands

All commands now use the same `ProcessManager`; there is no parallel foreground implementation.

- `shell_run({command, timeoutSecs})`: one-shot behavior, default 60 seconds; kills the process group on timeout. Partial output remains replayable.
- `shell_run({command, yieldTimeMs})`: wait at most this many milliseconds, then return output and a running handle if needed. This is not a kill deadline.
- `runInBackground: true`: return immediately.
- `interactive: true`: keep pipe stdin open. Otherwise stdin remains closed so existing batch commands do not hang waiting for EOF.
- `tty: true`: use portable-pty (Unix PTY / Windows ConPTY). stdout and stderr are merged into stdout. `rows`/`cols` default to 24/80, range 1..1000.
- `process_input({id, chars, eof, yieldTimeMs})`: write, optionally close stdin, wait, and read the next page. Empty input polls even after process exit. PTY EOF sends Ctrl-D; terminal control characters such as Ctrl-C are interpreted by the terminal, not by pipes.
- `process_resize({id, rows, cols})`: resize a PTY.
- `process_kill({id})`: terminate owned work; Unix process groups and Windows taskkill `/T /F` cover descendants. Daemon shutdown explicitly stops all managed jobs.

Handles are scoped to the originating session and agent. They can be reused across turns in that scope, but do not survive daemon restart. This is a live process session, not restoration of arbitrary OS processes after a crash. Each command still starts a fresh shell unless an explicit interactive shell is launched.

## Output pages

Output is stored in private temporary files for the daemon lifetime instead of unbounded in-memory buffers. The daemon does not send archive filesystem paths to the model.

`process_output` accepts independent byte offsets `stdoutOffset` and `stderrOffset`. Without offsets, it consumes the next page; explicit offsets allow replay without advancing the implicit cursor. Only one copy of display text is returned in `stdout`/`stderr`; page objects contain metadata, not duplicate text. `raw=true` explicitly requests base64 pages instead of text for lossless binary recovery. UTF-8 tails continue in the next page; invalid text carries a binary-recovery notice.

`maxOutputTokens` is **an estimate**, implemented as 4 bytes per token **per stream**, default 4096, range 1..65536. It is not an exact tokenizer or combined stdout/stderr limit. `hasMore`, `nextOffset`, `totalBytes`, and `archiveRef` expose the rest without discarding it. `outputPending` indicates that an inherited pipe/terminal is still open, even if the original shell has exited. Read errors are reported in the page metadata and make `ok` false.

`block`/`timeoutSecs` remain available to `process_output`; use either seconds or `yieldTimeMs`, not both. `shell_batch` preserves each command's handle, page metadata and archive reference. Its `maxOutputLength` is a byte-page estimate rounded up to a 4-byte budget.

No new live-output WebSocket event is introduced by this change: tools return pages, and the model can poll the running session. The frontend renders process input/output results as command output rather than an opaque JSON-only tool.

`process_output` accepts only shell process handles. `agent_result({id})` retrieves an agent's complete result and status without blocking, with no process-output budget or cursors. `agent_wait({ids, timeoutMs})` waits for any outstanding agent; remove collected IDs from later waits. Agent result reads can overlap; shared-cursor process reads stay ordered. Native `TaskOutput` is routed by handle type to the matching contract.

When a page has unread data, `outputNotice` explicitly marks it as partial and `nextPage` provides an executable tool name/argument object. `shell_batch` preserves this notice on each command result, and the UI shows it for batch results too.

## Permissions

Nonempty stdin or EOF is a high-risk action and uses the ordinary approval pipeline. Approval scope includes the process ID. Empty reads remain low risk. Plan mode allows reads but denies stdin mutation and interactive shell startup. Process ownership is checked in the runtime even if a caller bypasses tool risk evaluation. Input writes have a 10-second stall bound; cancellation/stall stops the process and reports that bytes may have been partially written. It must not be blindly retried.

A shell/PTY is not an OS sandbox. Existing miniQ workspace and approval controls still apply; this does not grant a new sandbox escape permission. Credentials must not be supplied automatically just because stdin exists.

## Provider-native names

| Name | miniQ behavior |
| --- | --- |
| `exec_command` | `shell_run`, maps cmd/workdir/yield_time_ms/max_output_tokens/tty; default initial wait 1000ms and interactive pipe stdin |
| `write_stdin` | `process_input`, maps session_id/chars/yield_time_ms/max_output_tokens |
| `spawn_agent` | `agent_run` in background; maps message/agent_type/model; returns agentId plus agent_id |
| `wait_agent` | `agent_wait`, ids + timeout_ms; waits for any target to finish/fail/stop, returns status map and timed_out |
| `send_input` | `agent_message`; id or target + message; running child queues follow-up, idle child resumes |
| `close_agent` | `process_kill`; stops child and its subtree through the existing agent manager |

These are supported subsets, not a claim of full Codex wire compatibility. Process IDs are miniQ string handles (not Codex integer session IDs); results preserve miniQ metadata. `login=true`, shell selection, sandbox escalation, `fork_context=true`, rich agent items and `send_input(interrupt=true)` remain explicitly unsupported. `send_message` and `interrupt_agent` are not aliases: Codex v2 mailbox-only delivery and current-turn interruption differ from miniQ's follow-up/subtree-stop behavior. `wait_agent` is final-status waiting, not the v2 mailbox notification API.

## Validation

Portable tests cover aliases, budgets, schemas, agent waiting/cancellation and validation. Unix runtime tests exercise stdin, EOF, incremental/replayed output, ownership, timeout, process-group cancellation, inherited pipes, PTY input and resizing. Windows ConPTY and taskkill are implemented but require Windows runtime validation; macOS tests do not establish Windows behavior.
