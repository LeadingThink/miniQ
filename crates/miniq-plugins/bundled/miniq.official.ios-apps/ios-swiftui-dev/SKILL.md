---
name: ios-swiftui-dev
displayName: iOS SwiftUI 开发
description: 当用户要新建或修改 SwiftUI 界面、拆分重构视图、排查 SwiftUI 卡顿和状态问题时使用
origin: installed
requires:
  bins:
    - xcodebuild
---

## 适用场景

编写或重构 iOS 的 SwiftUI 界面：新增页面、导航、列表、表单，拆分过大的视图，修复状态不刷新或刷新过多、滚动卡顿等问题。

## 前置条件

- 工程能正常构建（参见 `ios-build-run`）。
- 用 `grep` 在工程文件里查 `IPHONEOS_DEPLOYMENT_TARGET`，确认最低 iOS 版本，以决定能否使用 `@Observable`（iOS 17+）和 `NavigationStack`（iOS 16+）。

## 步骤

1. **了解现状**：用 `glob` 列出 `**/*.swift`，再用 `grep` 查 `struct .*: View`、`@State`、`@StateObject`、`@Observable`、`ObservableObject`，弄清现有架构，新代码沿用同一风格。
2. **写视图**（`file_write` / `file_edit`）时遵循以下约定：
   - 状态归属明确：视图私有的状态用 `@State private var`；共享模型在 iOS 17+ 用 `@Observable class`，通过 `@Environment` 或参数注入，旧系统用 `ObservableObject` 加 `@StateObject`。
   - 导航用 `NavigationStack(path:)` 加 `.navigationDestination(for:)`，不要使用已弃用的 `NavigationView`。
   - 列表数据要有稳定的 `id`（遵循 `Identifiable`），不要用 `id: \.self` 处理可变数据。
   - 异步加载用 `.task { await model.load() }`，不要在 `onAppear` 里开 `Task` 又不做取消。
   - 每个视图附一个 `#Preview { ... }`，并给出示例数据。
   - 支持动态字体和深色模式，使用语义颜色（`.primary`、`Color(.systemBackground)`），图标补上 `accessibilityLabel`。
3. **重构大视图**：
   - `body` 超过约 80 行，或同时包含多块逻辑时，拆成独立的 `struct` 子视图，只传入所需的最小数据（值或 `Binding`）。
   - 业务逻辑移到模型或 view model，视图只负责展示。
   - 用 `apply_patch` 做成可审阅的小步修改。每一步都用 `shell_run` 执行 `xcodebuild ... build` 确认可编译。
4. **排查性能**：
   - 用 `grep` 查找以下问题：`body` 内的重计算（排序、过滤、`DateFormatter()`），`ForEach` 中的 `AnyView`，以及整个大模型作为依赖被传入。
   - 修复方法：把计算移到模型中缓存；把静态格式化器放进 `static let`；拆分视图，缩小依赖范围；长列表用 `List` 或 `LazyVStack`。
   - 临时在 `body` 中加 `let _ = Self._printChanges()`，运行后查看控制台输出，定位是哪个属性触发了重绘，确认后删除。
   - 需要量化时，建议用户用 Instruments 的 SwiftUI 模板录制，也可以执行 `xcrun xctrace record --template 'SwiftUI' --launch -- <App路径>`。
5. **验证**：按 `ios-build-run` 的步骤安装、启动，用 `xcrun simctl io <UDID> screenshot` 截图，再用 `view_image` 检查浅色、深色和大字号（`xcrun simctl ui <UDID> content_size extra-extra-large`）下的效果。

## 注意事项 / 安全

- 修改公共模型或删除文件前，先用 `ask_user` 说明影响范围。
- 不擅自升级最低系统版本或引入第三方包，需要时先 `ask_user`。
- 调试用的 `_printChanges` 和 `print` 在完成时必须删除。

## 如何确认完成

构建成功，没有新增警告；`#Preview` 可以编译；各模式下的截图都符合预期；性能问题有修改前后的对比说明，例如重绘次数减少，或滚动不再掉帧。
