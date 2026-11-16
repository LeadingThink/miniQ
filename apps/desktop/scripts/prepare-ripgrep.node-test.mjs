import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { prepareRipgrep, ripgrepRelease, ripgrepVersion, stageRipgrep, verifyArchive, verifyVersion } from "./prepare-ripgrep.mjs";

const targets = [
  "x86_64-pc-windows-msvc", "aarch64-apple-darwin",
  "x86_64-apple-darwin", "x86_64-unknown-linux-gnu",
];
const licenses = ["COPYING", "LICENSE-MIT", "UNLICENSE"];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "miniq-rg-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("every desktop target has a pinned upstream archive and the Tauri sidecar name", () => {
  for (const target of targets) {
    const release = ripgrepRelease(target);
    assert.match(release.sha256, /^[a-f0-9]{64}$/);
    assert.equal(release.sidecar, `rg-${target}${target.includes("windows") ? ".exe" : ""}`);
    assert.equal(release.url, `https://github.com/BurntSushi/ripgrep/releases/download/${ripgrepVersion}/${release.archive}`);
  }
  assert.equal(ripgrepRelease(targets[3]).archiveTarget, "x86_64-unknown-linux-musl");
  assert.throws(() => ripgrepRelease("aarch64-unknown-linux-gnu"), /Unsupported ripgrep target/);
  assert.throws(() => ripgrepRelease("toString"), /Unsupported ripgrep target/);
});

test("SHA-256 verification rejects corruption", () => {
  const original = Buffer.from("archive fixture");
  const digest = createHash("sha256").update(original).digest("hex");
  assert.doesNotThrow(() => verifyArchive(original, digest));
  assert.throws(() => verifyArchive(Buffer.from("changed fixture"), digest), /SHA-256 mismatch/);
});

test("version verification accepts upstream build metadata and rejects a different version", () => {
  verifyVersion(`ripgrep ${ripgrepVersion} (af60c2de9d)\n\nfeatures:+pcre2\n`);
  verifyVersion(`ripgrep ${ripgrepVersion}\r\n`);
  assert.throws(() => verifyVersion("ripgrep 15.1.00\n"), /unexpected version/);
  assert.throws(() => verifyVersion("ripgrep 14.1.1\n"), /unexpected version/);
});

test("corrupt downloads never create or overwrite packaged files", async t => {
  const directory = fixture(t);
  const binary = join(directory, "binaries", ripgrepRelease(targets[0]).sidecar);
  mkdirSync(join(directory, "binaries"));
  writeFileSync(binary, "keep existing binary");
  await assert.rejects(prepareRipgrep({
    target: targets[0], tauriDirectory: directory,
    download: async url => {
      assert.equal(url, ripgrepRelease(targets[0]).url);
      return Buffer.from("corrupt archive");
    },
  }), /SHA-256 mismatch/);
  assert.equal(readFileSync(binary, "utf8"), "keep existing binary");
  assert.equal(existsSync(join(directory, "resources")), false);
});

for (const target of targets) {
  test(`stages the complete executable and license files for ${target}`, t => {
    const directory = fixture(t);
    const release = ripgrepRelease(target);
    const source = join(directory, "source");
    const upstream = join(source, release.directory);
    mkdirSync(upstream, { recursive: true });
    writeFileSync(join(upstream, release.executable), "native executable fixture");
    for (const name of licenses) writeFileSync(join(upstream, name), `${name} license fixture\n`);
    // An unrelated upstream file must not be shipped.
    writeFileSync(join(upstream, "README.md"), "upstream readme");
    const archive = join(directory, "fixture.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", source, release.directory]);
    const bytes = readFileSync(archive);
    const tauriDirectory = join(directory, "miniQ 安装目录");
    const destination = stageRipgrep({
      bytes, release: { ...release, sha256: createHash("sha256").update(bytes).digest("hex") },
      tauriDirectory,
    });
    assert.equal(destination, join(tauriDirectory, "binaries", release.sidecar));
    assert.equal(readFileSync(destination, "utf8"), "native executable fixture");
    for (const name of licenses) {
      assert.equal(readFileSync(join(tauriDirectory, "resources/ripgrep", name), "utf8"), `${name} license fixture\n`);
    }
    assert.equal(existsSync(join(tauriDirectory, "resources/ripgrep/README.md")), false);
    if (process.platform !== "win32" && !target.includes("windows")) {
      assert.equal(statSync(destination).mode & 0o777, 0o755);
    }
  });
}

test("desktop builds and development prepare the bundled executable and include its licenses", () => {
  const root = resolve(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
  assert.ok(config.bundle.externalBin.includes("binaries/rg"));
  assert.equal(config.bundle.resources["resources/ripgrep/"], "licenses/ripgrep/");
  assert.match(config.build.beforeBuildCommand, /^npm run prepare:ripgrep &&/);
  assert.match(config.build.beforeDevCommand, /^npm run prepare:ripgrep &&/);
});
