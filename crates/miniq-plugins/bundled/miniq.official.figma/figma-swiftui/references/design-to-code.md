# 设计 → SwiftUI

把 Figma 画板翻译成地道的 SwiftUI。默认已读过 `SKILL.md` 的共用约定（链接解析、`clientLanguages`/`clientFrameworks`、Tailwind 只是参考、截图为准）。通用的取数与资源流程同时参考 `figma-design-to-code` 技能。

下面的表格是举例，不是穷举——遇到相似输入时按同样思路推断。核心原则：**凡是系统已经提供的东西（导航栏、标签栏、分段控件、列表分隔线、材质），不要用 `ZStack`/`HStack`/`.offset` 拼出来。**

## 1. 取设计数据

1. 从链接解析 `fileKey`、`nodeId`，调用：
   ```json
   {"server":"figma","tool":"get_design_context","arguments":{"fileKey":"<key>","nodeId":"<id>","clientLanguages":"swift","clientFrameworks":"swiftui"}}
   ```
2. 返回内容包括：React+Tailwind 近似代码、截图、Code Connect 片段、`<SFSymbol>` 包装的符号名、资源下载 URL。
3. **返回“未选中任何内容”或空结果/权限错误**：多半是 `node-id` 指向了页面（canvas）而非画板。先 `get_metadata` 看节点树，找到页面下的顶层 FRAME，再对它重试 `get_design_context`。
   不要只凭截图 + 元数据开工：SF Symbol 名和精确文案只在 design context 里，靠截图猜必然出错。
4. 再调用 `get_screenshot` 保存设计参照图（用于最后对比）；有自定义变量时调用 `get_variable_defs`。
5. 若 `figma` 被拒，换 `server:"figma-desktop"`（需在桌面端选中该节点）；都不可用时按 `figma-rest-export` 技能导出节点 JSON 与 PNG，再按本文规则人工映射。

## 2. 先摸清工程

用 `file_glob` / `file_grep` 查：

- `**/*.xcodeproj`、`Package.swift`：确定构建方式和 scheme。
- 部署目标（`IPHONEOS_DEPLOYMENT_TARGET` 或 `platforms: [.iOS(...)]`）：决定能否用 iOS 17 的 `#Preview`、`@Observable`，iOS 18 的 `Tab`，iOS 26 的 `glassEffect` 等。低于要求时改用旧 API（`PreviewProvider`、`ObservableObject`、`.tabItem`）。
- `Assets.xcassets/**/Contents.json`：已有颜色集、`AccentColor`、图片集。
- `Color+*.swift`、`Theme.swift`、`Tokens.swift`、`Font+*.swift`：项目自有令牌。
- 与设计中组件同名的 SwiftUI 视图（如 `PrimaryButton`、`AvatarView`），能复用就复用。

## 3. 多页面：先搭导航骨架

设计里有多个页面（引导流程、带标签栏的 App 等）时，不要一页页直接开写：

1. **选顶层容器**
   - 多个页面底部都有同一标签栏 → `TabView`，每个一级目的地一个 tab。
   - 线性流程（欢迎 → 登录 → 首页）→ `NavigationStack`，用根视图上的 `@AppStorage`（如 `"didFinishOnboarding"`）或 `@State` 决定冷启动显示哪页。
   - 模态流程（新建、设置）→ 父页面上的 `.sheet(isPresented:)` / `.fullScreenCover(isPresented:)`。
2. **每页先放占位**：`ContentUnavailableView("收藏", systemImage: "star")` 或 `Text("TODO: 登录")`，把跳转先接通，能点一遍流程。
3. **示例数据在根部统一建一次**（一个 `@State` 数组或 `@Observable` 模型），各页共享同一数据形状。
4. **再逐页实现**，先做最简单的一页验证数据形状。
5. **有“新建/添加”入口就把目标页也做出来**（工具栏 “+”、“添加”行、编辑按钮），不要留 TODO。仅限新建/编辑类入口：普通行只有带尾部箭头（或用户要求）时才做详情页。

**新建/编辑表单约定**：用 `Form` + 行内标题。画板名含 “Sheet/Modal” → 用 `.sheet` 呈现，内部包 `NavigationStack`，左上 `.cancellationAction` 放 `xmark`；含 “Push/Nav Stack/Drill” → `navigationDestination` 推入，不需要取消按钮。确认按钮放 `.confirmationAction`，图标 `checkmark`，`.buttonStyle(.borderedProminent)`（iOS 26 可用 `.glassProminent`），表单无效时 `.disabled(...)`。

