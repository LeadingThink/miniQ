import { useEffect, useRef, useState } from "react";
import "./Distill.css";
import { useFocusTrap } from "./ui/useFocusTrap";
import { errorMessage } from "../errorMessage";
import type { RpcClient } from "../rpc";

interface DistillResult {
  skipped: boolean;
  reason?: string;
  content?: string;
  name?: string;
  description?: string;
  warnings?: string[];
  existingSkill?: boolean;
}

interface SkillJob {
  id: string;
  state: "running" | "completed" | "failed" | "cancelled";
  result?: DistillResult & { kept?: boolean };
  error?: string;
}

type DistillPhase = "loading" | "skipped" | "draft" | "saved" | "error" | "timeout";
interface SaveResult { name?: string; path?: string; version?: string | number }
interface DistillSnapshot {
  phase: DistillPhase;
  reason: string;
  draft: string;
  name: string;
  warnings: string[];
  existing: boolean;
  error: string | null;
  listeners: Set<() => void>;
  started?: boolean;
  busy?: boolean;
  saving?: boolean;
  saveUncertain?: boolean;
  cancelling?: boolean;
  startedAt?: number;
  jobId?: string;
  kind?: "distill" | "refine";
  generation: number;
  controller?: AbortController;
  saved?: SaveResult;
}

const snapshots = new WeakMap<RpcClient, Map<string, DistillSnapshot>>();
const POLL_DEADLINE_MS = 180_000;
class JobTimeout extends Error {}
class JobFailed extends Error {}

// Race every RPC against the overall deadline, including transports that never settle.
function bounded<T>(promise: Promise<T>, deadline: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(() => reject(new Error("任务已停止等待")));
    const timer = window.setTimeout(() => finish(() => reject(new JobTimeout("等待已超时；任务可能仍在后台运行，请检查状态或取消任务。"))), Math.max(0, deadline - Date.now()));
    function finish(action: () => void) {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      action();
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
  });
}

function update(cache: DistillSnapshot, changes: Partial<DistillSnapshot>) {
  Object.assign(cache, changes);
  for (const listener of cache.listeners) listener();
}

async function runJob(cache: DistillSnapshot, client: RpcClient, sessionId: string, kind: "distill" | "refine", resume = false) {
  if (cache.busy || cache.saving || cache.cancelling) return;
  const generation = ++cache.generation;
  const controller = new AbortController();
  const deadline = Date.now() + POLL_DEADLINE_MS;
  update(cache, { started: true, busy: true, phase: "loading", error: null, kind, controller, startedAt: resume ? cache.startedAt : Date.now() });
  try {
    if (!resume) {
      update(cache, { jobId: undefined });
      const starting = client.call<SkillJob>("skill.job.start", { kind, ...(kind === "refine" ? { name: cache.name } : {}), sessionId });
      // Even a late start response must remain recoverable without creating another paid job.
      starting.then(job => { if (cache.generation === generation) update(cache, { jobId: job.id }); }, () => {});
      await bounded(starting, deadline, controller.signal);
    }
    while (cache.generation === generation) {
      const job = await bounded(client.call<SkillJob>("skill.job.get", { jobId: cache.jobId, sessionId }), deadline, controller.signal);
      if (cache.generation !== generation) return;
      if (job.state === "completed") {
        const result = job.result;
        if (!result) throw new JobFailed("任务未返回技能草稿，请重试。");
        if (result.skipped || result.kept) update(cache, { phase: "skipped", reason: result.reason ?? "现有技能已覆盖本次经验，无需更新。" });
        else update(cache, { phase: "draft", draft: result.content ?? "", name: result.name ?? cache.name, warnings: result.warnings ?? [], existing: result.existingSkill ?? false });
        return;
      }
      if (job.state === "failed" || job.state === "cancelled") throw new JobFailed(job.error ?? "技能草稿任务已取消");
      await bounded(new Promise<void>(resolve => window.setTimeout(resolve, 1000)), deadline, controller.signal);
    }
  } catch (caught) {
    if (cache.generation === generation) {
      const message = errorMessage(caught);
      const uncertain = caught instanceof JobTimeout || (!(caught instanceof JobFailed) && (Boolean(cache.jobId) || !/\(code -?\d+\)$/.test(message)));
      update(cache, { phase: uncertain ? "timeout" : "error", error: uncertain ? `${message}（任务状态未确认，请检查状态或取消任务。）` : message });
    }
  } finally {
    if (cache.generation === generation) update(cache, { busy: false });
  }
}

