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
export declare class PluginError extends Error {
    readonly code: string;
    readonly data?: unknown;
    constructor(code: string, message: string, data?: unknown);
}
export declare function definePlugin<T extends PluginDefinition>(plugin: T): T;