```swift
struct NewPlantSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("基本信息") {
                    TextField("名称", text: $name)
                }
            }
            .navigationTitle("新建植物")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", systemImage: "xmark") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存", systemImage: "checkmark") { dismiss() }
                        .buttonStyle(.borderedProminent)
                        .disabled(name.isEmpty)
                }
            }
        }
    }
}
```

## 4. 按结构识别 iOS 模式

图层名因文件而异（同一个分组列表可能叫 `Settings`、`Menu`、`Cards`），综合以下信号判断：位置与形状（顶部大标题、底部栏、等高重复子项）、截图、`data-name` 关键词（只是提示）、内容（前图标 + 尾箭头 = 导航行；前图标 + 开关 = 设置开关）。

| Figma 结构 | SwiftUI |
|---|---|
| 圆角卡片分组、设置风格 | `List { Section { … } }` + `.listStyle(.insetGrouped)` |
| 分组的输入/开关/选择器行（设置页、新建页） | `Form { Section { … } }` |
| 通栏行、细分隔线、吸顶大写分组标题（通讯录风格） | `List { … }` + **显式** `.listStyle(.plain)` |
| 前图标 + 标题 + 尾箭头的行 | `List` 中的 `NavigationLink` |
| 顶部大标题的整页 | `NavigationStack` + `.navigationTitle(…)` |
| 底部一排图标 + 文字 | `TabView` + `Tab("…", systemImage: "…") { … }` |
| 纵向滚动卡片 | `ScrollView { LazyVStack { … } }` |
| 横向滚动卡片 | `ScrollView(.horizontal, showsIndicators: false) { LazyHStack { … } }` |
| 底部弹出的面板 | `.sheet(isPresented:)`，按需 `.presentationDetents` |
| 底部胶囊搜索框 + 圆形图标按钮（iOS 26） | `.searchable(…)` + `ToolbarItem(placement: .bottomBar)` |

注意：在 `NavigationStack` 里 `List` 默认是 inset grouped，通栏设计必须显式写 `.listStyle(.plain)`。

**先想 `List`/`Form`，再想 `VStack + Divider`**：重复的相似行 + 细线就是 `List`；一组带标签的输入就是 `Form`。手写 `VStack { Row(); Divider(); … }` 会丢掉分隔线、行内边距、分组背景、滑动操作、选中态和滚动。`VStack` 只用于少量不同类的内容（如头部信息块）。

## 5. Auto Layout → Stack、尺寸与约束

| Figma 属性 | SwiftUI |
|---|---|
| Auto Layout 竖向 | `VStack(alignment:spacing:)` |
| Auto Layout 横向 | `HStack(alignment:spacing:)` |
| 无 Auto Layout、子元素重叠 | `ZStack(alignment:)` 或 `.overlay(alignment:)` / `.background(alignment:)` |
| 换行（wrap） | `LazyVGrid(columns: [GridItem(.adaptive(minimum:))])`，或自定义 `Layout` |
| `itemSpacing` | Stack 的 `spacing:` |
| 主轴 `SPACE_BETWEEN` | 子项之间插 `Spacer()` |
| 交叉轴对齐 `MIN/CENTER/MAX` | Stack 的 `alignment:`（`.leading`/`.center`/`.trailing` 或 `.top`/`.bottom`） |
| 内边距 `padding*` | `.padding(EdgeInsets(...))` 或 `.padding(.horizontal, …)`；与系统默认一致时省略 |
| 子项 Fill container | `.frame(maxWidth: .infinity)`（横向）/ `.frame(maxHeight: .infinity)` |
| 子项 Hug contents | 默认行为，不写 frame |
| 子项 Fixed | `.frame(width:height:)`；仅对图标、头像等固定尺寸元素使用 |
| min/max 宽高 | `.frame(minWidth:maxWidth:)` |
| 约束 Left/Right/Center/Scale（非 Auto Layout） | 通过对齐与 `Spacer`、`.frame(maxWidth: .infinity, alignment:)` 表达相对关系，不写绝对坐标 |
| 圆角 | `.clipShape(.rect(cornerRadius:))`，连续圆角 `RoundedRectangle(cornerRadius:style: .continuous)` |
| 描边 | `.overlay { RoundedRectangle(…).strokeBorder(…) }` |
| 阴影 | `.shadow(color:radius:x:y:)`（Figma blur ≈ 2 × radius，需目测校准） |
| 不透明度 | `.opacity(_)` |

