import { useEffect, useRef, useState } from "react";
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

type DistillPhase = "loading" | "skipped" | "draft" | "saved";

interface DistillSnapshot {
  phase: DistillPhase;
  reason: string;
  draft: string;
  name: string;
  warnings: string[];
  existing: boolean;
  error: string | null;
  listeners: Set<() => void>;
  initialRequest?: Promise<void>;
  operation?: Promise<void>;
}

const snapshots = new WeakMap<RpcClient, Map<string, DistillSnapshot>>();

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
  };
  sessions.set(sessionId, created);
  return created;
}

interface DistillModalProps {
  client: RpcClient;
  sessionId: string;
  onClose: () => void;
}

function PhaseMessage(props: { phase: DistillPhase; reason: string }) {
  if (props.phase === "loading") {
    return <div className="settings-status">正在从本会话提炼技能…</div>;
  }
  if (props.phase === "skipped") {
    return <div className="settings-status">未保存：{props.reason}</div>;
  }
  if (props.phase === "saved") {
    return (
      <div className="settings-status">技能已保存，新对话即可使用。</div>
    );
  }
  return null;
}

function DistillDraft(props: {
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
          <button className="secondary" onClick={props.onRefine} style={{ marginLeft: 8 }}>
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
        value={props.draft}
        onChange={(event) => props.onDraftChange(event.target.value)}
      />
      <div className="approval-actions">
        <button onClick={() => props.onSave(hasWarnings)}>
          {hasWarnings ? "仍然保存" : "保存技能"}
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
  const [snapshot, setSnapshot] = useState(() => ({ ...cache }));

  const update = (changes: Partial<DistillSnapshot>) => {
    Object.assign(cache, changes);
    setSnapshot({ ...cache });
    for (const listener of cache.listeners) listener();
  };

  useEffect(() => {
    const listener = () => setSnapshot({ ...cache });
    cache.listeners.add(listener);
    return () => { cache.listeners.delete(listener); };
  }, [cache]);

  useEffect(() => {
    if (cache.phase !== "loading" || cache.initialRequest) return;
    cache.initialRequest = props.client
      .call<DistillResult>("skill.distill", { sessionId: props.sessionId })
      .then((result) => {
        if (result.skipped) {
          update({ reason: result.reason ?? "", phase: "skipped" });
        } else {
          update({
            draft: result.content ?? "",
            name: result.name ?? "",
            warnings: result.warnings ?? [],
            existing: result.existingSkill ?? false,
            phase: "draft",
          });
        }
      })
      .catch((caught) => update({ error: errorMessage(caught), phase: "draft" }))
      .finally(() => { delete cache.initialRequest; });
    // The cache intentionally outlives this panel so a closed panel can be reopened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, props.client, props.sessionId]);

  const refine = async () => {
    if (cache.operation) return cache.operation;
    update({ phase: "loading", error: null });
    cache.operation = props.client.call<{
        kept: boolean;
        content?: string;
        warnings?: string[];
      }>("skill.refine", { sessionId: props.sessionId, name: cache.name })
      .then((result) => {
        if (result.kept) update({ reason: "现有技能已覆盖本次经验,无需更新。", phase: "skipped" });
        else update({ draft: result.content ?? "", warnings: result.warnings ?? [], existing: false, phase: "draft" });
      })
      .catch((caught) => update({ error: errorMessage(caught), phase: "draft" }))
      .finally(() => { delete cache.operation; });
    return cache.operation;
  };

  const save = async (force: boolean) => {
    if (cache.operation) return cache.operation;
    update({ error: null });
    cache.operation = props.client
      .call("skill.save", { content: cache.draft, force })
      .then(() => update({ phase: "saved" }))
      .catch((caught) => update({ error: errorMessage(caught) }))
      .finally(() => { delete cache.operation; });
    return cache.operation;
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div
        ref={panelRef}
        className="settings-panel skills-panel"
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
        <h2>保存为技能</h2>
        {snapshot.error && <div className="error-banner">{snapshot.error}</div>}
        <PhaseMessage phase={snapshot.phase} reason={snapshot.reason} />
        {snapshot.phase === "draft" && (
          <DistillDraft
            name={snapshot.name}
            existing={snapshot.existing}
            warnings={snapshot.warnings}
            draft={snapshot.draft}
            onRefine={() => void refine()}
            onDraftChange={(value) => update({ draft: value })}
            onSave={(force) => void save(force)}
            onClose={props.onClose}
          />
        )}
        {(snapshot.phase === "skipped" || snapshot.phase === "saved") && <CloseActions onClose={props.onClose} />}
      </div>
    </div>
  );
}
