import type { ToolCall } from "../types";
import { isAutomationCall } from "./automationActivity";

/** Tool families whose adjacent calls collapse into one summary line. */
export type ToolKind = "read" | "edit" | "shell" | "webSearch" | "webFetch" | "codeSearch" | "list";

const KIND_OF: Record<string, ToolKind> = {
  file_read: "read",
  doc_read: "read",
  file_edit: "edit",
  file_patch: "edit",
  file_write: "edit",
  apply_patch: "edit",
  notebook_edit: "edit",
  shell_run: "shell",
  shell_batch: "shell",
  web_search: "webSearch",
  web_fetch: "webFetch",
  file_grep: "codeSearch",
  file_glob: "codeSearch",
  file_list: "list",
};

const KIND_TEXT: Record<ToolKind, (count: number) => string> = {
  read: (count) => `读取了 ${count} 个文件`,
  edit: (count) => `编辑了 ${count} 个文件`,
  shell: (count) => `运行了 ${count} 条命令`,
  webSearch: (count) => `搜索了 ${count} 次网页`,
  webFetch: (count) => `读取了 ${count} 个网页`,
  codeSearch: (count) => `搜索了 ${count} 次代码`,
  list: (count) => `查看了 ${count} 个目录`,
};

/** Short verbs used when the step line also shows its target. */
const STEP_VERBS: Record<string, [running: string, finished: string]> = {
  file_read: ["正在读取", "读取了"],
  doc_read: ["正在读取", "读取了"],
  file_edit: ["正在编辑", "编辑了"],
  file_patch: ["正在编辑", "编辑了"],
  apply_patch: ["正在编辑", "编辑了"],
  notebook_edit: ["正在编辑", "编辑了"],
  file_write: ["正在写入", "写入了"],
  shell_run: ["正在运行", "运行了"],
  shell_batch: ["正在运行", "运行了"],
  web_search: ["正在搜索", "搜索了"],
  web_fetch: ["正在读取", "读取了"],
  file_grep: ["正在搜索", "搜索了"],
  file_glob: ["正在查找", "查找了"],
  file_list: ["正在查看", "查看了"],
};

export function toolKind(call: ToolCall): ToolKind | null {
  return isAutomationCall(call) ? null : (KIND_OF[call.toolName] ?? null);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Files named in an apply_patch call. */
export function patchPaths(input: unknown): string[] {
  const value = record(input);
  const operation = record(value.operation);
  if (typeof operation.path === "string") return [operation.path];
  if (typeof value.patch !== "string") return [];
  return [...value.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
}

export function shellCommands(call: ToolCall): string[] {
  const input = record(call.input);
  if (typeof input.command === "string") return [input.command];
  return strings(input.commands);
}

/** The things a call acts on: paths, commands, queries or URLs. */
export function toolTargets(call: ToolCall): string[] {
  const input = record(call.input);
  if (call.toolName === "apply_patch") return patchPaths(call.input);
  if (toolKind(call) === "shell") return shellCommands(call);
  for (const key of ["path", "notebook_path", "url", "query", "pattern"]) {
    if (typeof input[key] === "string") return [input[key]];
  }
  return [];
}

/** The verb and target of one step line, e.g. ["正在运行", "npm test"]. */
export function toolStepTitle(call: ToolCall, running: boolean): { verb: string; target: string } | null {
  const verbs = STEP_VERBS[call.toolName];
  const targets = toolTargets(call);
  if (!verbs || isAutomationCall(call) || targets.length === 0) return null;
  const target = targets.length === 1 ? targets[0] : `${targets[0]} 等 ${targets.length} 项`;
  return { verb: running ? verbs[0] : verbs[1], target };
}

export interface ToolRun {
  kind: ToolKind | null;
  calls: ToolCall[];
}

/** Split calls into runs of adjacent same-kind calls; other calls stand alone. */
export function toolRuns(calls: ToolCall[]): ToolRun[] {
  const runs: ToolRun[] = [];
  for (const call of calls) {
    const kind = toolKind(call);
    const previous = runs.at(-1);
    if (kind && previous?.kind === kind) previous.calls.push(call);
    else runs.push({ kind, calls: [call] });
  }
  return runs;
}

function runCount(run: ToolRun): number {
  if (run.kind === "read" || run.kind === "edit" || run.kind === "list") {
    const paths = new Set<string>();
    let unnamed = 0;
    for (const call of run.calls) {
      const targets = toolTargets(call);
      if (targets.length === 0) unnamed++;
      for (const target of targets) paths.add(target);
    }
    return paths.size + unnamed;
  }
  if (run.kind === "shell") {
    return run.calls.reduce((total, call) => total + Math.max(1, shellCommands(call).length), 0);
  }
  return run.calls.length;
}

/** One natural-language line for a merged run, e.g. "读取了 5 个文件". */
export function toolRunSummary(run: ToolRun): string {
  if (!run.kind) return "";
  return KIND_TEXT[run.kind](runCount(run));
}

export function isActiveCall(call: ToolCall): boolean {
  return call.status === "running" || call.status === "waiting_approval" || call.status === "pending";
}