**不要重复加边距**：`List`、`Form`、`NavigationStack`、`ToolbarItem`、安全区域本身已有平台标准内边距。设计里屏幕边缘约 16pt 或标准行内边距时，不要再写 `.padding(16)`。确需偏离时优先 `.padding()` / `.padding(.horizontal)`；`List` 行内调整用 `.listRowInsets(...)`。

**全出血图片**：头图常常贴边而正文缩进，不要给两者套同一个外层 padding——图片 `.frame(maxWidth: .infinity)` 不加水平边距（必要时 `.ignoresSafeArea(edges: .horizontal)`，在 `List` 中用 `.listRowInsets(EdgeInsets())`），只给文字块加边距。

## 6. 颜色、变量与 Asset Catalog

### 6.1 Tailwind 里的 `var(...)` 是 HIG 令牌

参考代码把系统语义色写成 CSS 变量，并带上 RGBA 回退值。**映射目标是变量路径**，不要把回退色值抄进 Swift。

先看来源：颜色来自 Apple 系统组件（片段前有指向 HIG 文档的注释，或 `data-name` 类似 “Toolbar - Top”、“Segmented Control”）→ 直接用系统色。来自项目自己的设计系统 → 先找项目里同语义的颜色（`Color.brandPrimary`、`Color("AccentColor")`、令牌文件、颜色集），找不到再退回系统色。

| 变量路径 | SwiftUI |
|---|---|
| `--backgrounds/primary` | `Color(.systemBackground)` |
| `--backgrounds/secondary` | `Color(.secondarySystemBackground)` |
| `--backgrounds/tertiary` | `Color(.tertiarySystemBackground)` |
| `--labels/primary` | `Color.primary`（或 `Color(.label)`） |
| `--labels/secondary` | `Color.secondary`（或 `Color(.secondaryLabel)`） |
| `--labels/tertiary` | `Color(.tertiaryLabel)` |
| `--labels/quaternary` | `Color(.quaternaryLabel)` |
| `--separators/non-opaque` | `Color(.separator)` |
| `--separators/opaque` | `Color(.opaqueSeparator)` |
| `--fills/quaternary` | `Color(.quaternarySystemFill)` |
| 带 `vibrant` 的控件文字色 | 在材质/玻璃内用 `Color.secondary`，系统自动处理活力效果 |

### 6.2 颜色选用优先级

1. **项目令牌**：`Color+*.swift`、`Theme.swift`、`Tokens.swift` 或 `Assets.xcassets` 中已有的命名颜色。
2. **系统 HIG 色**：来源是系统组件/HIG 令牌时使用，自带深色模式与无障碍适配。
3. **文件自定义变量 → 命名颜色集**：Figma 里自定义的变量（如 `--brand/sunflower`，不是 HIG 路径）要保留精确值，在 `Assets.xcassets` 新建**同名**颜色集（`BrandSunflower`），代码里 `Color("BrandSunflower")`。**不要把品牌色替换成 `Color.orange` 之类的系统色。** 内联 `Color(red:green:blue:)` 扩展是次选。
4. **裸色值** `Color(red:green:blue:)`：只用于没有变量名可依附的一次性颜色。

颜色集示例（`Assets.xcassets/BrandSunflower.colorset/Contents.json`，含深色外观）：

```json
{
  "colors": [
    { "idiom": "universal",
      "color": { "color-space": "srgb", "components": { "red": "0.984", "green": "0.749", "blue": "0.141", "alpha": "1.000" } } },
    { "idiom": "universal",
      "appearances": [ { "appearance": "luminosity", "value": "dark" } ],
      "color": { "color-space": "srgb", "components": { "red": "0.996", "green": "0.820", "blue": "0.318", "alpha": "1.000" } } }
  ],
  "info": { "author": "xcode", "version": 1 }
}
```

需要类型安全时再加一层扩展（Xcode 15+ 也会自动生成 `Color(.brandSunflower)` 资源符号，二选一，避免重名）：

```swift
extension Color {
    static let brandSunflower = Color("BrandSunflower")
}
```

