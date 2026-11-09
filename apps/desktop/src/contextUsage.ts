/** Base history estimate returned by the daemon, not provider billing usage. */
export interface ContextUsageCategory {
  id: "system" | "tools" | "conversation" | "connectors" | "skills";
  tokens: number;
}

export interface ContextUsage {
  estimatedTokens: number;
  contextWindowTokens: number | null;
  autoCompactTokens: number;
  percentUsed: number | null;
  /** Local estimate for the most recent request. */
  lastRequestTokens: number | null;
  /** Provider-reported input tokens for the most recent request, if any. */
  lastRequestActualTokens?: number | null;
  /** Estimate split by section; absent when the daemon predates the split. */
  categories?: ContextUsageCategory[] | null;
}

export function formatContextTokens(tokens: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(tokens);
}

/** Panel labels, in display order, keyed by the daemon's category ids. */
export const contextUsageLabels: Record<ContextUsageCategory["id"], string> = {
  system: "系统提示词",
  tools: "工具及子智能体",
  conversation: "对话消息",
  connectors: "连接器及 MCP",
  skills: "技能",
};
