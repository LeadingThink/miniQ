#!/usr/bin/env node
// Isolated, opt-in macOS/Linux SSH integration smoke. Never uses ~/.ssh or a
// production daemon/key. Generated keys are private and removed on completion.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as tcpServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const root = await mkdtemp(path.join(tmpdir(), "miniq-ssh-smoke-"));
const binary = path.join(repository, "target/debug/miniq");
const daemon = path.join(repository, "target/debug/miniq-daemon");
const data = path.join(root, "data");
const project = path.join(root, "project");
const sshConfig = path.join(root, "ssh_config");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const children = new Set();
const timeout = (promise, label, ms = 20_000) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

function processFor(command, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("MINIQ_") &&
        !/^(OPENAI|ANTHROPIC|GEMINI)_API_KEY$/.test(name),
    ),
  );
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

async function command(command, args) {
  const child = processFor(command, args);
  let stderr = "";
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  child.stdout.resume();
  child.stdin.end();
  const code = await timeout(
    new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    }),
    command,
  );
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}`);
}

async function unusedPort() {
  const server = tcpServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connect() {
  const child = processFor("/usr/bin/ssh", [
    "-F",
    sshConfig,
    "miniq-smoke",
    "miniq bridge",
  ]);
  let stderr = "";
  const pending = new Map();
  let nextId = 0;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  child.once("error", readyReject);
  child.stdin.on("error", (error) => {
    readyReject(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  child.once("exit", (code) => {
    const error = new Error(`SSH exited ${code}: ${stderr}`);
    readyReject(error);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  const lines = createInterface({ input: child.stdout });
  let first = true;
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      readyReject(new Error("SSH stdout is not JSONL"));
      return;
    }
    if (first) {
      first = false;
      if (
        message.type !== "miniq_bridge_ready" ||
        message.protocolVersion !== 2
      ) {
        readyReject(
          new Error("SSH did not return the compatible bridge handshake"),
        );
      } else readyResolve(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  await timeout(ready, "SSH bridge ready");
  return {
    call(method, params = {}) {
      if (
        child.exitCode !== null ||
        child.stdin.destroyed ||
        child.stdin.writableEnded
      ) {
        return Promise.reject(new Error("SSH fixture connection is closed"));
      }
      const id = `smoke-${++nextId}`;
      return timeout(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(
            `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
          );
        }),
        method,
      );
    },
    async disconnect() {
      child.stdin.end();
      assert.equal(await timeout(closed, "SSH detach"), 0, stderr);
    },
  };
}

let current;
let provider;
let sshd;
let releaseAnswer;
let requestStarted;
const started = new Promise((resolve) => {
  requestStarted = resolve;
});
const answerGate = new Promise((resolve) => {
  releaseAnswer = resolve;
});
let requestCount = 0;
let fixtureSession;

