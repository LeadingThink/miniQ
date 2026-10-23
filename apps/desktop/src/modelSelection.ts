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
export const MODEL_RANKING_URL = "https://platform.zaiwenai.com/ranking";
export const MODEL_RANKING_NOTICE = "模型热度榜仅表示使用热度，不代表质量";
export const MODEL_AVAILABILITY_URL = "https://platform.zaiwenai.com/models";
export const MODEL_AVAILABILITY_NOTICE = "在问平台的模型列表与当前可用状态";
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
