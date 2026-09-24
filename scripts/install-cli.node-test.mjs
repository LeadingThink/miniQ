import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = resolve(dirname(fileURLToPath(import.meta.url)), "install-cli.sh");
const supported = platform() === "darwin" || (platform() === "linux" && arch() === "x64");
const target = platform() === "darwin" ? `${arch() === "arm64" ? "aarch64" : "x86_64"}-apple-darwin` : "x86_64-unknown-linux-gnu";
const origin = "https://oss.zaiwen.top/releases/miniq";
function script(path, source) { writeFileSync(path, `#!/bin/sh\nset -eu\n${source}\n`); chmodSync(path, 0o755); }
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "miniq-installer-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mock = join(root, "mock");
  const bin = join(root, "install with spaces", "bin");
  mkdirSync(mock);
  script(join(mock, "curl"), `url=; output=\nwhile [ "$#" -gt 0 ]; do\n case "$1" in https://*) url="$1";; -o) shift; output="$1";; esac\n shift\ndone\nprintf '%s\\n' "$url" >> "$MINIQ_FIXTURE/requests"\ncase "$url" in */terminal.json) cp "$MINIQ_FIXTURE/terminal.json" "$output";; *.tar.gz) cp "$MINIQ_FIXTURE/archive.tar.gz" "$output";; *) exit 2;; esac`);
  const env = { ...process.env, PATH: `${mock}:${process.env.PATH}`, MINIQ_FIXTURE: root, MINIQ_INSTALL_DIR: bin, MINIQ_NO_MODIFY_PATH: "1" };
  delete env.MINIQ_VERSION;
  function archive(version, { checksum, daemon = true } = {}) {
    const payload = join(root, `payload-${version}`);
    mkdirSync(payload);
    script(join(payload, "miniq"), `[ "$1" = --version ] || exit 91\nprintf 'miniq ${version}\\n'`);
    if (daemon) script(join(payload, "miniq-daemon"), `printf 'daemon ${version}\\n'`);
    const packaged = spawnSync("tar", ["-czf", join(root, "archive.tar.gz"), "-C", payload, "."], { encoding: "utf8" });
    assert.equal(packaged.status, 0, packaged.stderr);
    const sha256 = checksum ?? createHash("sha256").update(readFileSync(join(root, "archive.tar.gz"))).digest("hex");
    writeFileSync(join(root, "terminal.json"), `${JSON.stringify({ version, platforms: { [target]: { url: `${origin}/v${version}/miniQ_terminal_${version}_${target}.tar.gz`, sha256 } } }, null, 2)}\n`);
  }
  function run(extra = {}) { return spawnSync("sh", [installer], { env: { ...env, ...extra }, encoding: "utf8", timeout: 15000 }); }
  return { root, bin, env, archive, run };
}

test("fresh install and upgrade atomically switch the pair without executing the daemon", { skip: !supported }, t => {
  const f = fixture(t);
  f.archive("1.2.3");
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(f.bin, ".miniq/managed"), "utf8"), "miniq-terminal-v1\n");
  assert.equal(readlinkSync(join(f.bin, "miniq")), ".miniq/current/miniq");
  assert.equal(spawnSync(join(f.bin, "miniq"), ["--version"], { encoding: "utf8" }).stdout, "miniq 1.2.3\n");
  f.archive("1.2.4");
  result = f.run({ MINIQ_VERSION: "1.2.4" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readlinkSync(join(f.bin, ".miniq/current")), "versions/1.2.4");
  assert.match(readFileSync(join(f.bin, "miniq-daemon"), "utf8"), /daemon 1\.2\.4/);
  assert.ok(existsSync(join(f.bin, ".miniq/versions/1.2.3/miniq-daemon")), "running old pair stays available");
  assert.match(readFileSync(join(f.root, "requests"), "utf8"), /v1\.2\.4\/terminal.json/);
  assert.equal(existsSync(join(f.bin, ".miniq-install.lock")), false);
});

test("checksum rejection and incomplete pair leave installed binaries untouched", { skip: !supported }, t => {
  const f = fixture(t);
  f.archive("1.2.3");
  assert.equal(f.run().status, 0);
  f.archive("1.2.4", { checksum: "0".repeat(64) });
  assert.match(f.run().stderr, /checksum mismatch/);
  assert.equal(readlinkSync(join(f.bin, ".miniq/current")), "versions/1.2.3");
  f.archive("1.2.5", { daemon: false });
  assert.match(f.run().stderr, /Missing executable: miniq-daemon/);
  assert.equal(readlinkSync(join(f.bin, ".miniq/current")), "versions/1.2.3");
});

