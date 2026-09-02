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

function findOne(directory, suffix, label) {
  if (!existsSync(directory)) throw new Error(`${label}: expected one *${suffix} file, found 0`);
  const matches = walk(directory).filter((path) => basename(path).endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(`${label}: expected one *${suffix} file, found ${matches.length}`);
  }
  return matches[0];
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

  const platforms = {
    "windows-x86_64": updateEntry(
      findOne(windows, ".exe", "Windows installer"),
      findOne(windows, ".exe.sig", "Windows signature"),
      outputRoot,
      `miniQ_${version}_x64-setup.exe`,
      baseUrl,
    ),
    "darwin-aarch64": updateEntry(
      findOne(macArm, ".app.tar.gz", "Apple Silicon updater"),
      findOne(macArm, ".app.tar.gz.sig", "Apple Silicon signature"),
      outputRoot,
      `miniQ_${version}_aarch64.app.tar.gz`,
      baseUrl,
    ),
    "darwin-x86_64": updateEntry(
      findOne(macIntel, ".app.tar.gz", "Intel macOS updater"),
      findOne(macIntel, ".app.tar.gz.sig", "Intel macOS signature"),
      outputRoot,
      `miniQ_${version}_x64.app.tar.gz`,
      baseUrl,
    ),
    "linux-x86_64": updateEntry(
      findOne(linux, ".AppImage.tar.gz", "Linux updater"),
      findOne(linux, ".AppImage.tar.gz.sig", "Linux signature"),
      outputRoot,
      `miniQ_${version}_x64.AppImage.tar.gz`,
      baseUrl,
    ),
  };

  copyArtifact(findOne(macArm, ".dmg", "Apple Silicon DMG"), outputRoot, `miniQ_${version}_aarch64.dmg`);
  copyArtifact(findOne(macIntel, ".dmg", "Intel macOS DMG"), outputRoot, `miniQ_${version}_x64.dmg`);
  copyArtifact(findOne(linux, ".AppImage", "Linux AppImage"), outputRoot, `miniQ_${version}_x64.AppImage`);
  copyArtifact(findOne(linux, ".deb", "Linux deb"), outputRoot, `miniQ_${version}_amd64.deb`);

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
