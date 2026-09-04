#!/usr/bin/env node
import { pathToFileURL } from "node:url";
const PROTOCOL_VERSION = 1;
const HOST_VERSION = "1.0.0";
let maxFrameBytes = 1024 * 1024;
let maxPendingRequests = 32;
let initialized = null;
let plugin = null;
const tools = new Map();
const calls = new Map();
let queue = Promise.resolve();
let inputBuffer = Buffer.alloc(0);
let stopping = false;
for (const level of ["log", "debug", "info", "warn", "error"]) {
    console[level] = (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`);
}
function coded(code, message, data) {
    return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}
function rpcError(error) {
    const value = error;
    return {
        code: value?.code || "internal",
        message: error instanceof Error ? error.message : String(error),
        ...(value?.data === undefined ? {} : { data: value.data }),
    };
}
function write(message) {
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > maxFrameBytes) {
        throw coded("message_too_large", "outbound protocol frame exceeds configured limit");
    }
    process.stdout.write(frame);
}
function notify(method, params) {
    write({ jsonrpc: "2.0", method, params });
}
function respond(id, result) {
    write({ jsonrpc: "2.0", id, result });
}
function assertObject(value, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw coded("invalid_request", `${name} must be an object`);
    }
    return value;
}
function context() {
    const log = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [
        level,
        (message) => notify("log", { level, message: String(message) }),
    ]));
    return {
        log,
        tools: {
            register(definition) {
                assertObject(definition, "tool");
                const { name, description, inputSchema, outputSchema, execute } = definition;
                if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name || "") || typeof description !== "string" || typeof execute !== "function") {
                    throw coded("invalid_plugin", "tool name, description, and execute are invalid");
                }
                if (tools.has(name))
                    throw coded("invalid_plugin", `duplicate tool name: ${name}`);
                assertObject(inputSchema, "inputSchema");
                assertObject(outputSchema, "outputSchema");
                tools.set(name, definition);
                notify("tools.register", { tools: [{ name, description, inputSchema, outputSchema }] });
                let disposed = false;
                return {
                    dispose() {
                        if (!disposed) {
                            disposed = true;
                            tools.delete(name);
                            notify("tools.unregister", { names: [name] });
                        }
                    },
                };
            },
        },
    };
}
async function initialize(params) {
    const value = assertObject(params, "initialize params");
    if (value.protocolVersion !== PROTOCOL_VERSION) {
        throw coded("protocol_mismatch", `unsupported protocol version: ${value.protocolVersion}`);
    }
    if (!Number.isInteger(value.maxFrameBytes) || Number(value.maxFrameBytes) < 1024 || !Number.isInteger(value.maxPendingRequests) || Number(value.maxPendingRequests) < 1) {
        throw coded("invalid_request", "invalid protocol limits");
    }
    maxFrameBytes = Number(value.maxFrameBytes);
    maxPendingRequests = Number(value.maxPendingRequests);
    initialized = value;
    return {};
}
async function activate() {
    if (!initialized)
        throw coded("invalid_request", "initialize must run before activate");
    const module = await import(pathToFileURL(String(initialized.entry)).href);
    plugin = module.default;
    if (!plugin || plugin.id !== initialized.pluginId || plugin.version !== initialized.pluginVersion || typeof plugin.activate !== "function") {
        throw coded("invalid_plugin", "plugin identity does not match manifest");
    }
    await plugin.activate(context());
    notify("activated", {});
    return {};
}
async function execute(params) {
    const value = assertObject(params, "tool.execute params");
    const callId = String(value.callId);
    const toolName = String(value.toolName);
    if (calls.size >= maxPendingRequests)
        throw coded("capacity_exceeded", "too many pending tool calls");
    const tool = tools.get(toolName);
    if (!tool)
        throw coded("tool_not_found", `unknown tool: ${toolName}`);
    if (calls.has(callId))
        throw coded("invalid_request", `duplicate call id: ${callId}`);
    const controller = new AbortController();
    calls.set(callId, controller);
    Promise.resolve()
        .then(() => tool.execute(value.input, controller.signal))
        .then((result) => notify("tool.result", { callId, result, error: null }), (error) => notify("tool.result", { callId, result: null, error: rpcError(error) }))
        .finally(() => calls.delete(callId));
    return {};
}
async function cancel(params) {
    const value = assertObject(params, "tool.cancel params");
    calls.get(String(value.callId))?.abort();
    return {};
}
async function deactivate() {
    for (const controller of calls.values())
        controller.abort();
    calls.clear();
    if (plugin?.deactivate)
        await plugin.deactivate();
    const names = [...tools.keys()];
    tools.clear();
    if (names.length)
        notify("tools.unregister", { names });
    plugin = null;
    return {};
}
async function dispatch(request) {
    if (request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) || typeof request.method !== "string") {
        throw coded("invalid_request", "invalid JSON-RPC request");
    }
    switch (request.method) {
        case "initialize": return { result: await initialize(request.params), shutdown: false };
        case "activate": return { result: await activate(), shutdown: false };
        case "tool.execute": return { result: await execute(request.params), shutdown: false };
        case "tool.cancel": return { result: await cancel(request.params), shutdown: false };
        case "deactivate": return { result: await deactivate(), shutdown: false };
        case "ping":
            notify("pong", {});
            return { result: {}, shutdown: false };
        case "shutdown": return { result: await deactivate(), shutdown: true };
        default: throw coded("invalid_request", `unsupported method: ${request.method}`);
    }
}
async function processFrame(frame) {
    let request;
    try {
        request = assertObject(JSON.parse(frame.toString("utf8")), "request");
    }
    catch (error) {
        throw coded("invalid_request", error instanceof Error ? error.message : "malformed JSON protocol frame");
    }
    try {
        const outcome = await dispatch(request);
        respond(Number(request.id), outcome.result);
        if (outcome.shutdown) {
            stopping = true;
            process.stdin.pause();
            process.exit(0);
        }
    }
    catch (error) {
        write({ jsonrpc: "2.0", id: Number.isSafeInteger(request.id) ? request.id : 0, error: rpcError(error) });
    }
}
function failInput(error) {
    try {
        notify("error", rpcError(error));
    }
    catch { /* stdout may already be unavailable */ }
    stopping = true;
    process.exitCode = 1;
    process.stdin.destroy();
}
notify("hello", { protocolVersion: PROTOCOL_VERSION, hostVersion: HOST_VERSION, nodeVersion: process.versions.node });
process.stdin.on("data", (chunk) => {
    if (stopping)
        return;
    inputBuffer = Buffer.concat([inputBuffer, chunk]);
    while (true) {
        const newline = inputBuffer.indexOf(0x0a);
        if (newline < 0) {
            if (inputBuffer.length > maxFrameBytes)
                failInput(coded("message_too_large", "inbound protocol frame exceeds configured limit"));
            return;
        }
        const frame = inputBuffer.subarray(0, newline);
        inputBuffer = inputBuffer.subarray(newline + 1);
        if (frame.length > maxFrameBytes) {
            failInput(coded("message_too_large", "inbound protocol frame exceeds configured limit"));
            return;
        }
        if (frame.length)
            queue = queue.then(() => processFrame(frame)).catch(failInput);
    }
});
process.stdin.on("end", () => {
    for (const controller of calls.values())
        controller.abort();
    if (inputBuffer.length && !stopping)
        failInput(coded("invalid_request", "unterminated protocol frame"));
});
