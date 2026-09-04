export type JsonSchema = Readonly<Record<string, unknown>>;
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ToolDefinition<Input = unknown, Output = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  execute(input: Input, signal: AbortSignal): Promise<Output> | Output;
}

export interface ToolRegistration {
  dispose(): void;
}

export interface PluginContext {
  readonly tools: {
    register<Input, Output>(tool: ToolDefinition<Input, Output>): ToolRegistration;
  };
  readonly log: PluginLogger;
}

export interface PluginDefinition {
  id: string;
  version: string;
  activate(context: PluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}

export class PluginError extends Error {
  readonly code: string;
  readonly data?: unknown;

  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.data = data;
  }
}

export function definePlugin<T extends PluginDefinition>(plugin: T): T {
  if (!plugin || typeof plugin !== "object") {
    throw new PluginError("invalid_plugin", "plugin definition must be an object");
  }
  if (!plugin.id || !plugin.version || typeof plugin.activate !== "function") {
    throw new PluginError("invalid_plugin", "plugin id, version, and activate are required");
  }
  return Object.freeze(plugin);
}
