---
name: expo-ui-jetpack-compose
displayName: Expo Jetpack Compose 界面
description: '`@expo/ui/jetpack-compose` package lets you use Jetpack Compose Views and modifiers in your app.'
version: 1
origin: bundled
---

> 移植说明：本技能移植自 expo/expo-ui-jetpack-compose（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

> The instructions in this skill apply to SDK 55 only. For other SDK versions, refer to the Expo UI Jetpack Compose docs for that version for the most accurate information.

## Installation

```bash
npx expo install @expo/ui
```

A native rebuild is required after installation (`npx expo run:android`).

## Instructions

- Expo UI's API mirrors Jetpack Compose's API. Use Jetpack Compose and Material Design 3 knowledge to decide which components or modifiers to use. If you need deeper Jetpack Compose or Material 3 guidance (e.g. which component to pick, layout patterns, theming), consult current Jetpack Compose and Material Design 3 documentation before implementing.
- Components are imported from `@expo/ui/jetpack-compose`, modifiers from `@expo/ui/jetpack-compose/modifiers`.
- **Always read the `.d.ts` type files** to confirm the exact API before using a component or modifier. Run `node -e "console.log(path.dirname(require.resolve('@expo/ui/jetpack-compose')))"` to locate the package, then read the relevant `{ComponentName}/index.d.ts` files. This is the most reliable source of truth.
- When about to use a component, fetch its docs to confirm the API - https://docs.expo.dev/versions/v55.0.0/sdk/ui/jetpack-compose/{component-name}/index.md
- When unsure about a modifier's API, refer to the docs - https://docs.expo.dev/versions/v55.0.0/sdk/ui/jetpack-compose/modifiers/index.md
- Every Jetpack Compose tree must be wrapped in `Host`. Use `<Host matchContents>` for intrinsic sizing, or `<Host style={{ flex: 1 }}>` when you need explicit size (e.g. as a parent of `LazyColumn`). Example:

```jsx
import { Host, Column, Button, Text } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, paddingAll } from "@expo/ui/jetpack-compose/modifiers";

<Host matchContents>
  <Column verticalArrangement={{ spacedBy: 8 }} modifiers={[fillMaxWidth(), paddingAll(16)]}>
    <Text style={{ typography: "titleLarge" }}>Hello</Text>
    <Button onPress={() => alert("Pressed!")}>Press me</Button>
  </Column>
</Host>;
```

## Key Components

- **LazyColumn** — Use instead of react-native `ScrollView`/`FlatList` for scrollable lists. Wrap in `<Host style={{ flex: 1 }}>`.
- **Icon** — Use `<Icon source={require('./icon.xml')} size={24} />` with Android XML vector drawables. To get icons: go to [Material Symbols](https://fonts.google.com/icons), select an icon, choose the Android platform, and download the XML vector drawable. Save these as `.xml` files in your project's `assets/` directory (e.g. `assets/icons/wifi.xml`). Metro bundles `.xml` assets automatically — no metro config changes needed.