try {
  await mkdir(data);
  await mkdir(project);
  await writeFile(
    path.join(project, "fixture.txt"),
    "Only isolated SSH smoke data.\n",
    { mode: 0o600 },
  );
  await command("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(root, "host"),
  ]);
  await command("/usr/bin/ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-f",
    path.join(root, "client"),
  ]);
  const port = await unusedPort();
  const hostPublic = (
    await readFile(path.join(root, "host.pub"), "utf8")
  ).trim();
  await writeFile(
    path.join(root, "known_hosts"),
    `[127.0.0.1]:${port} ${hostPublic}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    sshConfig,
    `Host miniq-smoke\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${root}/client\n IdentitiesOnly yes\n UserKnownHostsFile ${root}/known_hosts\n StrictHostKeyChecking yes\n BatchMode yes\n LogLevel ERROR\n`,
    { mode: 0o600 },
  );
  const daemonConfig = path.join(root, "sshd_config");
  await writeFile(
    daemonConfig,
    `ListenAddress 127.0.0.1\nPort ${port}\nHostKey ${root}/host\nPidFile ${root}/sshd.pid\nAuthorizedKeysFile ${root}/client.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTTY no\nForceCommand /usr/bin/env -u MINIQ_BASE_URL -u MINIQ_MODEL -u MINIQ_API_KEY -u MINIQ_API_PROTOCOL ${quote(binary)} --data-dir ${quote(data)} --daemon-path ${quote(daemon)} bridge\n`,
    { mode: 0o600 },
  );
  await command("/usr/sbin/sshd", ["-t", "-f", daemonConfig]);
  sshd = processFor("/usr/sbin/sshd", ["-D", "-e", "-f", daemonConfig]);
  let sshdError = "";
  sshd.stderr.on("data", (part) => {
    sshdError += part;
  });
  await timeout(
    new Promise((resolve, reject) => {
      sshd.once("error", reject);
      sshd.once("exit", (code) =>
        reject(new Error(`isolated sshd exited ${code}: ${sshdError}`)),
      );
      sshd.stderr.on("data", () => {
        if (sshdError.includes("Server listening on")) resolve();
      });
    }),
    "isolated sshd startup",
  );

  provider = httpServer(async (request, response) => {
    request.resume();
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    requestCount++;
    requestStarted();
    await answerGate;
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "SSH fixture task completed." }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));

  current = await connect();
  assert.equal((await current.call("daemon.health")).protocolVersion, 2);
  await current.call("settings.update", {
    provider: {
      baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
      model: "fixture-ssh-chat",
      apiProtocol: "chat_completions",
      apiKey: "isolated-fixture-key",
    },
  });
  const workspace = await current.call("workspace.open", {
    path: project,
    name: "SSH smoke",
  });
  const session = await current.call("session.create", {
    workspaceId: workspace.id,
    title: "SSH persistence smoke",
  });
  fixtureSession = session.id;
  await current.call("session.sendMessage", {
    sessionId: session.id,
    rejectIfBusy: true,
    message: {
      role: "user",
      content: "Reply with SSH fixture task completed. Do not use tools.",
    },
  });
  await timeout(started, "fixture task start");
  await current.disconnect();
  current = await connect();
  const resumed = await current.call("session.open", { sessionId: session.id });
  assert.equal(resumed.session.status, "running");
  assert.equal(
    resumed.messages.filter((message) => message.role === "user").length,
    1,
  );
  releaseAnswer();
  let completed;
  await timeout(
    (async () => {
      for (;;) {
        completed = await current.call("session.open", {
          sessionId: session.id,
        });
        if (completed.lastTurn?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })(),
    "fixture task completion",
  );
  assert.ok(
    completed.messages.some(
      (message) => message.content === "SSH fixture task completed.",
    ),
  );
  assert.equal(requestCount, 1);
  await current.disconnect();
  current = await connect();
  assert.ok(
    (
      await current.call("session.list", { workspaceId: workspace.id })
    ).sessions.some((item) => item.id === session.id),
  );
  console.log(
    "PASS: real SSH authentication, bridge/RPC, active task survives detach, reconnect recovers final output, exactly one provider request.",
  );
  if (process.argv.includes("--keep")) {
    console.log(`Native smoke fixture: MINIQ_SSH_SMOKE_CONFIG=${sshConfig}`);
    console.log(
      `Fixture process PID: ${process.pid}; SIGTERM finishes cleanup.`,
    );
    await new Promise((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  releaseAnswer();
  if (current) {
    if (process.exitCode && fixtureSession)
      await current
        .call("session.cancel", { sessionId: fixtureSession })
        .catch(() => {});
    await current.call("daemon.shutdownIfIdle").catch(() => {});
    await current.disconnect().catch(() => {});
  }
  // If SSH failed after daemon startup but before ready, still clean up only
  // the daemon in this test's newly-created private directory.
  await command(binary, [
    "--no-start",
    "--data-dir",
    data,
    "rpc",
    "daemon.shutdownIfIdle",
  ]).catch(() => {});
  for (const child of children) child.kill("SIGTERM");
  if (provider) await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
