import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.MINIQ_SKIP_DAEMON_SIDECAR === "1") {
  process.exit(0);
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../../..");
const target = process.env.MINIQ_DAEMON_TARGET ?? rustHostTarget();
const executable = process.platform === "win32" ? "miniq-daemon.exe" : "miniq-daemon";
const source = join(repoRoot, "target", target, "release", executable);
const destinationDir = join(repoRoot, "apps", "desktop", "src-tauri", "binaries");
const destination = join(destinationDir, `miniq-daemon-${target}${process.platform === "win32" ? ".exe" : ""}`);

console.log(`Building miniq-daemon sidecar for ${target}`);
execFileSync(
  "cargo",
  ["build", "--release", "--locked", "-p", "miniq-daemon", "--bin", "miniq-daemon", "--target", target],
  { cwd: repoRoot, stdio: "inherit" },
);

mkdirSync(destinationDir, { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
console.log(`Prepared ${destination}`);

function rustHostTarget() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = output.match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) throw new Error("Unable to determine the Rust host target");
  return host;
}