### 6.3 AccentColor

- 设计中所有可交互控件（按钮、开关、进度、选中标签）共用同一品牌色 → 写进 `AccentColor` 颜色集，让控件继承，不要在每个视图上 `.tint(...)`。
- **某个元素上的强调变量不等于 App 的 AccentColor**：如 `--accents/custom-accent`、`--status/active` 这类只作用于徽标、标签文字的变量，应做成独立命名颜色集。放进 `AccentColor` 会把全 App 的系统按钮、链接都染色。
- 判断 AccentColor 应看交互控件（点击的按钮、选中的 tab）用的颜色；当前画板看不出来时保持 Xcode 默认，并在交付中说明。

### 6.4 深色模式

- 背景绝不硬编码 `Color.black`/`Color.white`，即使参考写的是 `bg-black`：`--backgrounds/primary` 就是 `Color(.systemBackground)`，深色下本来就是黑色。
- 纯深色 App 在根视图加 `.preferredColorScheme(.dark)`，而不是把各处颜色写死。
- Figma 变量集合有 Light/Dark 两个 mode 时，两个值都写进颜色集的 appearances（见上例）；只有一个 mode 时只写 universal，并在交付中说明深色未设计。
- 验证时预览/模拟器都要切到深色看一遍。

## 7. 字体与文字样式

### 7.1 命名文字样式 → Dynamic Type

按样式名映射，不看像素：

| Figma 样式名 | SwiftUI |
|---|---|
| Large Title | `.largeTitle` |
| Title 1 / Title1 | `.title` |
| Title 2 | `.title2` |
| Title 3 | `.title3` |
| Headline | `.headline` |
| Subheadline | `.subheadline` |
| Body | `.body` |
| Callout | `.callout` |
| Footnote | `.footnote` |
| Caption 1 | `.caption` |
| Caption 2 | `.caption2` |

- 后缀 `/Emphasized`：同一样式加粗，`.font(.body).fontWeight(.semibold)`。
- 前缀 `Tight Leading/…`、`Loose Leading/…` 只改行高：照样取核心样式名，行高明显不同时用 `.lineSpacing(…)` 微调，**不要因此改用 `.system(size:)`**。名称中的空格、大小写不影响映射。
- 优先命名样式，`.system(size:)` 只用于没有语义对应的超大展示数字；即便如此也基于系统样式度量计算，或用 `@ScaledMetric` 让它随 Dynamic Type 缩放。

### 7.2 无命名样式时，从原始属性反推

若没有应用命名样式，但字体是 SF Pro 且字号/字重正好等于标准规格，仍用命名样式：34 → `.largeTitle`；28 → `.title`；22 → `.title2`；20 → `.title3`；17 Semibold → `.headline`；17 Regular → `.body`；16 → `.callout`；15 → `.subheadline`；13 → `.footnote`；12 → `.caption`；11 → `.caption2`。

### 7.3 非 Apple 字体

出现 Inter、Helvetica、Roboto 等非 SF 字体时，**不要默默写成 `.custom("Inter", size: 17)`**。用 `ask_user` 说明取舍：系统字体支持 Dynamic Type、光学尺寸、SF Symbol 对齐着色；很多设计师只是没意识到可以用系统字体。用户坚持保留时：

```swift
// 让自定义字体随 Dynamic Type 按 .headline 的比例缩放
.font(.custom("Lato-Bold", size: 17, relativeTo: .headline))
```

并确认字体文件已加入工程、`Info.plist` 的 `UIAppFonts` 已登记。`relativeTo:` 按文字角色选（正文 `.body`、小节标题 `.headline`、说明 `.caption`）。

### 7.4 Tailwind 细节

- `font-[590]` = SF Pro 的 Semibold → `.semibold`；`510` → `.medium`；`400` → `.regular`。
- `SF Pro Rounded` → `.system(…, design: .rounded)` 或 `.fontDesign(.rounded)`，不要 `.custom`。
- 宽度轴：`SF Pro Expanded/Condensed/Compressed` 或 `'wdth'` ≠ 100 → 保留命名样式，叠加 `.fontWidth(.expanded / .condensed / .compressed)`；Extra Expanded 也用 `.expanded`。宽度、字重、样式三者可叠加，**不要丢掉宽度**。`'wdth' 100` 是默认值，忽略。
- `ss01`、`ss16` 等风格集通常忽略，除非设计刻意强调数字字形。
- 绝对行高（`leading-[22px]`）一般接受系统默认；需要时换算成 `.lineSpacing`。
- SF Pro 的负字距是系统字体内置的，忽略；自定义字体才用 `.tracking(_)`。

