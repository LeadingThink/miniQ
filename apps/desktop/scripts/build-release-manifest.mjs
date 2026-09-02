import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TARGETS = {
  windows: "x86_64-pc-windows-msvc",
  macArm: "aarch64-apple-darwin",
  macIntel: "x86_64-apple-darwin",
  linux: "x86_64-unknown-linux-gnu",
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function findMatches(directory, suffix) {
  return walk(directory).filter((path) => basename(path).endsWith(suffix));
}

function findOptionalOne(directory, suffix, label) {
  if (!existsSync(directory)) return undefined;
  const matches = findMatches(directory, suffix);
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one *${suffix} file, found ${matches.length}`);
  }
  return matches[0];
}

function findOne(directory, suffix, label) {
  const match = findOptionalOne(directory, suffix, label);
  if (!match) throw new Error(`${label}: expected one *${suffix} file, found 0`);
  return match;
}

function artifactDirectory(input, target) {
  return join(input, `miniq-release-${target}`);
}

function copyArtifact(source, output, name) {
  copyFileSync(source, join(output, name));
  return name;
}

function updateEntry(source, signatureSource, output, name, baseUrl) {
  copyArtifact(source, output, name);
  copyArtifact(signatureSource, output, `${name}.sig`);
  return {
    signature: readFileSync(signatureSource, "utf8").trim(),
    url: `${baseUrl}/${name}`,
  };
}

function optionalEntry(directory, artifactSuffix, signatureSuffix, label, output, name, baseUrl) {
  if (!existsSync(directory)) return undefined;
  const artifact = findOptionalOne(directory, artifactSuffix, `${label} updater`);
  const signature = findOptionalOne(directory, signatureSuffix, `${label} signature`);
  if (!artifact && !signature) return undefined;
  if (!artifact) throw new Error(`${label} updater: expected one *${artifactSuffix} file, found 0`);
  if (!signature) throw new Error(`${label} signature: expected one *${signatureSuffix} file, found 0`);
  return updateEntry(
    artifact,
    signature,
    output,
    name,
    baseUrl,
  );
}

function copyOptionalArtifact(directory, suffix, label, output, name) {
  const artifact = findOptionalOne(directory, suffix, label);
  if (artifact) copyArtifact(artifact, output, name);
}

export function buildRelease({ input, output, tag, repo, notes = "", publishedAt = new Date().toISOString() }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`invalid release tag: ${tag}`);
  const version = tag.slice(1);
  const inputRoot = resolve(input);
  const outputRoot = resolve(output);
  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;
  mkdirSync(outputRoot, { recursive: true });

  const windows = artifactDirectory(inputRoot, TARGETS.windows);
  const macArm = artifactDirectory(inputRoot, TARGETS.macArm);
  const macIntel = artifactDirectory(inputRoot, TARGETS.macIntel);
  const linux = artifactDirectory(inputRoot, TARGETS.linux);

  const platforms = {};
  const windowsEntry = optionalEntry(
    windows,
    ".exe",
    ".exe.sig",
    "Windows",
    outputRoot,
    `miniQ_${version}_x64-setup.exe`,
    baseUrl,
  );
  if (windowsEntry) platforms["windows-x86_64"] = windowsEntry;

  const macArmEntry = optionalEntry(
    macArm,
    ".app.tar.gz",
    ".app.tar.gz.sig",
    "Apple Silicon",
    outputRoot,
    `miniQ_${version}_aarch64.app.tar.gz`,
    baseUrl,
  );
  if (macArmEntry) platforms["darwin-aarch64"] = macArmEntry;

  const macIntelEntry = optionalEntry(
    macIntel,
    ".app.tar.gz",
    ".app.tar.gz.sig",
    "Intel macOS",
    outputRoot,
    `miniQ_${version}_x64.app.tar.gz`,
    baseUrl,
  );
  if (macIntelEntry) platforms["darwin-x86_64"] = macIntelEntry;

  const linuxEntry = optionalEntry(
    linux,
    ".AppImage.tar.gz",
    ".AppImage.tar.gz.sig",
    "Linux",
    outputRoot,
    `miniQ_${version}_x64.AppImage.tar.gz`,
    baseUrl,
  );
  if (linuxEntry) platforms["linux-x86_64"] = linuxEntry;

  if (Object.keys(platforms).length === 0) {
    throw new Error("expected at least one signed updater artifact");
  }

  copyOptionalArtifact(macArm, ".dmg", "Apple Silicon DMG", outputRoot, `miniQ_${version}_aarch64.dmg`);
  copyOptionalArtifact(macIntel, ".dmg", "Intel macOS DMG", outputRoot, `miniQ_${version}_x64.dmg`);
  copyOptionalArtifact(linux, ".AppImage", "Linux AppImage", outputRoot, `miniQ_${version}_x64.AppImage`);
  copyOptionalArtifact(linux, ".deb", "Linux deb", outputRoot, `miniQ_${version}_amd64.deb`);

  const manifest = { version, notes, pub_date: publishedAt, platforms };
  writeFileSync(join(outputRoot, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, "");
    const value = argv[index + 1];
    if (!key || value === undefined) throw new Error(`invalid argument near ${argv[index] ?? "end"}`);
    result[key] = value;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  buildRelease({
    input: args.input,
    output: args.output,
    tag: args.tag,
    repo: args.repo,
    notes: process.env.RELEASE_NOTES ?? "",
  });
}
