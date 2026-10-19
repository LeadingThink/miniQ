import { createContext, useContext } from "react";
import { compareTimestamps } from "./timelineModel";
import type { HistoryCursor, HistoryPage, ProcessSummary } from "./types";

/** Key of a turn's folded work: the opening user message, or "" for rows before the first one. */
export const processKey = (turnId?: string | null): string => turnId ?? "";

/** How much of one folded turn is in the conversation: records arrive newest first. */
export interface ProcessLoad {
  loaded: number;
  /** Where the next, older page starts; null once the whole turn is loaded. */
  cursor: HistoryCursor | null;
  complete: boolean;
}

export type ProcessLoadResult = void | { error: unknown };

export interface ProcessRecordsContextValue {
  summaries: Record<string, ProcessSummary>;
  loads: Record<string, ProcessLoad>;
  /** Load the next page of a folded turn. Resolves to `{ error }` on failure. */
  load: (turnId: string | null) => Promise<ProcessLoadResult>;
}

/** Absent when records arrive with the conversation (search results, previews). */
export const ProcessRecordsContext = createContext<ProcessRecordsContextValue | null>(null);

export function useProcessRecords() {
  return useContext(ProcessRecordsContext);
}

/** A fold whose records stay on the daemon until it is opened. */
export interface FoldRecords {
  /** Records the daemon holds for the fold. */
  total: number;
  /** Records received so far; newest arrive first. */
  loaded: number;
  complete: boolean;
  load: () => Promise<ProcessLoadResult>;
}

export function foldRecords(
  stats: ProcessSummary,
  load: ProcessLoad | undefined,
  loadPage: () => Promise<ProcessLoadResult>,
): FoldRecords {
  return { total: stats.recordCount, loaded: load?.loaded ?? 0, complete: load?.complete ?? false, load: loadPage };
}

export function summariesByKey(summaries: readonly ProcessSummary[] | undefined): Record<string, ProcessSummary> {
  return Object.fromEntries((summaries ?? []).map((summary) => [processKey(summary.turnId), summary]));
}

export function withProcessPage(
  loads: Record<string, ProcessLoad>,
  key: string,
  page: HistoryPage,
): Record<string, ProcessLoad> {
  const previous = loads[key];
  return {
    ...loads,
    [key]: {
      loaded: (previous?.loaded ?? 0) + page.messages.length + page.toolCalls.length,
      cursor: page.nextCursor,
      complete: page.nextCursor === null,
    },
  };
}

/** Remove the keys, returning the same object when none is present. */
export function withoutKeys<T>(record: Record<string, T>, keys: Iterable<string>): Record<string, T> {
  const present = [...keys].filter((key) => key in record);
  if (!present.length) return record;
  const next = { ...record };
  for (const key of present) delete next[key];
  return next;
}

/** Merge records of one folded turn into a chronological list, newest copy winning. */
export function mergeByTime<T extends { id: string; createdAt: string }>(current: T[], incoming: T[]): T[] {
  const records = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) records.set(record.id, record);
  return [...records.values()].sort((a, b) => compareTimestamps(a.createdAt, b.createdAt));
}

/** Tool calls that failed, were rejected or cancelled. */
export function failedCount(summary: ProcessSummary): number {
  const { failed = 0, rejected = 0, cancelled = 0 } = summary.statusCounts;
  return failed + rejected + cancelled;
}
