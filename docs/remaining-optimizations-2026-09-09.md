# Remaining Optimization Acceptance

Baseline: `c238620` / 0.1.22. This consolidates overlapping items in
`experience-improvement-ledger.md` and `experience-computer-use-2026-09-08.md`.
The user confirmed all remaining items are in scope. Planned work is not delivery.

| Workstream | Original IDs | Acceptance | Status |
| --- | --- | --- | --- |
| Permission recovery | B01-B03, M20 | Accurate process status; no fake grants; idle-safe recovery | Detection/refresh implemented; stable signing deferred by user |
| Execution diagnostics | M05, M11, B17 | Per-request model/protocol/effort, provenance, actual usage distinct from estimates, compaction/retry/stop records | Implemented and regression-tested |
| Durable child agents | M09, B18 | Restart-safe identity, history/checkpoints, duration, tool ownership and scoped navigation | Implemented and regression-tested |
| Preview workspace | M14, B12-B13 | Per-session tabs and view positions; browser state retained without cross-session leakage | File state implemented; browser persistence still pending |
| Local HTML resources | M15 | Relative assets resolved within authorized roots and isolated from app origin | Implemented; real resource/interaction QA passed |
| Large PDF | M17, B14 | Bounded rendering/search memory, cancellation and failed-render recovery | Implemented and regression-tested |
| Spreadsheet inspector | M18, B15 | Per-column filters, stable sorting, full-data export and original cell identities | Implemented and regression-tested |
| Media inspector | B16 | Fit/native/zoom, dimensions, metadata, failed decode retry and URL cleanup | Implemented and regression-tested |
| Browser evidence | M19, B07, B13 | Same automated/inspected tab identity, navigation, evidence and explicit takeover | Pending |
| Native semantic control | B05 | App/window/AX observation, scoped element identity, stale-element rejection | Pending |
| Session safety | M20 | Per-session approval policy, centralized pending review and interruption recovery | Implemented and regression-tested |
| Dependency security | M20 | Fresh audit, targeted remediation and regression tests; no forced downgrade | Remediated; fresh npm audit: zero vulnerabilities |

## macOS Evidence

System Settings showed both miniQ permission toggles enabled. Read-only inspection
found the bundle grants bound to an older ad-hoc code requirement (`396b6e8c...`).
Installed 0.1.22 desktop code has cdhash `572519db...`, the daemon `1439b682...`.
The installed app has no Developer ID team identity, and bundle verification fails
because the linker signature does not seal the app resources. No TCC record was
modified. No security setting was changed by the agent.

The live daemon was older than the reopened desktop window. After checking all
58 sessions, their children and queues were inactive, an ordinary daemon shutdown
and desktop reconnect changed screen recording from denied to granted. Accessibility
remained denied. Thus process refresh fixes the stale screen-recording state, but
does not repair the old accessibility code requirement.

Developer ID signing/notarization requires credentials absent from the local
keychain and CI. The user explicitly deferred this work until they have an Apple
Developer account/certificate. It must not be represented as fixed or replaced by
a weakened signing requirement. Tauri updater signatures are a separate mechanism.

## Verification

The first hardening batch was published and deployed as 0.1.23 on 2026-09-09.
The follow-up idle-update guard below is merged separately and is not released.
No production task is used as a write-test fixture. Existing user edits in the
original miniQ checkout are preserved.

- Frontend: 72 Vitest files / 549 tests, 6 manifest tests and 26 Qiniu publisher
  tests passed. TypeScript and production Vite build passed.
- Rust: `cargo test -p miniq-daemon -p miniq-memory -p miniq-models
  -p miniq-protocol -p miniq-agent` passed, including integration tests.
  Library counts after upstream integration: daemon 126, memory 21, models 63,
  protocol 5, agent 41.
- Desktop shell: 16 library tests passed, including five HTML resource tests.
- `cargo check --workspace`, formatting checks and `git diff --check` passed.
- Fresh audit against `https://registry.npmjs.org`: zero vulnerabilities.
- Desktop/mobile component QA at 1280, 390 and 320 pixels: diagnostics, execution
  events, child history, permission menus, previews and approval detail controls.
  A real screenshot exposed squeezed search and broken Chinese action labels;
  flexible toolbars and container-responsive approval actions fixed both.
- Real upstream PowerPoint: 14 slides, 185 SVGs, four decoded images; two charts
  with nonzero dimensions and 32/34 paths. Renderers now retain attached hidden
  staging until chart initialization completes, and clean it up on cancellation.
  Switching to Word rendered its real table and left no old charts/staging nodes.
- Real local HTML fixture: relative CSS, module import, JSON fetch and a 512px
  PNG all loaded; a button click changed the counter. Each preview has a distinct
  loopback origin, opaque sandbox, revocable capability and read-only access to
  static assets under the document directory (not the entire workspace).
  Traversal, external symlinks, wrong hosts/tokens and POST are rejected.
  Range/HEAD requests work; a 128 MiB media fixture streams bounded chunks and
  stops its response when revoked. Cross-directory and root-absolute asset URLs
  are not exposed implicitly; this is a static preview, not a backend dev server.

