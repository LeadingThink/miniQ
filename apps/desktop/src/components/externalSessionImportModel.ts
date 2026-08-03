import type {
  ExternalProvider,
  ExternalSessionSummary,
} from "../types";

export const EXTERNAL_PROVIDERS: ExternalProvider[] = [
  "codex",
  "claude_code",
  "opencode",
];

export const PROVIDER_LABELS: Record<ExternalProvider, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  opencode: "OpenCode",
};

export const PROVIDER_MARKS: Record<ExternalProvider, string> = {
  codex: "CX",
  claude_code: "CC",
  opencode: "OC",
};

export function externalSessionKey(
  session: Pick<ExternalSessionSummary, "provider" | "externalId">,
): string {
  return `${session.provider}\u0000${session.externalId}`;
}

export function filterExternalSessions(
  sessions: ExternalSessionSummary[],
  providers: Set<ExternalProvider>,
  search: string,
): ExternalSessionSummary[] {
  const query = search.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (!providers.has(session.provider)) return false;
    if (!query) return true;
    return [
      session.title,
      session.cwd ?? "",
      session.externalId,
      PROVIDER_LABELS[session.provider],
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

export function toggleSelectedKeys(
  current: Set<string>,
  keys: string[],
  selected: boolean,
): Set<string> {
  const next = new Set(current);
  for (const key of keys) {
    if (selected) next.add(key);
    else next.delete(key);
  }
  return next;
}
