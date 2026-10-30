export type ModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "xai"
  | "alibaba"
  | "meta"
  | "mistral"
  | "moonshot"
  | "zhipu"
  | "minimax"
  | "other";
export type ModelPickerCategory = "favorites" | ModelProvider;

export const MODEL_FAVORITES_STORAGE_KEY = "miniq.model-picker.favorites.v1";

export interface ModelPickerGroup {
  category: ModelPickerCategory;
  label: string;
  models: string[];
}

type ModelFavoritesStorage = Pick<Storage, "getItem" | "setItem">;

const PROVIDERS: Array<{
  category: ModelProvider;
  label: string;
  namespaces: string[];
  families: RegExp;
}> = [
  { category: "openai", label: "OpenAI", namespaces: ["openai"], families: /^(?:gpt|chatgpt|o[134])(?:[-_.\d]|$)/ },
  { category: "anthropic", label: "Anthropic", namespaces: ["anthropic"], families: /^claude(?:[-_.\d]|$)/ },
  { category: "google", label: "Google Gemini", namespaces: ["google", "google-vertex"], families: /^(?:gemini|gemma)(?:[-_.\d]|$)/ },
  { category: "deepseek", label: "DeepSeek", namespaces: ["deepseek", "deepseek-ai"], families: /^deepseek(?:[-_.\d]|$)/ },
  { category: "xai", label: "xAI", namespaces: ["xai", "x-ai"], families: /^grok(?:[-_.\d]|$)/ },
  { category: "alibaba", label: "阿里云", namespaces: ["alibaba", "alibaba-cloud", "qwen"], families: /^(?:qwen|qwq)(?:[-_.\d]|$)/ },
  { category: "meta", label: "Meta", namespaces: ["meta", "meta-llama"], families: /^llama(?:[-_.\d]|$)/ },
  { category: "mistral", label: "Mistral AI", namespaces: ["mistral", "mistralai"], families: /^(?:mistral|mixtral|codestral|ministral)(?:[-_.\d]|$)/ },
  { category: "moonshot", label: "月之暗面", namespaces: ["moonshot", "moonshotai"], families: /^(?:kimi|moonshot)(?:[-_.\d]|$)/ },
  { category: "zhipu", label: "智谱 AI", namespaces: ["zhipu", "zhipuai"], families: /^(?:glm|codegeex)(?:[-_.\d]|$)/ },
  { category: "minimax", label: "MiniMax", namespaces: ["minimax"], families: /^minimax(?:[-_.\d]|$)/ },
];

export function modelProvider(model: string): ModelProvider {
  const normalized = model.trim().toLocaleLowerCase();
  const separator = normalized.indexOf("/");
  const namespace = separator < 0 ? "" : normalized.slice(0, separator);
  const family = separator < 0 ? normalized : normalized.slice(separator + 1);
  return PROVIDERS.find((provider) =>
    provider.namespaces.includes(namespace) || provider.families.test(family)
  )?.category ?? "other";
}

export function groupModelIds(models: string[]): ModelPickerGroup[] {
  const grouped = new Map<ModelProvider, string[]>();
  for (const model of models) {
    const provider = modelProvider(model);
    grouped.set(provider, [...(grouped.get(provider) ?? []), model]);
  }
  return [
    ...PROVIDERS.map(({ category, label }) => ({
      category,
      label,
      models: grouped.get(category) ?? [],
    })),
    { category: "other" as const, label: "其他", models: grouped.get("other") ?? [] },
  ].filter((group) => group.models.length > 0);
}

export function readFavoriteModelIds(storage: ModelFavoritesStorage): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(MODEL_FAVORITES_STORAGE_KEY) ?? "[]");
    return Array.isArray(value) && value.every((model): model is string => typeof model === "string")
      ? value
      : [];
  } catch {
    return [];
  }
}

export function writeFavoriteModelIds(storage: ModelFavoritesStorage, models: string[]): void {
  storage.setItem(MODEL_FAVORITES_STORAGE_KEY, JSON.stringify(models));
}