function snapshotFor(client: RpcClient, sessionId: string): DistillSnapshot {
  let sessions = snapshots.get(client);
  if (!sessions) {
    sessions = new Map();
    snapshots.set(client, sessions);
  }
  const current = sessions.get(sessionId);
  if (current) return current;
  const created: DistillSnapshot = {
    phase: "loading",
    reason: "",
    draft: "",
    name: "",
    warnings: [],
    existing: false,
    error: null,
    listeners: new Set(),
    generation: 0,
  };
  sessions.set(sessionId, created);
  return created;
}

interface DistillModalProps {
  client: RpcClient;
  sessionId: string;
  onClose: () => void;
}

function DistillDraft(props: {
  saving: boolean;
  saveUncertain: boolean;
  name: string;
  existing: boolean;
  warnings: string[];
  draft: string;
  onRefine: () => void;
  onDraftChange: (draft: string) => void;
  onSave: (force: boolean) => void;
  onClose: () => void;
}) {
  const hasWarnings = props.warnings.length > 0;
  return (
    <>
      <div className="card-head">
        <span className="tool-name">{props.name}</span>
        {props.existing && <span className="badge medium">已存在同名技能</span>}
      </div>
      {props.existing && (
        <div className="settings-status">
          已存在同名技能 —
          <button className="secondary" disabled={props.saving || props.saveUncertain} onClick={props.onRefine} style={{ marginLeft: 8 }}>
            改为更新已有技能
          </button>
        </div>
      )}
      {hasWarnings && (
        <div className="error-banner">
          疑似敏感内容：{props.warnings.join("；")}，请先修改再保存。
        </div>
      )}
      <textarea
        className="distill-editor"
        aria-label="技能草稿"
        disabled={props.saving || props.saveUncertain}
        value={props.draft}
        onChange={(event) => props.onDraftChange(event.target.value)}
      />
      <div className="approval-actions">
        <button disabled={props.saving || props.saveUncertain} onClick={() => props.onSave(hasWarnings)}>
          {props.saveUncertain ? "保存结果待确认" : props.saving ? "正在保存…" : hasWarnings ? "仍然保存" : "保存技能"}
        </button>
        <button className="secondary" onClick={props.onClose}>
          取消
        </button>
      </div>
    </>
  );
}

function CloseActions(props: { onClose: () => void }) {
  return (
    <div className="approval-actions">
      <button className="secondary" onClick={props.onClose}>
        关闭
      </button>
    </div>
  );
}