## Release And Deployment

- Source/tag: `3aacd1f2a299496fbdc17699e8c7b5b181e5ce50` / `v0.1.23`, PR #24.
- Workflow https://github.com/LeadingThink/miniQ/actions/runs/34335502404
  completed successfully, including all four desktop targets and publication.
- Published non-draft mirror:
  https://github.com/LeadingThink/miniQ-releases/releases/tag/v0.1.23.
  Verified 20 assets, including Windows installer/signature, four updater targets,
  both macOS architectures, Linux installers and four terminal archives/checksums.
- All 19 versioned Qiniu assets exist with the same sizes as the mirror. Both
  `https://oss.zaiwen.top/releases/miniq/latest.json` and
  `https://oss.zaiwen.top/latest.json` return 0.1.23. The primary/mirror manifests
  reference matching filenames and signatures under their respective release
  URLs. Downloaded macOS ARM app archive, DMG and terminal archive match the
  SHA-256 digests recorded by GitHub.
- `https://oss.zaiwen.top/releases/manifest.json` now advertises desktop 0.1.23
  for the Zaiwen download page; existing Android and other-product entries remain.
- Mobile site on `119.29.21.235` now points to
  `/var/www/miniq-mobile-v0.1.23-3aacd1f`. Previous assets and the previous service
  directory remain for open tabs and rollback. The public index, entry JavaScript
  (879578 decoded bytes) and CSS (133924 decoded bytes) match the built files by
  SHA-256; ordinary HEAD sizes are not used to validate gzip-encoded assets.
- Local app and terminal are installed at 0.1.23. Before replacement, all 60
  sessions, children and queues were checked idle; the old daemon shutdown
  confirmed zero cancelled turns and zero cancelled children. The old app,
  terminal and complete daemon data are backed up in
  `/Users/xuzhanwei/.local/share/miniq-backup-0.1.22-to-0.1.23.FEHQh2`, including
  a consistent SQLite backup. Pre/post-install integrity checks returned `ok`.
- Native UI shows daemon v0.1.23 and the new approval inbox. All 60 sessions
  remain (48 idle, 12 historical failed); relay state is `connected`.
- The new unsigned execution process reports Screen Recording and Accessibility
  as denied. This is the actual OS preflight result, not stale UI state. No TCC
  data or security setting was changed; stable signing remains deferred.

## Persistence And Isolation

- Child metadata, full history, result, checkpoints, inbox and worktree identity
  survive restart. Interrupted tasks hold unsent messages without auto-replaying
  potentially consequential work. History pages use a revision to reject stale
  indexes after compaction; one 1.6M-character tool body does not inflate the list.
- Queue dequeue, conversation append, attachments and source audit commit in one
  transaction. Failed writes leave the queue unchanged.
- Model diagnostics distinguish advertised limits, local estimates and exact
  provider usage; traces include model/protocol/effort, step, attempt and purpose.
  Duplicate request IDs cannot silently move to another session or child.
- Session approval overrides persist independently of global defaults. An explicit
  null restores inheritance; policy changes clear only that session's allowances.
  A child acceptEdits policy cannot override the session's AlwaysAsk requirement.
  Unattended CLI submission also validates the effective session policy, not just
  the global default, both before preparation and before sending.
- The pending approval inbox is cursor-paginated and loads tool parameters only
  on expansion. Duplicate decisions are disabled; resolved/stale entries refresh.
- Merged upstream model catalog change `5f23f74`, then preserved editable custom
  model IDs with list suggestions and cancelled stale endpoint/key requests.
  The integration and request-cancellation tests passed.

## Still Outstanding

An additional post-0.1.23 fix adds atomic idle-only updater shutdown. The older
`daemon.shutdown` command cancels tasks; it must not be described as idle-safe.
The new admission gate covers requests, main turns, child startup/execution and
scheduled runs, checks pending queues without loading their contents, and rejects
new admission after an idle shutdown succeeds. It never falls back to cancellation.
Tests include a main/child lifecycle case, concurrent admission, retained queues,
late submissions, and frontend updater refusal/reconnect. This addition is not
part of tag v0.1.23 and must be released separately. It is merged in PR #25
(`a883ac2`, implementation `4011ac1`). Daemon tests (130 library plus integration),
memory tests (21 library plus 10 integration), 12 updater tests, TypeScript,
workspace check, Rust formatting and diff checks passed.

Browser page navigation/login persistence, shared automation/inspection tab
identity, explicit takeover, and native macOS AX element control remain unfinished.
Developer ID signing/notarization remains explicitly deferred by the user.
Do not mark the combined roadmap complete based on the passed tests above.
