# Companion integration contract

Baseline: origin/main 58a15ef. Companion owns its native module, separate route, UI/settings/helpers/tests and prefs. It does not mount ConnectedApp, useMiniqApp, notification/sound hooks, or LivingBackground. General Settings adds only `<CompanionSettings />`. The original Alt+Space toggle remains unchanged.

## Main-window navigation (integrator action required)

`main.tsx` calls `initializeCompanionBridge()` only on the regular main route. Rust `companion_open_main` emits **only to `main`** the Tauri event `companion:navigate`, then shows/unminimizes/focuses the existing main window. The bridge validates its payload and dispatches DOM `miniq:companion-navigate`.

Mount `subscribeCompanionNavigation(handler)` in the main app's useMiniqApp/navigation owner. It replays the latest event received before that consumer mounted. The handler must retain requests until the LOCAL catalog is ready, choose the local host explicitly, refresh known projects/sessions if needed and validate workspace/session pairing before navigating. It must never resolve IDs against an SSH or mobile/relay host just because that host is currently selected.

Payload is the `CompanionDestination` discriminated union exported by `src/companionBridge.ts`:

```ts
{ action: "session", sessionId: string, workspaceId: string }
{ action: "settings" }
{ action: "voice", workspaceId: string, sessionId?: string | null }
```

- `session`: resolve both local IDs and open that exact conversation.
- `settings`: show existing main Settings, provider/API Key entry. No new configuration system.
- `voice`: open the existing main Composer for the specified local project/session and expose/focus its existing VoiceInput control; the user starts recording with the usual explicit click. Companion itself never records or listens globally. Its button says **在主窗口语音输入**.

The module intentionally leaves useMiniqApp untouched because it belongs to the integration owner. Without this consumer, native main-window reveal works but session/settings/voice navigation is not complete.

## Cross-window inbox (adapter action required)

`CompanionWindowProps` is the seam for the other agent's `companionInbox.ts`:

```ts
notices?: readonly {
  id: string; sessionId: string; workspaceId: string;
  state: "idle" | "running" | "needs_input" | "failed" | "ready";
  text: string;
}[];
onNoticeOpened?: (id: string) => void;
modelLabels?: Readonly<Record<string, string>>; // key: LOCAL session ID
```

Pass only local notices, ordered newest first. All supplied entries render in a scrolling inbox. The latest entry drives the avatar state. Successful navigation invokes `onNoticeOpened(id)`; failed main-window reveal preserves the inbox entry. The component creates no OS notifications or sounds. No file named companionInbox.ts is created by this branch.

Without injection the independent local socket lists sessions and maps their statuses. live question requested/resolved events maintain needs_input; running->idle and provided turnCount mark ready. A freshly opened companion cannot recover unresolved question details or a completed-turn count absent from session.list; the shared inbox adapter can provide that persisted state.

## Daemon RPC and model inheritance

A dedicated `RpcClient` connects with `{ kind: "local", port, token }` returned by the existing Tauri `daemon_connection` command. It never calls resolveConnection or reads remote credentials. Only four RPC methods are used:

- `workspace.list` and `session.list` for local catalogs (5 second reconciliation).
- `session.create({ workspaceId })` with NO modelSettings override, cwd fallback or root access.
- `session.sendMessage({ sessionId, message: { role: "user", content, attachments: [] }, rejectIfBusy: true })`.

Project choice starts empty and shows its path. Only existing selected workspace IDs and matching local unarchived/non-external session IDs are accepted. A send failure preserves the exact input and any successfully created session ID; explicit retry reuses it. A live turn_failed event also restores the latest accepted input once if the user has not typed a newer draft, covering asynchronous missing-provider failures. Sends are not automatically retried, and ambiguous delivery advises checking the main conversation first.

Current list/create responses do not include the effective model name. The UI states project/session default inheritance instead of inventing a name. It displays actual names supplied through modelLabels or live model_settings_changed events, and tells the user full model configuration is in the main window. Reading session.model.get would exceed the specified RPC budget and was not added.

## Native commands, prefs and window behavior

Fixed native labels: main, companion. `companion_get_prefs`, `companion_set_mode`, `companion_open_main` and daemon_connection validate callers; `companion_expand` accepts companion only. The generated app invoke handler explicitly rejects every other app command from the companion window. No caller can inject arbitrary labels/destinations.

Companion capability permits only event listen/unlisten and dragging. No filesystem, shell, updater, notification, remote origin, generic show/focus, or arbitrary emit capability is granted. Main reveal is the narrow native command above. Companion navigation permits only the local app origin with `?companion` (localhost:1420 is allowed in dev).

Preferences are in the native app config directory's `companion-prefs.json` (mode and physical desktop position), separate from sound/daemon preferences; default is hidden. Settings selection and tray **Show companion** are explicit opt-in; tray enables pet when previously hidden. Window startup/show does not call set_focus. User clicking the character expands the textarea and focuses that input. Drag handle uses startDragging; physical position is saved, restored/clamped to nearest monitor work area, accounting for that display's scale, negative coordinates, small displays and detached monitors. Collapsed size is 104x112 logical; expanded is 360x540 logical; content scrolls when needed. Hiding preserves drafts within the existing webview. Application restart does not persist text drafts.

On macOS true native transparent webviews require Tauri macos-private-api; this branch does not enable it or use platform private bindings. macOS gets a normal borderless window with transparent CSS; its window background can remain opaque. Non-macOS builds use public transparent(true). Focus behavior, mixed-DPI/hotplug and OS compositing still require packaged-device validation.

The SVG pet is original inline artwork. All avatar animations stop under prefers-reduced-motion: reduce; text/state indicators remain available. No external asset downloads.

## Offline fixture

From apps/desktop: `npm run dev -- --port 1421 --host 127.0.0.1`, then open `/src/components/companion/companion-preview.html`. The fixture injects local fake RPC responses, failure and status controls, captures navigation payloads, and never calls a real daemon/native app/microphone/preferences. It is not linked from production main routing.
