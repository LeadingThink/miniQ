import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const allowedLibraries = new Set([
  "libc.so.6",
  "libm.so.6",
  "libgcc_s.so.1",
  "libdl.so.2",
  "librt.so.1",
  "libpthread.so.0",
  "libutil.so.1",
  "ld-linux-x86-64.so.2",
]);

export function verifyElf(dynamicSection, versionSection, label) {
  const libraries = [
    ...dynamicSection.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g),
  ].map((match) => match[1]);
  if (!libraries.includes("libc.so.6"))
    throw new Error(`${label}: expected a GNU/Linux binary`);
  const unexpected = libraries.filter((name) => !allowedLibraries.has(name));
  if (unexpected.length)
    throw new Error(
      `${label}: non-server runtime dependencies: ${unexpected.join(", ")}`,
    );
  const versions = [
    ...versionSection.matchAll(/\bGLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g),
  ].map((match) => [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]);
  if (!versions.length)
    throw new Error(`${label}: no GLIBC symbol versions found`);
  if (
    versions.some(
      ([major, minor, patch]) =>
        major > 2 ||
        (major === 2 && (minor > 31 || (minor === 31 && patch > 0))),
    )
  ) {
    throw new Error(
      `${label}: requires glibc newer than the supported 2.31 baseline`,
    );
  }
  versions.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return {
    libraries,
    maximumGlibc: versions.at(-1).join(".").replace(/\.0$/, ""),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!process.argv[2])
    throw new Error("usage: node linux-terminal.mjs BINARY_DIRECTORY");
  for (const name of ["miniq", "miniq-daemon"]) {
    const binary = join(resolve(process.argv[2]), name);
    const dynamic = execFileSync("readelf", ["-d", binary], {
      encoding: "utf8",
    });
    const versions = execFileSync("readelf", ["--version-info", binary], {
      encoding: "utf8",
    });
    console.log(name, verifyElf(dynamic, versions, name));
  }
}
