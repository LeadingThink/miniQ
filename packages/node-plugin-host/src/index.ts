#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 1;
const HOST_VERSION = "1.0.0";

type JsonObject = Record<string, unknown>;
type RpcError = { code: string; message: string; data?: unknown };
type ToolDefinition = {
	name: string;
	description: string;
	inputSchema: JsonObject;
	outputSchema: JsonObject;
	execute(input: unknown, signal: AbortSignal): unknown | Promise<unknown>;
};
type PluginContext = {
	log: Record<string, (message: unknown) => void>;
	tools: { register(definition: ToolDefinition): { dispose(): void } };
};
type PluginModule = {
	id: string;
	version: string;
	activate(context: PluginContext): unknown | Promise<unknown>;
	deactivate?(): unknown | Promise<unknown>;
};

let maxFrameBytes = 1024 * 1024;
let maxPendingRequests = 32;
let initialized: JsonObject | null = null;
let plugin: PluginModule | null = null;
const tools = new Map<string, ToolDefinition>();
const calls = new Map<string, AbortController>();
let queue = Promise.resolve();
let inputBuffer = Buffer.alloc(0);
let stopping = false;

for (const level of ["log", "debug", "info", "warn", "error"] as const) {
	console[level] = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
}

function coded(code: string, message: string, data?: unknown): Error & { code: string; data?: unknown } {
	return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

function rpcError(error: unknown): RpcError {
	const value = error as { code?: string; data?: unknown } | undefined;
	return {
		code: value?.code || "internal",
		message: error instanceof Error ? error.message : String(error),
		...(value?.data === undefined ? {} : { data: value.data }),
	};
}

function write(message: unknown): void {
	const frame = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(frame) > maxFrameBytes) {
		throw coded("message_too_large", "outbound protocol frame exceeds configured limit");
	}
	process.stdout.write(frame);
}

function notify(method: string, params: unknown): void {
	write({ jsonrpc: "2.0", method, params });
}

function respond(id: number, result: unknown): void {
	write({ jsonrpc: "2.0", id, result });
}

function assertObject(value: unknown, name: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw coded("invalid_request", `${name} must be an object`);
	}
	return value as JsonObject;
}

function context() {
	const log = Object.fromEntries(
		["debug", "info", "warn", "error"].map((level) => [
			level,
			(message: unknown) => notify("log", { level, message: String(message) }),
		]),
	);
	return {
		log,
		tools: {
			register(definition: ToolDefinition) {
				assertObject(definition, "tool");
				const { name, description, inputSchema, outputSchema, execute } = definition;
				if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name || "") || typeof description !== "string" || typeof execute !== "function") {
					throw coded("invalid_plugin", "tool name, description, and execute are invalid");
				}
				if (tools.has(name)) throw coded("invalid_plugin", `duplicate tool name: ${name}`);
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

async function initialize(params: unknown): Promise<JsonObject> {
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

async function activate(): Promise<JsonObject> {
	if (!initialized) throw coded("invalid_request", "initialize must run before activate");
	const module = await import(pathToFileURL(String(initialized.entry)).href);
	plugin = module.default as PluginModule;
	if (!plugin || plugin.id !== initialized.pluginId || plugin.version !== initialized.pluginVersion || typeof plugin.activate !== "function") {
		throw coded("invalid_plugin", "plugin identity does not match manifest");
	}
	await plugin.activate(context());
	notify("activated", {});
	return {};
}

async function execute(params: unknown): Promise<JsonObject> {
	const value = assertObject(params, "tool.execute params");
	const callId = String(value.callId);
	const toolName = String(value.toolName);
	if (calls.size >= maxPendingRequests) throw coded("capacity_exceeded", "too many pending tool calls");
	const tool = tools.get(toolName);
	if (!tool) throw coded("tool_not_found", `unknown tool: ${toolName}`);
	if (calls.has(callId)) throw coded("invalid_request", `duplicate call id: ${callId}`);
	const controller = new AbortController();
	calls.set(callId, controller);
	Promise.resolve()
		.then(() => tool.execute(value.input, controller.signal))
		.then(
			(result) => notify("tool.result", { callId, result, error: null }),
			(error) => notify("tool.result", { callId, result: null, error: rpcError(error) }),
		)
		.finally(() => calls.delete(callId));
	return {};
}

async function cancel(params: unknown): Promise<JsonObject> {
	const value = assertObject(params, "tool.cancel params");
	calls.get(String(value.callId))?.abort();
	return {};
}

async function deactivate(): Promise<JsonObject> {
	for (const controller of calls.values()) controller.abort();
	calls.clear();
	if (plugin?.deactivate) await plugin.deactivate();
	const names = [...tools.keys()];
	tools.clear();
	if (names.length) notify("tools.unregister", { names });
	plugin = null;
	return {};
}

async function dispatch(request: JsonObject): Promise<{ result: unknown; shutdown: boolean }> {
	if (request.jsonrpc !== "2.0" || !Number.isSafeInteger(request.id) || typeof request.method !== "string") {
		throw coded("invalid_request", "invalid JSON-RPC request");
	}
	switch (request.method) {
		case "initialize": return { result: await initialize(request.params), shutdown: false };
		case "activate": return { result: await activate(), shutdown: false };
		case "tool.execute": return { result: await execute(request.params), shutdown: false };
		case "tool.cancel": return { result: await cancel(request.params), shutdown: false };
		case "deactivate": return { result: await deactivate(), shutdown: false };
		case "ping": notify("pong", {}); return { result: {}, shutdown: false };
		case "shutdown": return { result: await deactivate(), shutdown: true };
		default: throw coded("invalid_request", `unsupported method: ${request.method}`);
	}
}

async function processFrame(frame: Buffer): Promise<void> {
	let request: JsonObject;
	try {
		request = assertObject(JSON.parse(frame.toString("utf8")), "request");
	} catch (error) {
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
	} catch (error) {
		write({ jsonrpc: "2.0", id: Number.isSafeInteger(request.id) ? request.id : 0, error: rpcError(error) });
	}
}

function failInput(error: unknown): void {
	try { notify("error", rpcError(error)); } catch { /* stdout may already be unavailable */ }
	stopping = true;
	process.exitCode = 1;
	process.stdin.destroy();
}

notify("hello", { protocolVersion: PROTOCOL_VERSION, hostVersion: HOST_VERSION, nodeVersion: process.versions.node });
process.stdin.on("data", (chunk: Buffer) => {
	if (stopping) return;
	inputBuffer = Buffer.concat([inputBuffer, chunk]);
	while (true) {
		const newline = inputBuffer.indexOf(0x0a);
		if (newline < 0) {
			if (inputBuffer.length > maxFrameBytes) failInput(coded("message_too_large", "inbound protocol frame exceeds configured limit"));
			return;
		}
		const frame = inputBuffer.subarray(0, newline);
		inputBuffer = inputBuffer.subarray(newline + 1);
		if (frame.length > maxFrameBytes) {
			failInput(coded("message_too_large", "inbound protocol frame exceeds configured limit"));
			return;
		}
		if (frame.length) queue = queue.then(() => processFrame(frame)).catch(failInput);
	}
});
process.stdin.on("end", () => {
	for (const controller of calls.values()) controller.abort();
	if (inputBuffer.length && !stopping) failInput(coded("invalid_request", "unterminated protocol frame"));
});
