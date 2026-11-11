import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ripgrepVersion = "15.1.0";
// SHA-256 digests of the upstream release archives, pinned with the version.
const releases = {
  "x86_64-pc-windows-msvc": {
    archiveTarget: "x86_64-pc-windows-msvc",
    sha256: "124510b94b6baa3380d051fdf4650eaa80a302c876d611e9dba0b2e18d87493a",
  },
  "aarch64-apple-darwin": {
    archiveTarget: "aarch64-apple-darwin",
    sha256: "378e973289176ca0c6054054ee7f631a065874a352bf43f0fa60ef079b6ba715",
  },
  "x86_64-apple-darwin": {
    archiveTarget: "x86_64-apple-darwin",
    sha256: "64811cb24e77cac3057d6c40b63ac9becf9082eedd54ca411b475b755d334882",
  },
  "x86_64-unknown-linux-gnu": {
    archiveTarget: "x86_64-unknown-linux-musl",
    sha256: "1c9297be4a084eea7ecaedf93eb03d058d6faae29bbc57ecdaf5063921491599",
  },
};
const licenseFiles = ["COPYING", "LICENSE-MIT", "UNLICENSE"];

export function ripgrepRelease(target) {
  const release = Object.hasOwn(releases, target) ? releases[target] : undefined;
  if (!release) throw new Error(`Unsupported ripgrep target: ${target}`);
  const extension = target.includes("windows") ? ".exe" : "";
  const directory = `ripgrep-${ripgrepVersion}-${release.archiveTarget}`;
  const archive = `${directory}${extension ? ".zip" : ".tar.gz"}`;
  return {
    ...release,
    directory,
    archive,
    executable: `rg${extension}`,
    sidecar: `rg-${target}${extension}`,
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${archive}`,
  };
}

export function verifyArchive(bytes, sha256) {
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error("ripgrep archive SHA-256 mismatch");
  }
}

export function verifyVersion(output) {
  const expected = new RegExp(`^ripgrep ${ripgrepVersion.replaceAll(".", "\\.")}(?:\\s|$)`);
  if (!expected.test(output)) throw new Error("Prepared ripgrep executable has an unexpected version");
}

async function downloadArchive(url) {
  const temporary = mkdtempSync(join(tmpdir(), "miniq-ripgrep-download-"));
  const destination = join(temporary, "archive");
  try {
    if (process.platform === "win32") {
      // Use Windows' proxy configuration, which Node's fetch does not import.
      execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; Invoke-WebRequest -UseBasicParsing " +
        "-Uri $env:MINIQ_RIPGREP_URL -OutFile $env:MINIQ_RIPGREP_ARCHIVE -TimeoutSec 120"], {
        stdio: "inherit",
        env: { ...process.env, MINIQ_RIPGREP_URL: url, MINIQ_RIPGREP_ARCHIVE: destination },
      });
    } else {
      execFileSync("curl", ["--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https", "--connect-timeout", "15",
        "--max-time", "120", "--output", destination, url], { stdio: "inherit" });
    }
    return readFileSync(destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export async function prepareRipgrep({ target, tauriDirectory, download = downloadArchive }) {
  const release = ripgrepRelease(target);
  const bytes = await download(release.url);
  return stageRipgrep({ bytes, release, tauriDirectory });
}

export function stageRipgrep({ bytes, release, tauriDirectory }) {
  verifyArchive(bytes, release.sha256);
  const temporary = mkdtempSync(join(tmpdir(), "miniq-ripgrep-"));
  try {
    const archive = join(temporary, release.archive);
    writeFileSync(archive, bytes);
    const members = [release.executable, ...licenseFiles];
    execFileSync("tar", ["-xf", archive, "-C", temporary,
      ...members.map(name => `${release.directory}/${name}`)]);
    const binaryDirectory = join(tauriDirectory, "binaries");
    const licenseDirectory = join(tauriDirectory, "resources", "ripgrep");
    mkdirSync(binaryDirectory, { recursive: true });
    mkdirSync(licenseDirectory, { recursive: true });
    const destination = join(binaryDirectory, release.sidecar);
    copyFileSync(join(temporary, release.directory, release.executable), destination);
    if (!release.executable.endsWith(".exe")) chmodSync(destination, 0o755);
    for (const name of licenseFiles) {
      copyFileSync(join(temporary, release.directory, name), join(licenseDirectory, name));
    }
    console.log(`Prepared ${destination}`);
    return destination;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function rustHostTarget() {
  const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host:\s*(\S+)$/m)?.[1];
  if (!host) throw new Error("Unable to determine the Rust host target");
  return host;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const host = rustHostTarget();
  const target = process.env.MINIQ_DAEMON_TARGET ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? host;
  const tauriDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../src-tauri");
  const executable = await prepareRipgrep({ target, tauriDirectory });
  if (target === host) {
    const version = execFileSync(executable, ["--version"], { encoding: "utf8" });
    verifyVersion(version);
    console.log(version.trim());
  }
}