test("preflights both legacy destinations and respects another installer lock", { skip: !supported }, t => {
  const f = fixture(t);
  f.archive("1.2.3");
  mkdirSync(join(f.bin, "miniq-daemon"), { recursive: true });
  script(join(f.bin, "miniq"), "printf 'legacy'");
  const before = readFileSync(join(f.bin, "miniq"), "utf8");
  assert.match(f.run().stderr, /Cannot replace a directory/);
  assert.equal(readFileSync(join(f.bin, "miniq"), "utf8"), before);
  mkdirSync(join(f.bin, ".miniq-install.lock"));
  assert.match(f.run().stderr, /Another installer/);
  assert.ok(existsSync(join(f.bin, ".miniq-install.lock")), "must not remove someone else's lock");
});

test("updates PATH idempotently, handles quoting and an unset SHELL", { skip: !supported }, t => {
  const f = fixture(t);
  f.archive("1.2.3");
  delete f.env.SHELL;
  assert.equal(f.run().status, 0, "SHELL is not mandatory for installation");
  const profiles = join(f.root, "profiles");
  const extras = { SHELL: "/bin/zsh", ZDOTDIR: profiles, MINIQ_NO_MODIFY_PATH: "0", MINIQ_INSTALL_DIR: join(f.root, "it's miniQ", "bin") };
  let result = f.run(extras);
  assert.equal(result.status, 0, result.stderr);
  result = f.run(extras);
  assert.equal(result.status, 0, result.stderr);
  const profile = readFileSync(join(profiles, ".zshrc"), "utf8");
  assert.equal(profile.match(/miniQ terminal PATH/g).length, 1);
  const sourced = spawnSync("sh", ["-c", '. "$1"; command -v miniq', "sh", join(profiles, ".zshrc")], { env: f.env, encoding: "utf8" });
  assert.equal(sourced.status, 0, sourced.stderr);
  assert.equal(sourced.stdout.trim(), join(realpathSync(extras.MINIQ_INSTALL_DIR), "miniq"));
  const second = { ...extras, MINIQ_INSTALL_DIR: join(f.root, "another", "bin") };
  result = f.run(second);
  assert.equal(result.status, 0, result.stderr);
  const switched = spawnSync("sh", ["-c", '. "$1"; command -v miniq', "sh", join(profiles, ".zshrc")], { env: f.env, encoding: "utf8" });
  assert.equal(switched.stdout.trim(), join(realpathSync(second.MINIQ_INSTALL_DIR), "miniq"));
});

test("rolls both legacy executables back if a link replacement fails", { skip: !supported }, t => {
  const f = fixture(t);
  f.archive("1.2.3");
  mkdirSync(f.bin, { recursive: true });
  for (const name of ["miniq", "miniq-daemon"]) script(join(f.bin, name), `printf 'legacy ${name}'`);
  const before = ["miniq", "miniq-daemon"].map(name => readFileSync(join(f.bin, name), "utf8"));
  script(join(f.root, "mock", "mv"), 'for arg in "$@"; do case "$arg" in */.miniq-install.lock/miniq-daemon) exit 73;; esac; done\nexec /bin/mv "$@"');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(["miniq", "miniq-daemon"].map(name => readFileSync(join(f.bin, name), "utf8")), before);
  assert.equal(existsSync(join(f.bin, ".miniq-install.lock")), false);
});

test("unsupported architecture fails before any download", { skip: !supported }, t => {
  const f = fixture(t);
  script(join(f.root, "mock", "uname"), 'if [ "$1" = -s ]; then printf "Linux\\n"; else printf "aarch64\\n"; fi');
  assert.match(f.run().stderr, /Unsupported platform: Linux\/aarch64/);
  assert.equal(existsSync(join(f.root, "requests")), false);
});

test("rejects a pinned version mismatch before downloading a payload", { skip: !supported }, t => {
  const f = fixture(t);
  f.archive("1.2.3");
  const result = f.run({ MINIQ_VERSION: "1.2.4" });
  assert.match(result.stderr, /Manifest version does not match/);
  assert.doesNotMatch(readFileSync(join(f.root, "requests"), "utf8"), /tar.gz/);
});
