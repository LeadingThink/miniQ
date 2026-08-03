import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag?.startsWith("v")) {
  throw new Error("release tag must have the form vMAJOR.MINOR.PATCH");
}

const expected = tag.slice(1);
const packageJson = JSON.parse(readFileSync(resolve(desktopDir, "package.json"), "utf8"));
const tauriConfig = JSON.parse(
  readFileSync(resolve(desktopDir, "src-tauri/tauri.conf.json"), "utf8"),
);
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps", "--manifest-path", resolve(repoDir, "Cargo.toml")],
    { encoding: "utf8" },
  ),
);
const desktopMetadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--no-deps",
      "--manifest-path",
      resolve(desktopDir, "src-tauri/Cargo.toml"),
    ],
    { encoding: "utf8" },
  ),
);

const versions = new Map([
  ["apps/desktop/package.json", packageJson.version],
  ["apps/desktop/src-tauri/tauri.conf.json", tauriConfig.version],
  [
    "crates/miniq-daemon/Cargo.toml",
    metadata.packages.find((pkg) => pkg.name === "miniq-daemon")?.version,
  ],
  [
    "apps/desktop/src-tauri/Cargo.toml",
    desktopMetadata.packages.find((pkg) => pkg.name === "miniq-desktop")?.version,
  ],
]);

const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  const details = mismatches.map(([file, version]) => `${file}: ${version ?? "missing"}`).join("\n");
  throw new Error(`release ${tag} does not match project versions:\n${details}`);
}

console.log(`release versions match ${tag}`);
