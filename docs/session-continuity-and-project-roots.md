# Session continuity and project directories

## Comparison basis

The locally installed ChatGPT app's bundled `codex` exposes `--cd` and
`--add-dir`. Its generated app-server schemas expose persisted project `roots`,
thread working directories and interrupted turn states. This establishes the
public contract, not knowledge of the application's proprietary internals.

Official references:

- https://learn.chatgpt.com/docs/projects
- https://learn.chatgpt.com/docs/long-running-work

## Interrupted turns

Previously miniQ saved the provider transcript only after a successful final
answer. Cancelling could leave visible tool records without their model-facing
results. A new turn also unconditionally cleared the checklist.

The runner now checkpoints complete provider transcripts before dispatch and
after each tool result. A sequential interruption retains completed results;
a parallel failure does not discard successful siblings. Every native tool call
has a paired result, including explicit `not_started` or `unknown` outcomes.
Unknown execution is not a guarantee of rollback: the next turn must inspect
actual state before repeating a side effect.

Terminal errors preserve partial assistant text without incomplete provider-native
blocks. The daemon saves partial messages and their context anchors atomically,
then publishes the message after streaming events have drained. A failed
checkpoint stops further tool dispatch. Successful completion replaces the
provisional snapshot. Compaction failures leave the pre-compaction history intact.

Follow-up requests retain the checklist and confirmed tool results. The latest
user request controls what happens next; miniQ does not programmatically requeue
the interrupted task. Child agents use the same checkpoint interface for their
in-memory resumable history. This does not make child-agent records durable
across daemon restarts.

## Multiple directories

`Workspace.path` is the primary directory; `additionalPaths` contains explicitly
attached roots. `workspace.updateRoots` receives an ordered, nonempty `paths`
array, canonicalizes and deduplicates it, and emits `workspace_updated`.

New sessions capture the current primary in `workingDirectory`. Existing
sessions keep their cwd, including Git and skill-discovery defaults. A root used
as an existing session's cwd cannot be detached. Directory changes are blocked
while the project has active main or child tasks. Remote clients may inspect the
roots but cannot expand local filesystem access; edits remain desktop-only.

Relative paths resolve from session cwd. Absolute paths can address any attached
root. File tools, search, patches, document tools, shell cwd, Git cwd, child agents,
checkpoints and desktop file previews share these semantics. Isolated child
worktrees replace the source checkout, retaining only independent attached roots.
Path resolution checks canonical targets, including existing ancestors of new
files, and rejects symbolic-link escapes. This path checking is not an OS-level
sandbox for arbitrary shell programs.

Migration 0010 backfills existing session working directories. Each migration and
each message/context checkpoint is transactional. No existing messages, tool
records or project files are removed. Application version numbers are unchanged.

## Validation

- Agent checkpoint, retry, cancellation and tool-call pairing tests.
- Daemon interruption/follow-up, event ordering, session isolation and plan tests.
- SQLite restart, migration, atomicity, root persistence and cwd tests.
- Multi-root file, edit, patch, search, shell and Git tests.
- Desktop preview tests for attached roots and relative cwd.
- Frontend tests, TypeScript check, production build and desktop/mobile browser checks.

The development-only `project-preview.html` exercises the directory editor with
in-memory fixtures. It does not connect to the running daemon or modify projects.
No public release, installation or restart is part of this change.