## 8. 图片与 SF Symbols

- **SF Symbols**：名字直接取自返回中的 `<SFSymbol>{Image(systemName: "…")}</SFSymbol>`，或 Code Connect 片段内的调用，原样使用。**绝不按码位映射或看截图猜名字。** 需要调色/层级时用 `.symbolRenderingMode(.hierarchical)`、`.foregroundStyle(...)`，尺寸跟随字体（`.font(.title2)` / `.imageScale(.large)`）。
- **位图素材**：返回里的 `imgXxx = "https://…/api/mcp/asset/<id>"` 可直接 GET 下载（`shell_run` 调 `curl -L -o`）。放入 `Assets.xcassets/<名称>.imageset/`（附 `Contents.json`），代码 `Image("<名称>")`，按设计加 `.resizable().scaledToFill()` + 裁切。矢量图标可保存为 PDF/SVG 并勾选 Preserve Vector Data。
- 某个图片没有 `img*` URL（常见于被拍平的实例子节点）→ 对父节点 `get_screenshot` 作为静态替代。
- **拿不到素材时先告诉用户**再替换：可用 SF Symbol 占位（`person.crop.circle.fill`）、首字母圆形头像、`Color(.systemGray5)` 占位块；不要随便塞一张网络图片。
- 属于设备模板的资源（状态栏图标、设备外框、模糊遮罩）不是 App 素材，不下载。
- **彩色 emoji** 作为图标/头像/装饰时，`ask_user` 询问保留还是换 SF Symbol（`leaf.fill`、`pawprint.fill` 等）：SF Symbol 会随文字着色、随 Dynamic Type 缩放且渲染稳定，emoji 做不到，部分模拟器还会显示成方框。尊重用户选择。

## 9. Code Connect 片段

返回中 Code Connect 组件包在 `<CodeConnectSnippet data-name="…" data-snippet-language="…">` 里，先看属性：

- **`data-snippet-language="SwiftUI"`**：内容就是 SwiftUI 源码，**原样使用**——只清理 JSX 留下的 `{" "}` 空白、补上 `action` 之类占位，不要改修饰符或重新设计样式。
- **没有该属性或是 `tsx`/`html`**：内容是 JSX 形式的组件描述（`<ButtonContentArea style="Bordered - Prominent">` 之类），属性值是设计元数据，需要你推断 SwiftUI。若片段带有指向 Apple HIG 文档的注释，或 `data-name` 描述系统组件，就当作系统控件处理（不管标签名是否叫 `Button`）。
- **引用项目组件**（如 `import { Chip } from 'src/components/Chip'`）：这种导入在 Swift 里不成立，用 `file_grep` 在工程里找同名 SwiftUI 视图并复用。

回退片段分三类：

**设备外壳——丢弃**：`<StatusBar>`、`<Bezel>`、`<HomeIndicator>` 及其属性都是模板元数据，iOS 自己渲染。

**导航外壳——用系统 API**：

| 片段 | SwiftUI |
|---|---|
| 顶部工具栏（带 `title`/`subtitle`） | `.navigationTitle("…")`，副标题 `.navigationSubtitle("…")`（iOS 26）。**用片段里的原文标题**，不要改成“首页”“设置”之类泛称。返回按钮来自上一页的 `NavigationLink`。 |
| 标签栏（`tabs="N"`） | `TabView` 内 N 个 `Tab("…", systemImage: "…")`；未实现的页用 `ContentUnavailableView`。搜索单独成一个胶囊时用 `Tab(role: .search)`。 |
| 标题（带 `mode`） | 居中小标题 → `.navigationBarTitleDisplayMode(.inline)`；左对齐大标题 → `.large`。 |
| Edit | `ToolbarItem(placement: .topBarLeading) { EditButton() }` |
| Filter | 右上角 `line.3.horizontal.decrease` 图标按钮 |
| Compose | 底部工具栏 `square.and.pencil` 按钮 |
| Search | `.searchable(text: $query)` |

**与系统控件同名——直接用系统控件**：

