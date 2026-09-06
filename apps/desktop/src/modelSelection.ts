export type ApiProtocol =
  | "auto"
  | "responses"
  | "chat_completions"
  | "anthropic_messages";
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";
export interface SessionModelSettings {
  model: string | null;
  apiProtocol: ApiProtocol;
  reasoningEffort: ReasoningEffort | null;
}
export interface SessionModelResult {
  settings: SessionModelSettings;
  effective: {
    model: string;
    apiProtocol: ApiProtocol;
    reasoningEffort: ReasoningEffort | null;
  } | null;
}
export interface ModelDescription {
  model: string;
  apiProtocol: ApiProtocol;
  reasoningEfforts: ReasoningEffort[];
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
}
export const DEFAULT_MODEL_SETTINGS: SessionModelSettings = {
  model: null,
  apiProtocol: "auto",
  reasoningEffort: null,
};
export const PROTOCOL_LABELS: Record<ApiProtocol, string> = {
  auto: "自动协议",
  responses: "Responses",
  chat_completions: "Chat Completions",
  anthropic_messages: "Anthropic Messages",
};
export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: "无推理",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "很高",
  max: "最大",
  ultra: "Ultra",
};
export function filterModelIds(models: string[], query: string): string[] {
  return models.filter((model) =>
    model.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
}
