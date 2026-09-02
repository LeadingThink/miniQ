import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildRelease } from "./build-release-manifest.mjs";

const targets = {
  windows: "x86_64-pc-windows-msvc",
  macArm: "aarch64-apple-darwin",
  macIntel: "x86_64-apple-darwin",
  linux: "x86_64-unknown-linux-gnu",
};

function fixture(root, target, files) {
  const directory = join(root, `miniq-release-${target}`);
  mkdirSync(directory, { recursive: true });
  for (const [name, content = name] of files) writeFileSync(join(directory, name), content);
}

test("builds one signed update manifest for every desktop platform", () => {
  const root = mkdtempSync(join(tmpdir(), "miniq-release-"));
  const input = join(root, "input");
  const output = join(root, "output");
  fixture(input, targets.windows, [["miniQ-setup.exe"], ["miniQ-setup.exe.sig", "windows-signature\n"]]);
  fixture(input, targets.macArm, [["miniQ.app.tar.gz"], ["miniQ.app.tar.gz.sig", "arm-signature"], ["miniQ_aarch64.dmg"]]);
  fixture(input, targets.macIntel, [["miniQ.app.tar.gz"], ["miniQ.app.tar.gz.sig", "intel-signature"], ["miniQ_x64.dmg"]]);
  fixture(input, targets.linux, [["miniQ.AppImage.tar.gz"], ["miniQ.AppImage.tar.gz.sig", "linux-signature"], ["miniQ.AppImage"], ["miniQ.deb"]]);

  const manifest = buildRelease({
    input,
    output,
    tag: "v1.2.3",
    repo: "LeadingThink/miniQ-releases",
    notes: "Faster startup",
    publishedAt: "2026-08-30T00:00:00.000Z",
  });

  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(Object.keys(manifest.platforms), [
    "windows-x86_64",
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
  ]);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "arm-signature");
  assert.match(manifest.platforms["linux-x86_64"].url, /miniQ_1\.2\.3_x64\.AppImage\.tar\.gz$/);
  assert.deepEqual(JSON.parse(readFileSync(join(output, "latest.json"), "utf8")), manifest);
});

test("builds a manifest from the platform artifacts that exist", () => {
  const root = mkdtempSync(join(tmpdir(), "miniq-release-partial-"));
  const input = join(root, "input");
  const output = join(root, "output");
  fixture(input, targets.windows, [["miniQ-setup.exe"], ["miniQ-setup.exe.sig", "windows-signature"]]);

  const manifest = buildRelease({
    input,
    output,
    tag: "v1.2.3",
    repo: "LeadingThink/miniQ-releases",
    publishedAt: "2026-08-30T00:00:00.000Z",
  });

  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
  assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
  assert.match(manifest.platforms["windows-x86_64"].url, /miniQ_1\.2\.3_x64-setup\.exe$/);
});

test("fails when no signed updater artifacts exist", () => {
  const root = mkdtempSync(join(tmpdir(), "miniq-release-missing-"));
  assert.throws(
    () => buildRelease({ input: root, output: join(root, "out"), tag: "v1.2.3", repo: "LeadingThink/miniQ-releases" }),
    /expected at least one signed updater artifact/,
  );
});