| 片段 | SwiftUI |
|---|---|
| SegmentedControl | `Picker(…).pickerStyle(.segmented)`（iOS 26 的胶囊外观就是它） |
| Toggle / Switch | `Toggle(…, isOn:)` |
| Slider | `Slider(value:in:)` |
| Stepper | `Stepper(…, value:)` |
| Picker / Menu | `Picker(…, selection:)` / `Menu` |
| DatePicker | `DatePicker(…, selection:)` |
| ProgressBar | `ProgressView(value:)` |
| Spinner / ActivityIndicator | `ProgressView()` |
| TextField | `TextField(…, text:)` |
| Button | `Button(…) { … }` + 对应 `.buttonStyle` |

用 `HStack + Capsule` 重造这些控件会丢失无障碍、RTL、Dynamic Type、深色模式、触感反馈与减弱动态效果支持。只有设计**明显偏离**系统外观（形状、非 tint 可表达的颜色、特殊选中行为）时才自定义。

**工具栏圆形按钮不要手搓**：蓝色圆底对勾、圆形 “+” 就是系统按钮——`Button { … } label: { Image(systemName: "checkmark") }.buttonStyle(.borderedProminent)`；iOS 26 工具栏会自动渲染玻璃圆形，不要 `.frame + .background(Circle())`。

## 10. 组件与变体 → View 与参数

- 一个 Figma 组件（或组件集）对应一个 SwiftUI `View` 结构体，放在独立文件中。
- **变体属性 → 参数**：`Style=Primary/Secondary` → `enum Style`；`Size=S/M/L` → `enum` 或 `.controlSize`；`State=Disabled` → 调用处 `.disabled(true)`，不要做成参数；`Pressed/Hover` 由 `ButtonStyle` 的 `configuration.isPressed` 处理。
- **布尔属性**（`Show icon`）→ 可选参数（`systemImage: String? = nil`）。
- **文本属性** → `String` / `LocalizedStringKey` 参数。
- **实例替换（INSTANCE_SWAP）** → 泛型 `@ViewBuilder` 内容参数或 SF Symbol 名参数。
- 按钮类组件优先实现为自定义 `ButtonStyle`，保留系统点击与无障碍行为。

```swift
struct TagChip: View {
    enum Tone { case neutral, positive }
    let title: LocalizedStringKey
    var systemImage: String? = nil
    var tone: Tone = .neutral

    var body: some View {
        Label {
            Text(title)
        } icon: {
            if let systemImage { Image(systemName: systemImage) }
        }
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .foregroundStyle(tone == .positive ? Color.green : Color.secondary)
        .background(Color(.tertiarySystemFill), in: .capsule)
    }
}
```

- 选中态用 `CaseIterable`（必要时 `Identifiable`）的 enum，不要用 `Int` 下标 + 平行的 `[String]` 标签数组。

## 11. iOS 26 表面效果（仅在参考中确实出现时处理）

只有 design context 里出现以下特征才适用：`data-name` 含 “Scroll Edge Effect”、滚动内容上的 `mask-image: url('blur.png')`、带嵌套 `mix-blend-multiply` / `mix-blend-color-dodge` + `backdrop-blur` 的胶囊（Figma 的玻璃近似）、底部工具栏里的搜索胶囊。截图里有点模糊不代表要加这些修饰符。

**系统控件已自带材质**：`Button`、`TabView`、`.toolbar` 内容在 iOS 26 自动获得玻璃效果；再加 `.glassEffect()` / `.background(.regularMaterial)` 会重复渲染。只在你**手工搭建的自定义表面**（如悬浮胶囊）上、且参考中确有玻璃叠层时才显式加。

| 参考特征 | SwiftUI |
|---|---|
| 滚动内容顶/底部的 Scroll Edge Effect | `.scrollEdgeEffectStyle(.soft, for: .top / .bottom)` |
| 混合模式叠层的胶囊 | 容器 `.glassEffect()`，或 `.background(.regularMaterial, in: .capsule)` |
| 底部工具栏搜索胶囊 | `.searchable(...)`，iOS 26 会在合适层级自动放到底部 |
| 搜索胶囊旁的圆形按钮 | `ToolbarItem(placement: .bottomBar) { Button … }`，不需要 `.glassEffect()` |

`blur.png` 遮罩永远不是要打包的图片资源。部署目标低于 iOS 26 时用 `if #available(iOS 26, *)` 包裹，旧系统退回 `.regularMaterial`。

