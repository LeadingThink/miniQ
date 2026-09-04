import { definePlugin } from "@miniq/plugin-sdk";

interface TransformInput {
  text: string;
  mode: "uppercase" | "lowercase" | "reverse";
}

const transformSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "mode"],
  properties: {
    text: { type: "string" },
    mode: { type: "string", enum: ["uppercase", "lowercase", "reverse"] },
  },
} as const;

export default definePlugin({
  id: "dev.miniq.text-utils",
  version: "1.0.0",
  activate(context) {
    context.tools.register<TransformInput, { text: string }>({
      name: "transform",
      description: "Transform text without accessing the filesystem or network",
      inputSchema: transformSchema,
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text"],
        properties: { text: { type: "string" } },
      },
      execute(input, signal) {
        signal.throwIfAborted();
        const text =
          input.mode === "uppercase"
            ? input.text.toUpperCase()
            : input.mode === "lowercase"
              ? input.text.toLowerCase()
              : Array.from(input.text).reverse().join("");
        return { text };
      },
    });
  },
});
