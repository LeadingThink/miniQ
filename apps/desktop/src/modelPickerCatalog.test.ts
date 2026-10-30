import { describe, expect, it } from "vitest";
import { groupModelIds, MODEL_FAVORITES_STORAGE_KEY, readFavoriteModelIds, writeFavoriteModelIds } from "./modelPickerCatalog";

describe("model picker catalog", () => {
  it("groups models by provider while preserving their catalog order", () => {
    expect(groupModelIds([
      "gpt-5.6-sol",
      "anthropic/claude-sonnet-4.6",
      "gemini-3.8-flash",
      "deepseek-chat",
      "grok-4.7",
      "qwen3-max",
      "llama-4-maverick",
      "mistral-large",
      "kimi-k2",
      "glm-4.7",
      "minimax-m3",
      "custom-model",
      "gpt-4o",
    ])).toEqual([
      { category: "openai", label: "OpenAI", models: ["gpt-5.6-sol", "gpt-4o"] },
      { category: "anthropic", label: "Anthropic", models: ["anthropic/claude-sonnet-4.6"] },
      { category: "google", label: "Google Gemini", models: ["gemini-3.8-flash"] },
      { category: "deepseek", label: "DeepSeek", models: ["deepseek-chat"] },
      { category: "xai", label: "xAI", models: ["grok-4.7"] },
      { category: "alibaba", label: "阿里云", models: ["qwen3-max"] },
      { category: "meta", label: "Meta", models: ["llama-4-maverick"] },
      { category: "mistral", label: "Mistral AI", models: ["mistral-large"] },
      { category: "moonshot", label: "月之暗面", models: ["kimi-k2"] },
      { category: "zhipu", label: "智谱 AI", models: ["glm-4.7"] },
      { category: "minimax", label: "MiniMax", models: ["minimax-m3"] },
      { category: "other", label: "其他", models: ["custom-model"] },
    ]);
  });

  it("omits empty groups", () => {
    expect(groupModelIds(["gpt-5.6-sol"])).toEqual([
      { category: "openai", label: "OpenAI", models: ["gpt-5.6-sol"] },
    ]);
  });

  it("round-trips favorite model IDs through storage", () => {
    let value: string | null = null;
    const storage = {
      getItem: () => value,
      setItem: (_key: string, next: string) => { value = next; },
    };
    writeFavoriteModelIds(storage, ["gpt-5.6-sol"]);
    expect(value).toContain("gpt-5.6-sol");
    expect(readFavoriteModelIds(storage)).toEqual(["gpt-5.6-sol"]);
    expect(MODEL_FAVORITES_STORAGE_KEY).toBe("miniq.model-picker.favorites.v1");
  });
});