## 12. 不要从 Tailwind 参考照搬的东西

- **绝对定位/像素坐标**：用 Stack、`Spacer`、`.padding`、`.frame(maxWidth: .infinity)`。
- **百分比内嵌**（`inset-[54%_14%_…]`）：来自叠放子层的变换，改为基于父尺寸的 `.overlay(alignment:)` 或少量 `.offset`。
- **流式内容上的 `.offset(x:y:)`**：会破坏 Dynamic Type、RTL、不同屏宽。仅对设计师精确摆放的装饰（角标贴纸、水印、散落图案）且 `.overlay(alignment:)` 表达不了时使用。
- **每行手画底边框**（`border-b`）：`List` 自带分隔线。
- **`Divider().frame(width: 1, height: 36).background(…)`**：误用。固定竖线用 `Rectangle().fill(Color(.separator)).frame(width: 1, height: 36)`。
- **顶部“返回箭头 + 居中标题 + 右侧按钮”的 HStack**：这是 `NavigationStack` 外壳，用 `.navigationTitle` + `.toolbar`，否则丢失侧滑返回、安全区、大标题折叠。
- **底部 4–5 个图标+文字按钮的 HStack**：这是 `TabView`，否则丢失系统模糊、徽标、选中无障碍。
- **旋转矩形 + 圆点拼成的折线图**：用 Swift Charts（`import Charts`，`LineMark`/`PointMark`/`BarMark`）。
- **圆形图标按钮用 `.frame + .background(Circle())`**：改为 `.buttonStyle(.bordered)` + `.buttonBorderShape(.circle)` + `.controlSize(.large)`。
- **空的 `Button {} label: {…}`**：至少写 `Button(action: { /* TODO: 保存 */ })`，让缺口显眼。
- **名为 Sheet/Modal/Popover 的外层画板**：这是呈现方式，做成 `.sheet`/`.popover` 内容并带关闭控件，而不是内嵌子视图（与设备外壳相反，这个要保留语义）。
- **玻璃/阴影/混合模式叠层**：见第 11 节。

## 13. 无障碍

- 纯图标按钮必须有文字标签：`Button("分享", systemImage: "square.and.arrow.up") { … }.labelStyle(.iconOnly)`，或 `.accessibilityLabel("分享")`。
- 装饰图片 `Image(decorative:)` 或 `.accessibilityHidden(true)`；内容图片给 `.accessibilityLabel`。
- 组合信息的卡片/行用 `.accessibilityElement(children: .combine)`，避免读屏逐段朗读。
- 使用命名字体样式以支持 Dynamic Type；在 `.dynamicTypeSize(.accessibility3)` 下检查不截断（必要时 `ViewThatFits` 或让 `HStack` 在大字号下改为竖排）。
- 保证点击区域不小于 44×44pt（`.contentShape(.rect)` + `.frame(minWidth: 44, minHeight: 44)`）。
- 颜色对比度：自定义色在浅/深模式都要达到 4.5:1（正文）；不要只用颜色传达状态。
- Figma 中若有 Accessibility 类注释（常由代码→设计流程写入），把其中的 label/hint/trait 还原为对应修饰符。

## 14. 预览

每个新视图都附预览，覆盖关键状态：

```swift
#Preview("浅色") {
    NavigationStack { GardenListView(plants: .sample) }
}

#Preview("深色 + 大字号") {
    NavigationStack { GardenListView(plants: .sample) }
        .preferredColorScheme(.dark)
        .dynamicTypeSize(.accessibility2)
}
```

部署目标低于 iOS 17 时改用 `PreviewProvider`。示例数据放在 `extension [Plant] { static let sample = … }` 之类的位置，供预览与根视图复用。

## 15. 输出

- 代码写到用户指定位置；未指定时按工程结构提议（如 `Features/<模块>/<名称>View.swift`），并在写入前说明。
- 新增颜色集/图片集时同步写 `Contents.json`；新文件若不在 Xcode 16 的同步文件夹里，需提醒用户加入 target（或编辑 `project.pbxproj` 前先征得同意）。
- 标准 SwiftUI 修饰符永远优先于照搬的绝对定位和混合模式叠层。
- 最后按 `mapping-and-verification.md` 的步骤构建、截图对比，并按 `SKILL.md` 的交付格式汇报。
