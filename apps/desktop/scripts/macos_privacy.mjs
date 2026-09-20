import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AUDIO_INPUT = "com.apple.security.device.audio-input";

export function validateMicrophoneAccess(info, entitlements) {
  const description = info.NSMicrophoneUsageDescription;
  if (typeof description !== "string" || !description.trim() || /\$\([^)]+\)/.test(description)) {
    throw new Error("NSMicrophoneUsageDescription must explain microphone use in the built application");
  }
  if (entitlements[AUDIO_INPUT] !== true) {
    throw new Error(`The macOS app signature must grant ${AUDIO_INPUT}; system permission alone is insufficient`);
  }
}

function readPlist(path, input) {
  return JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"],
  }));
}

export function validateSource(desktopDirectory) {
  const tauriDirectory = resolve(desktopDirectory, "src-tauri");
  const config = JSON.parse(readFileSync(resolve(tauriDirectory, "tauri.conf.json"), "utf8"));
  const entitlementsPath = config.bundle?.macOS?.entitlements;
  if (!entitlementsPath) throw new Error("bundle.macOS.entitlements must name the microphone entitlement file");
  validateMicrophoneAccess(
    readPlist(resolve(tauriDirectory, "Info.plist")),
    readPlist(resolve(tauriDirectory, entitlementsPath)),
  );
}

export function validateApp(appPath) {
  const info = readPlist(resolve(appPath, "Contents/Info.plist"));
  const signedEntitlements = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", appPath], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (!signedEntitlements.trim()) throw new Error("Built macOS app has no signed microphone entitlement");
  validateMicrophoneAccess(info, readPlist("-", signedEntitlements));
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "pipe" });
}

function main() {
  const [action, appPath] = process.argv.slice(2);
  if (action === "source") validateSource(resolve(import.meta.dirname, ".."));
  else if (action === "app" && appPath) validateApp(resolve(appPath));
  else throw new Error("usage: node scripts/macos_privacy.mjs source | app <App.app>");
  console.log(`Validated macOS microphone privacy: ${action}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
