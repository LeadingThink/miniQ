import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const host = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const plugin = fileURLToPath(new URL("./fixtures/plugin.mjs", import.meta.url));

function harness() {
  const child = spawn(process.execPath, [host], { stdio: ["pipe", "pipe", "pipe"], env: {} });
  const messages = [];
  createInterface({ input: child.stdout }).on("line", (line) => messages.push(JSON.parse(line)));
  const send = (id, method, params = {}) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`message not received: ${JSON.stringify(messages)}`);
  };
  return { child, messages, send, waitFor };
}

test("activates, registers, executes, cancels and shuts down", async () => {
  const h = harness();
  await h.waitFor((message) => message.method === "hello");
  h.send(1, "initialize", { protocolVersion: 1, pluginId: "dev.miniq.host-fixture", pluginVersion: "1.0.0", entry: plugin, maxFrameBytes: 1048576, maxPendingRequests: 4 });
  await h.waitFor((message) => message.id === 1);
  h.send(2, "activate");
  await h.waitFor((message) => message.method === "activated");
  assert.equal(h.messages.filter((message) => message.method === "tools.register").length, 2);
  h.send(3, "tool.execute", { callId: "echo-1", toolName: "echo", input: { value: 42 } });
  assert.deepEqual((await h.waitFor((message) => message.method === "tool.result" && message.params.callId === "echo-1")).params.result, { value: 42 });
  h.send(4, "tool.execute", { callId: "wait-1", toolName: "wait", input: {} });
  await h.waitFor((message) => message.id === 4);
  h.send(5, "tool.cancel", { callId: "wait-1" });
  assert.equal((await h.waitFor((message) => message.method === "tool.result" && message.params.callId === "wait-1")).params.error.code, "cancelled");
  h.send(6, "shutdown");
  assert.equal(await new Promise((resolve) => h.child.on("exit", resolve)), 0);
});

test("rejects an incompatible protocol before importing the plugin", async () => {
  const h = harness();
  await h.waitFor((message) => message.method === "hello");
  h.send(1, "initialize", { protocolVersion: 99, pluginId: "dev.miniq.host-fixture", pluginVersion: "1.0.0", entry: "missing.mjs", maxFrameBytes: 1048576, maxPendingRequests: 4 });
  const response = await h.waitFor((message) => message.id === 1);
  assert.equal(response.error.code, "protocol_mismatch");
  h.child.kill();
});
