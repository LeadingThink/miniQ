import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tauriConfig = JSON.parse(
  await readFile(resolve(desktopRoot, "src-tauri/tauri.conf.json"), "utf8"),
);

test("desktop bundle keeps the daemon and excludes ripgrep", () => {
  assert.deepEqual(tauriConfig.bundle.externalBin, ["binaries/miniq-daemon"]);
  assert.equal(tauriConfig.bundle.resources, undefined);
  assert.equal(tauriConfig.build.beforeDevCommand.includes("prepare:ripgrep"), false);
  assert.equal(tauriConfig.build.beforeBuildCommand.includes("prepare:ripgrep"), false);
});

test("desktop build hooks still prepare the daemon and frontend", () => {
  assert.match(tauriConfig.build.beforeDevCommand, /miniq-daemon/);
  assert.match(tauriConfig.build.beforeDevCommand, /npm run dev/);
  assert.match(tauriConfig.build.beforeBuildCommand, /prepare:daemon/);
  assert.match(tauriConfig.build.beforeBuildCommand, /npm run build/);
});
