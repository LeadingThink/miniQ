---
name: macos-swiftui-appkit
displayName: macOS SwiftUI 与 AppKit
description: 当用户要编写 macOS 的 SwiftUI 界面、多窗口/菜单栏/设置窗口，或在 SwiftUI 与 AppKit 之间桥接时使用
origin: installed
requires:
  bins:
    - swift
---

## 适用场景

开发 macOS 桌面界面：窗口和场景管理、菜单命令、设置窗口、菜单栏应用、侧边栏布局，以及 SwiftUI 做不到时通过 AppKit 桥接（`NSViewRepresentable`、`NSWindow`、`NSOpenPanel` 等）。

## 前置条件

- 工程能构建（参见 `macos-build-run`）。
- 用 `grep` 查 `MACOSX_DEPLOYMENT_TARGET` 或 `Package.swift` 里的 `.macOS(`，确认最低系统版本：`@Observable` 需要 macOS 14，`MenuBarExtra` 需要 macOS 13。

## 步骤

1. **了解现状**：用 `glob` 和 `grep` 找 `@main struct .*: App`、`WindowGroup`、`NSApplicationDelegateAdaptor`、`NSViewRepresentable`，弄清入口和现有的桥接方式。
2. **场景与窗口**（`file_edit`）：
   - 主窗口用 `WindowGroup { ContentView() }`，并用 `.defaultSize(width:height:)` 设定默认尺寸。
   - 单实例的辅助窗口用 `Window("Inspector", id: "inspector")`，通过 `@Environment(\.openWindow)` 调用 `openWindow(id:)` 打开。
   - 设置窗口用 `Settings { SettingsView() }`，配合 `@AppStorage` 保存偏好。
   - 菜单栏应用用 `MenuBarExtra("名称", systemImage: "…") { … }`。不需要 Dock 图标时，在 Info.plist 中设置 `LSUIElement = YES`，修改前先 `ask_user`。
   - 菜单命令用 `.commands { CommandGroup(after: .newItem) { Button("…") { … }.keyboardShortcut("k") } }`。
3. **布局**：侧边栏结构用 `NavigationSplitView`，数据表格用 `Table`，工具栏用 `.toolbar { ToolbarItem(placement: .primaryAction) { … } }`。
4. **桥接 AppKit**：
   - 嵌入 AppKit 视图时实现 `NSViewRepresentable`，包含 `makeNSView` 和 `updateNSView`；事件回调通过 `Coordinator` 传回 SwiftUI。
   - 选择文件和目录：
     - 优先用 SwiftUI 的 `.fileImporter`。
     - 需要更多控制时用 `NSOpenPanel`，在主线程调用 `begin`。
     - 沙盒应用需要开启 `com.apple.security.files.user-selected.read-write` 权限。
   - 需要窗口级控制（标题栏样式、最小尺寸等）时，通过 `NSApplicationDelegateAdaptor`，或在视图里借助 `NSViewRepresentable` 拿到 `view.window` 再调整。这类修改要限定在少数位置。
   - 状态模型用 `@Observable` 或 `@MainActor`，确保界面更新都在主线程执行。
5. **小步修改并验证**：用 `apply_patch` 分步修改，每一步用 `shell_run` 执行 `swift build` 或 `xcodebuild ... build`。运行起来后，用 `app_automation` 的 `inspect` 和 `screenshot` 检查窗口、菜单和控件，再用 `view_image` 查看截图。

## 注意事项 / 安全

- 修改 entitlements、Info.plist，或引入第三方包前，先用 `ask_user` 说明原因。
- 不要在 `updateNSView` 里重复创建视图或注册观察者，否则会导致泄漏或循环刷新。
- 调试时临时加的 `print` 在完成时删除。

## 如何确认完成

可以正常构建；新窗口、菜单和设置项能在运行中打开并正常工作，经过 `app_automation` 截图确认；浅色和深色模式下都显示正常。
