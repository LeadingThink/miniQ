---
name: macos-view-refactor
description: Refactor macOS SwiftUI views and scenes into stable structure. Use when splitting large views, tightening scene state, or narrowing AppKit escapes.
version: 1
origin: bundled
---

> 移植说明：本技能移植自 build-macos-apps/view-refactor（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

# View Refactor

## Overview

Refactor macOS views toward small, explicit, stable scene and view types. Default
to native SwiftUI for layout, selection, commands, and settings. Reach for AppKit
only at the narrow edges where desktop behavior truly requires it.

## Core Guidelines

### 1) Model scenes explicitly

- Break the app into meaningful scene roots: main window, settings, utility windows, inspectors, or menu bar extras.
- Do not let one giant root view silently own every desktop surface.

### 2) Keep a predictable file shape

- Follow this ordering unless the file already has a stronger local convention:
- Environment
- `private`/`public` `let`
- `@State` / other stored properties
- computed `var` (non-view)
- `init`
- `body`
- computed view builders / other view helpers
- helper / async functions

### 2b) Split files by responsibility

- For non-trivial apps, do not keep the full app, all views, models, stores, networking clients, process clients, and helpers in one Swift file.
- Accept a single Swift file only for tiny throwaway examples or snippets: roughly under 50 lines, one screen, no persistence, no networking/process client, and no reusable models.
- Use `App/<AppName>App.swift` for the `@main` app and `AppDelegate` only.
- Keep `Views/ContentView.swift` focused on root layout and composition; move feature UI into files such as `Views/SidebarView.swift`, `Views/DetailView.swift`, and `Views/ComposerView.swift`.
- Move value types and selection enums into `Models/*.swift`, stores into `Stores/*.swift`, app-server/network/process clients into `Services/*.swift`, and small formatters/resolvers/extensions into `Support/*.swift`.
- Keep files small and named after the primary type they contain.

### 3) Prefer dedicated subview types over many computed `some View` fragments

- Extract meaningful desktop sections like sidebar rows, detail panels, inspectors, or toolbar content into focused subviews.
- Keep computed `some View` helpers small and rare.
- Pass explicit data, bindings, and actions into subviews instead of handing down the whole scene model.

### 4) Keep selection and layout stable

- Prefer one stable split or window layout with local conditionals inside it.
- Avoid top-level branch swapping between radically different roots when selection changes.
- Let the layout be constant; let state drive the content inside it.

### 5) Extract commands, toolbars, and actions out of `body`

- Do not bury non-trivial button logic inline.
- Do not mix command routing, menu state, and layout in the same block if they can be named clearly.
- Keep `body` readable as UI, not as a desktop view controller.

### 6) Use scene and app storage intentionally

- Use `@SceneStorage` for per-window ephemeral state when it truly helps restore the scene.
- Use `@AppStorage` for durable preferences, not transient UI toggles that only matter in one window.
- Keep scene-owned state close to the scene root.

### 7) Keep AppKit escape hatches narrow

- If a representable or `NSWindow` bridge exists, isolate it behind a small wrapper or helper.
- Do not let AppKit references spread through unrelated SwiftUI views.
- If the bridge starts owning the feature, re-evaluate the architecture.

### 8) Observation usage

- For `@Observable` reference types on modern macOS targets, store them as `@State` in the owning view.
- Pass observables explicitly to children.
- On older deployment targets, fall back to `@StateObject` and `@ObservedObject` where needed.

## Workflow

1. Identify the current scene boundary and whether the file is trying to do too much.
2. Reorder the file into a predictable top-to-bottom structure.
3. Extract desktop-specific sections into dedicated subview types.
4. Stabilize the root layout around selection, scenes, and commands rather than top-level branching.
5. Move action logic, command routing, and toolbar behavior into named helpers or separate types.
6. Tighten any AppKit bridge so the imperative edge is small and explicit.
7. Keep behavior intact unless the request explicitly asks for structural and behavioral changes together.

## Refactor Checklist

- Split oversized view files before adding more UI.
- Move pure models, identifiers, and selection enums out of view files.
- Move `Process`, `URLSession`, app-server, and platform client code out of SwiftUI views into `Services/`.
- Keep `AppDelegate` and the `@main` app entrypoint minimal.
- Build after each major split so compile errors stay local.

## Common Smells

- A root view that mixes window scaffolding, settings, toolbar code, command handling, and detail layout.
- A single app file that mixes app entrypoint, root layout, feature views, models, stores, service clients, and support extensions.
- iOS-style push navigation forced into a Mac sidebar-detail problem.
- Several booleans for mutually exclusive inspectors, sheets, or utility windows.
- AppKit objects passed through many SwiftUI layers without a clear ownership reason.
- Large computed view fragments standing in for real subviews.

## Notes

- A good macOS refactor should make scene structure, selection flow, and command ownership obvious.
- When the problem is fundamentally a missing desktop pattern, use `swiftui-patterns`.
- When the problem is fundamentally a boundary with AppKit, use `appkit-interop`.
