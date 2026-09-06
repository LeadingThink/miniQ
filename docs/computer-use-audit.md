# Computer Use Implementation Audit

Date: 2026-09-06. Baseline: `4c62c6607ee88cfea3165e675fb8b8fd2152511f`.

## Comparison Basis

The previous miniQ implementation was primarily a DOM-based browser tool with one
shared Chrome session. It did not provide a complete screenshot-to-model feedback
loop or an approved native desktop input tool. Those are concrete implementation
gaps; they do not establish a general benchmark ranking against ChatGPT.

Official OpenAI documentation informed the observation/action/result loop,
coordinate discipline, untrusted-screen handling, and approval boundaries:

- https://developers.openai.com/api/docs/guides/tools-computer-use
- https://developers.openai.com/api/docs/guides/function-calling

The documentation permits either the native computer tool or a custom execution
integration. This change uses miniQ function tools and each provider's supported
multimodal message format. It does not inspect or reproduce proprietary ChatGPT
internals, and does not claim equivalent task-success rates.

## Delivered Capabilities

| Area | Implementation |
| --- | --- |
| Browser isolation | Separate visible Chrome profile and active tab per task, including child-agent task namespaces. Personal browser and preview webview remain separate. |
| Browser observations | Viewport screenshot, URL, title, viewport dimensions, paginated DOM targets and page-text lines; password values excluded from DOM output. |
| Image control | `includeScreenshot=true` sends browser evidence to a vision model; text-only models can use DOM output without attaching images. `screenshot` always attaches an image. |
| Browser actions | Target or coordinate click, double-click, move, drag, Unicode typing, contenteditable fields, key modifiers, select, scroll, history and bounded waits. |
| Tabs | List, create, switch and close task-owned tabs; closing the active tab chooses another tab or creates a blank one. |
| Freshness | Interaction consumes the latest observation ID. Old IDs, expired observations, changed URL/tab/viewport/scroll/document identity are rejected. |
| Target validation | Snapshot-generated target IDs only. Disabled, obscured and non-editable targets are rejected before sending input. |
| Native desktop | Display listing, capture, mouse/keyboard input, scrolling, dragging, waits and explicit release through `computer_use`. This is the real desktop, not a sandbox. |
| Desktop ownership | A 120-second task lease and OS file lock prevent overlapping miniQ tasks/processes from controlling the same desktop. |
| Desktop coordinates | Screenshot-pixel to display-coordinate conversion, including Retina scaling and negative monitor origins. Windows uses thread-local DPI awareness and virtual-desktop pointer positioning. |
| Desktop freshness | Display layout and focused-window identity/bounds must still match; keyboard focus must be on the observed display. |
| Cancellation | Cooperative cancellation checks and button/modifier release; desktop lease expires or releases on cancellation. Idle/cancelled task browsers are closed independently. |
| Approval | Native capture/input are high-risk; status/release are low-risk. Browser approval scopes use the actual observed origin, not a model-supplied URL. Existing approval modes remain authoritative. |
| Plan mode | Observations can be inspected, but browser/desktop mutations are blocked. Desktop capture still passes the normal high-risk approval gate. |
| Provider transport | Claude image blocks inside `tool_result`; Responses image parts inside `function_call_output`; Chat Completions images after the complete tool-result batch. |
| Optional fields | Generated schemas preserve action-dependent requirements and runtime defaults. Responses explicitly uses `strict: false` to prevent server schema normalization from changing optional fields. |
| Screenshot storage | UUID filenames, host-owned observation storage outside the workspace, Unix mode 0600, explicit 20 MB limit. No base64 payloads in tool events or stored text output. |
| Screenshot access | `observation.read` verifies the session/tool-call association and producing tool, validates the file, and serves bounded 256 KiB chunks. No arbitrary file-path parameter. |
| Timeline | Expand execution details to load screenshots, inspect original size, download or retry. Loading/error states, cancellation and Blob URL cleanup are covered. |
| Responsive UI | Desktop, 390 px and 320 px checks; original-size image scrolling stays within the screenshot surface. |

## Verification

All tests use isolated files, in-memory databases, mock providers or a test-only
browser fixture. Native mouse/keyboard events were not sent to the user's working
desktop, and no installed miniQ process was restarted or replaced.

| Check | Result |
| --- | --- |
| `cargo test -p miniq-tools -p miniq-models -p miniq-agent -p miniq-daemon --lib` | 229 passed; 2 opt-in tests skipped by default. |
| Explicit `browser::tests::visible_browser_roundtrip -- --ignored` | Passed in real Chrome: target/coordinate clicks, double-click, drag, Unicode/contenteditable input, select, tabs, pagination, password exclusion, stale IDs, scrolling and changed-document rejection. |
| Screenshot pixel checks | Captured PNG is nonblank; scrolled viewport contains the fixture's bottom marker rather than the document top. |
| Desktop fake backend | Lease exclusion, OS lock exclusion, stale frames, changed focus, coordinate mapping, cancellation/release and permission risk classification passed. |
| Approval regression | Unapproved screenshot/input calls rejected before reaching the desktop backend. |
| Screenshot RPC | Exact multi-chunk roundtrip, invalid offset, symlink rejection, wrong session and wrong producing tool covered. |
| Provider/agent tests | All three image wire formats and screenshot delivery into the next model request and persisted provider history covered. |
| `npx vitest run` from `apps/desktop` | 147 passed in 31 files. |
| `npm run build` from `apps/desktop` | TypeScript check and production build passed; existing large-chunk warnings remain. |
| Strict Clippy on the four affected Rust crates | Passed with `--lib --tests -- -D warnings`. |
| `cargo check --workspace` | Passed on macOS ARM64. |
| Native Tauri shell | Type check passed with `TAURI_CONFIG='{"bundle":{"externalBin":[]}}'` in the isolated checkout because no installer sidecar is staged. This is not installer validation. |

To run the real browser regression, install Chrome and run from the repository
root:

```sh
cargo test -p miniq-tools browser::tests::visible_browser_roundtrip -- --ignored --nocapture
```

`MINIQ_BROWSER_TEST_ARTIFACTS` optionally identifies a directory for the captured
fixture screenshot. The test never attaches to a personal Chrome profile.

## Remaining Boundaries

- Native provider `computer_call` / Anthropic beta computer-tool declarations are
  not enabled by this change. Portable function tools are implemented; full native
  protocol parity is not claimed.
- Windows/Linux desktop execution and OS permission flows need dedicated machine
  validation. macOS native input was intentionally not exercised on the user's
  active desktop. Linux native input requires X11; Wayland input returns an
  explicit unsupported error.
- This is not a desktop accessibility-tree implementation, continuous video
  streaming, VM sandbox, or automatic personal-browser attachment. Browser DOM
  targets cover the current document, not cross-origin frames or closed shadow
  roots; visual interaction is available for visible content.
- A screenshot and subsequent action cannot be atomic with arbitrary external UI
  changes. The application validates freshness/focus/layout, but the model must
  still inspect results and stop for consequential actions.
- Screenshot history remains in private local storage; a user-facing retention
  and cleanup policy is not included. Provider vision availability, image limits,
  charges and oneAPI forwarding behavior depend on the selected upstream.
- Live external-model requests, remote relay throughput and new installers were
  not validated in this task. The browser preview is an isolated fixture, not a
  connection to the running miniQ daemon.

No application version, release tag, updater metadata or release workflow changed.