export function DistillModal(props: DistillModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);
  const cache = snapshotFor(props.client, props.sessionId);
  const [, render] = useState(0);
  const snapshot = cache;

  useEffect(() => {
    const listener = () => render(value => value + 1);
    cache.listeners.add(listener);
    if (!cache.started) void runJob(cache, props.client, props.sessionId, "distill");
    return () => { cache.listeners.delete(listener); };
  }, [cache, props.client, props.sessionId]);

  useEffect(() => {
    if (snapshot.phase !== "loading") return;
    const timer = window.setInterval(() => render(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [cache, snapshot.phase]);

  const cancel = async () => {
    if (!cache.jobId || cache.cancelling) return;
    ++cache.generation;
    cache.controller?.abort();
    update(cache, { busy: false, cancelling: true });
    try {
      await bounded(props.client.call("skill.job.cancel", { sessionId: props.sessionId, jobId: cache.jobId }), Date.now() + POLL_DEADLINE_MS, new AbortController().signal);
      update(cache, { phase: "error", error: "任务已取消，可以重试。" });
    } catch (caught) {
      update(cache, { phase: "timeout", error: `取消未确认：${errorMessage(caught)}` });
    } finally {
      update(cache, { cancelling: false });
    }
  };

  const save = async (force: boolean) => {
    if (cache.saving || cache.saveUncertain || cache.busy || cache.phase !== "draft") return;
    update(cache, { error: null, saving: true });
    try {
      const saving = props.client.call<SaveResult>("skill.save", { content: cache.draft, force });
      // Preserve a late successful response without issuing another write.
      saving.then(saved => update(cache, { phase: "saved", saved, error: null, saveUncertain: false }), () => {});
      await bounded(saving, Date.now() + POLL_DEADLINE_MS, new AbortController().signal);
    } catch (caught) {
      const message = errorMessage(caught);
      const uncertain = !/\(code -?\d+\)$/.test(message);
      update(cache, { saveUncertain: uncertain, error: uncertain ? `${message}（保存结果未确认，可能已经写入；请先检查执行主机用户技能目录，避免重复保存。）` : message });
    } finally {
      update(cache, { saving: false });
    }
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div
        ref={panelRef}
        className="settings-panel skills-panel distill-panel"
        data-phase={snapshot.phase}
        role="dialog"
        aria-modal="true"
        aria-label="保存为技能"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            props.onClose();
          }
        }}
      >
        <h2 style={{ fontSize: 18, margin: "0 0 12px" }}>保存为技能</h2>
        <p className="settings-status" style={{ fontSize: 13, margin: "0 0 12px" }}>
          先生成草稿，确认后才写入执行主机用户技能目录。关闭不取消后台任务。
        </p>
        {snapshot.error && <div className="error-banner" role="alert">{snapshot.error}</div>}
        {snapshot.phase === "loading" && (
          <div role="status" className="settings-status" style={{ fontSize: 13 }}>
            <span>{snapshot.kind === "refine" ? "正在更新已有技能…" : "正在从本会话提炼技能…"}</span>
            <span style={{ marginLeft: 8 }}>已等待 {Math.max(0, Math.floor((Date.now() - (snapshot.startedAt ?? Date.now())) / 1000))} 秒</span>
          </div>
        )}
        {snapshot.phase === "timeout" && !snapshot.jobId && <div className="settings-status">尚未收到任务编号，暂时无法检查或取消；请稍后重新打开查看，避免重复生成。</div>}
        {(snapshot.phase === "loading" || snapshot.phase === "timeout") && (
          <div className="approval-actions">
            <button className="secondary" onClick={props.onClose}>后台继续，关闭</button>
            {snapshot.phase === "timeout" && <button disabled={!snapshot.jobId || snapshot.cancelling} onClick={() => void runJob(cache, props.client, props.sessionId, snapshot.kind ?? "distill", true)}>检查状态</button>}
            <button disabled={!snapshot.jobId || snapshot.cancelling} onClick={() => void cancel()}>{snapshot.cancelling ? "正在取消…" : "取消任务"}</button>
          </div>
        )}
        {snapshot.phase === "error" && (
          <div className="approval-actions">
            <button disabled={snapshot.cancelling} onClick={() => void runJob(cache, props.client, props.sessionId, snapshot.kind ?? "distill")}>重试</button>
            {snapshot.draft && <button onClick={() => update(cache, { phase: "draft", error: null })}>返回原草稿</button>}
            <button className="secondary" onClick={props.onClose}>关闭</button>
          </div>
        )}
        {snapshot.phase === "skipped" && <div className="settings-status">未保存：{snapshot.reason}</div>}
        {snapshot.phase === "saved" && <div className="settings-status" role="status">
          <div>技能已保存，新对话即可使用。</div>
          <div>{snapshot.saved?.name ?? snapshot.name}{snapshot.saved?.version != null ? ` · 版本 ${snapshot.saved.version}` : ""}</div>
          <div style={{ overflowWrap: "anywhere" }}>{snapshot.saved?.path ? `保存位置：${snapshot.saved.path}` : "已保存到用户技能目录（服务端未返回完整路径）。"}</div>
        </div>}
        {snapshot.phase === "draft" && (
          <DistillDraft
            saving={snapshot.saving ?? false}
            saveUncertain={snapshot.saveUncertain ?? false}
            name={snapshot.name}
            existing={snapshot.existing}
            warnings={snapshot.warnings}
            draft={snapshot.draft}
            onRefine={() => void runJob(cache, props.client, props.sessionId, "refine")}
            onDraftChange={(value) => update(cache, { draft: value })}
            onSave={(force) => void save(force)}
            onClose={props.onClose}
          />
        )}
        {(snapshot.phase === "skipped" || snapshot.phase === "saved") && <CloseActions onClose={props.onClose} />}
      </div>
    </div>
  );
}
