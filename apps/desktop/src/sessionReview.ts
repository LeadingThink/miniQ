/** Public, bounded review report. Hidden model reasoning is never part of this contract. */
export interface ReviewRun {
  id: string;
  sessionId: string;
  primaryMessageId: string;
  model: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";
  verdict: null | "no_material_issue_found" | "issues_found" | "insufficient_evidence";
  findings: {
    severity: "suggestion" | "important" | "critical";
    claim: string;
    evidenceIds: string[];
    recommendation: string;
  }[];
  limitations: string[];
  evidence: { id: string; kind: string; title: string; text: string }[];
  error: null | string;
  inputTokens: null | number;
  outputTokens: null | number;
  createdAt: string;
  completedAt: null | string;
}
