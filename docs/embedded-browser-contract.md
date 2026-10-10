# Embedded browser: Phase 1 contract

Goal: make the miniQ embedded browser behave like a normal browser, matching
the ChatGPT desktop browser where Tauri 2.11 / wry 0.55 allows it.

Research reports:
- `/tmp/miniq-browser-research/chatgpt-browser.md`
- `/tmp/miniq-browser-research/miniq-browser.md`

## File ownership

| Owner | Files |
|---|---|
| Rust | `apps/desktop/src-tauri/**` (browser.rs, browser_links.js, lib.rs, Cargo.toml, Info.plist, new modules) |
| Frontend | `apps/desktop/src/**` |

Do not edit files owned by the other side.

## Rust → frontend events

All events are emitted to the main window with `app.emit_to("main", NAME, payload)`.
Payload fields use camelCase. `viewId` is the id passed to `browser_open`.

| Event | Payload | When |
|---|---|---|
| `browser://page-load` | `{ viewId, url, phase: "started" \| "finished" }` | `on_page_load` |
| `browser://title` | `{ viewId, title }` | `on_document_title_changed` |
| `browser://new-window` | `{ viewId, url }` | `window.open`, `target=_blank`, context menu "open in new window". Rust denies the native window. Frontend opens a new in-app tab with `url`. |
| `browser://download` | `{ viewId, id, url, fileName, path, phase: "started" \| "finished" \| "failed" }` | `on_download`. `id` is stable across phases of one download. |
| `browser://external` | `{ viewId, url }` | Non-http(s) link such as `mailto:` or `tel:`. Rust already opened it with the OS. Frontend may show a short notice. |

## Frontend → Rust commands

Existing command `browser_action { viewId, action }` gains these actions.
It still returns `BrowserState { url }`.

| action | Effect |
|---|---|
| `zoom_in` / `zoom_out` / `zoom_reset` | Steps: 0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0 |
| `print` | `Webview::print` |
| `devtools` | Open web inspector for this view |
| `clear_data` | Clear cookies and site data of the shared browser profile |

`BrowserState` gains an optional field `zoom: number` (current factor) for zoom actions.

New command `browser_reveal_download { path }`: reveal a finished download in Finder / Explorer.
Path must be inside the download directory.

## Behavior changes (Rust)

1. Persistent shared profile: logins survive tabs and restarts.
   - Not incognito.
   - macOS 14+: one fixed `data_store_identifier` for all browser views.
   - Windows/Linux: one shared `data_directory` (`browser-profile`).
2. `target=_blank` and `window.open` produce `browser://new-window` instead of loading in the same view.
3. Downloads are saved to the user Downloads folder with a unique name.
4. `mailto:`, `tel:` and other non-web schemes are opened by the OS.
5. macOS: JS `alert`, `confirm`, `prompt` show native sheets/dialogs.
6. macOS: `NSCameraUsageDescription` in Info.plist.
7. Release builds can open devtools for browser views.

## Behavior changes (frontend)

1. Address bar: text that is not a URL becomes a Bing search
   (`https://www.bing.com/search?q=`). `localhost`, `127.0.0.1` and private hosts default to `http://`.
2. Loading indicator follows `browser://page-load`, not the IPC return.
3. Tab label uses `browser://title`, falls back to hostname.
4. `browser://new-window` opens a new tab and focuses it.
5. Downloads: a small list/toast with file name, state, and "在访达中显示".
6. "更多" menu in the toolbar: 放大 / 缩小 / 实际大小 (shows %), 打印, 开发者工具, 清除浏览数据 (with confirm).
7. Shortcuts while the browser panel or toolbar has focus: Cmd/Ctrl+R reload, Cmd/Ctrl+= / - / 0 zoom, Cmd/Ctrl+P print, Cmd/Ctrl+[ / ] back/forward.

## Out of scope for Phase 1

Find in page, real back/forward enabled state, progress percentage,
favicon, error pages, basic-auth and certificate prompts, opener-preserving
popups, permission prompts, trusted (native) agent input.
