// Object downloads can require repeating the RPC over encrypted chunks. Only
// handlers audited as reads may use that transport; commands must run once.
const replayableReads = new Set([
  "file.describe", "file.read", "file.list", "observation.read",
  "workspace.list", "session.list", "session.open", "session.history",
  "session.sync", "session.modelCalls", "session.executionEvents",
  "session.diff", "session.search", "session.queueList", "tool.detail",
  "agent.list", "agent.history", "agent.message", "agent.output",
]);

export function canReplayRemoteRead(method: string, params: unknown): boolean {
  // Inspect the operation inside the SSH tunnel, never the wrapper name alone.
  // The daemon allows one tunnel hop and rejects every nested host.* method.
  // This receives the JSON request snapshot, so caller-owned/cyclic objects
  // cannot change the decision while the request is in flight.
  if (method === "host.call") {
    if (!params || typeof params !== "object" || Array.isArray(params)) return false;
    const request = params as Record<string, unknown>;
    if (typeof request.method !== "string") return false;
    method = request.method;
    params = request.params;
  }
  return replayableReads.has(method);
}
