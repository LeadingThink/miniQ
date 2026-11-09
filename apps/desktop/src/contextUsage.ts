/** Base history estimate returned by the daemon, not provider billing usage. */
export interface ContextUsage {
  estimatedTokens: number;
  contextWindowTokens: number | null;
  autoCompactTokens: number;
  percentUsed: number | null;
  lastRequestTokens: number | null;
}

export function formatContextTokens(tokens: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(tokens);
}