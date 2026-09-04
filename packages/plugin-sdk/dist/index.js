export class PluginError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = "PluginError";
        this.code = code;
        this.data = data;
    }
}
export function definePlugin(plugin) {
    if (!plugin || typeof plugin !== "object") {
        throw new PluginError("invalid_plugin", "plugin definition must be an object");
    }
    if (!plugin.id || !plugin.version || typeof plugin.activate !== "function") {
        throw new PluginError("invalid_plugin", "plugin id, version, and activate are required");
    }
    return Object.freeze(plugin);
}
