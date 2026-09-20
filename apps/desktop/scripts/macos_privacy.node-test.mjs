import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMicrophoneAccess, validateSource } from "./macos_privacy.mjs";
import { resolve } from "node:path";

const info = { NSMicrophoneUsageDescription: "miniQ 使用麦克风将你的语音转换为输入文字。" };
const entitlements = { "com.apple.security.device.audio-input": true };

test("allows microphone capture only when purpose and signed audio access are both present", () => {
  assert.doesNotThrow(() => validateMicrophoneAccess(info, entitlements));
});

test("rejects a purpose string without signed audio access, as in the broken 0.1.39 package", () => {
  for (const value of [undefined, false, "true", 1]) {
    assert.throws(() => validateMicrophoneAccess(info, { "com.apple.security.device.audio-input": value }), /signature must grant/);
  }
});

test("rejects missing, blank or unresolved microphone purpose text", () => {
  for (const value of [undefined, "", "  ", true, "$(MICROPHONE_USAGE)"]) {
    assert.throws(() => validateMicrophoneAccess({ NSMicrophoneUsageDescription: value }, entitlements), /UsageDescription/);
  }
});

test("the configured macOS bundle declares its required recording capability", { skip: process.platform !== "darwin" }, () => {
  validateSource(resolve(import.meta.dirname, ".."));
});
