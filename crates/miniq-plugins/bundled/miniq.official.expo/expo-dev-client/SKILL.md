---
name: expo-dev-client
displayName: Expo 开发客户端（iOS）
description: Build and distribute Expo development clients locally or via TestFlight
version: 1
origin: bundled
---

> 移植说明：本技能移植自 expo/expo-dev-client（MIT），已适配 miniQ。文中的工具名按 miniQ 原生工具理解：`shell_run` 执行命令、`browser_automation` 操作内置浏览器、`agent_run` 派发子代理、`ask_user` 询问用户、`mcp__<server>__<tool>` 调用本插件连接器、`skill_read` 读取其他技能及附属文件（相对路径以本技能目录为准）。原文针对 Codex 应用 Run 按钮 / `.codex/environments` 的步骤在 miniQ 中不适用，可跳过。

Use EAS Build to create development clients for testing native code changes on physical devices. Use this for creating custom Expo Go clients for testing branches of your app.

## Important: When Development Clients Are Needed

**Only create development clients when your app requires custom native code.** Most apps work fine in Expo Go.

You need a dev client ONLY when using:
- Local Expo modules (custom native code)
- Apple targets (widgets, app clips, extensions)
- Third-party native modules not in Expo Go

**Try Expo Go first** with `npx expo start`. If everything works, you don't need a dev client.

## EAS Configuration

Ensure `eas.json` has a development profile:

```json
{
  "cli": {
    "version": ">= 16.0.1",
    "appVersionSource": "remote"
  },
  "build": {
    "production": {
      "autoIncrement": true
    },
    "development": {
      "autoIncrement": true,
      "developmentClient": true
    }
  },
  "submit": {
    "production": {},
    "development": {}
  }
}
```

Key settings:
- `developmentClient: true` - Bundles expo-dev-client for development builds
- `autoIncrement: true` - Automatically increments build numbers
- `appVersionSource: "remote"` - Uses EAS as the source of truth for version numbers

## Building for TestFlight

Build iOS dev client and submit to TestFlight in one command:

```bash
eas build -p ios --profile development --submit
```

This will:
1. Build the development client in the cloud
2. Automatically submit to App Store Connect
3. Send you an email when the build is ready in TestFlight

After receiving the TestFlight email:
1. Download the build from TestFlight on your device
2. Launch the app to see the expo-dev-client UI
3. Connect to your local Metro bundler or scan a QR code

## Building Locally

Build a development client on your machine:

```bash
# iOS (requires Xcode)
eas build -p ios --profile development --local

# Android
eas build -p android --profile development --local
```

Local builds output:
- iOS: `.ipa` file
- Android: `.apk` or `.aab` file

## Installing Local Builds

Install iOS build on simulator:

```bash
# Find the .app in the .tar.gz output
tar -xzf build-*.tar.gz
xcrun simctl install booted ./path/to/App.app
```

Install iOS build on device (requires signing):

```bash
# Use Xcode Devices window or ideviceinstaller
ideviceinstaller -i build.ipa
```

Install Android build:

```bash
adb install build.apk
```

## Building for Specific Platform

```bash
# iOS only
eas build -p ios --profile development

# Android only
eas build -p android --profile development

# Both platforms
eas build --profile development
```

## Checking Build Status

```bash
# List recent builds
eas build:list

# View build details
eas build:view
```

## Using the Dev Client

Once installed, the dev client provides:
- **Development server connection** - Enter your Metro bundler URL or scan QR
- **Build information** - View native build details
- **Launcher UI** - Switch between development servers

Connect to local development:

```bash
# Start Metro bundler
npx expo start --dev-client

# Scan QR code with dev client or enter URL manually
```

## Troubleshooting

**Build fails with signing errors:**
```bash
eas credentials
```

**Clear build cache:**
```bash
eas build -p ios --profile development --clear-cache
```

**Check EAS CLI version:**
```bash
eas --version
eas update
```
