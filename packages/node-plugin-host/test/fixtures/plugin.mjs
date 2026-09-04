export default {
  id: "dev.miniq.host-fixture",
  version: "1.0.0",
  activate(ctx) {
    ctx.tools.register({
      name: "echo",
      description: "Echo input",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execute(input) { return input; }
    });
    ctx.tools.register({
      name: "wait",
      description: "Wait until cancelled",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      execute(_input, signal) { return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("cancelled"), { code: "cancelled" })), { once: true })); }
    });
  }
};
