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
  const [phase, setPhase] = useState<DistillPhase>("loading");
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [existing, setExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    props.client
      .call<DistillResult>("skill.distill", { sessionId: props.sessionId })
      .then((result) => {
        if (result.skipped) {
          setReason(result.reason ?? "");
          setPhase("skipped");
        } else {
          setDraft(result.content ?? "");
          setName(result.name ?? "");
          setWarnings(result.warnings ?? []);
          setExisting(result.existingSkill ?? false);
          setPhase("draft");
        }
      })
      .catch((caught) => setError(errorMessage(caught)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refine = async () => {
    setPhase("loading");
    setError(null);
    try {
      const result = await props.client.call<{
        kept: boolean;
        content?: string;
        warnings?: string[];
      }>("skill.refine", { sessionId: props.sessionId, name });
      if (result.kept) {
        setReason("现有技能已覆盖本次经验,无需更新。");
        setPhase("skipped");
      } else {
        setDraft(result.content ?? "");
        setWarnings(result.warnings ?? []);
        setExisting(false);
        setPhase("draft");
      }
    } catch (caught) {
      setError(errorMessage(caught));
      setPhase("draft");
    }
  };

  const save = async (force: boolean) => {
    setError(null);
    try {
      await props.client.call("skill.save", { content: draft, force });
      setPhase("saved");
    } catch (caught) {
      setError(errorMessage(caught));
    }
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
        {error && <div className="error-banner">{error}</div>}
        <PhaseMessage phase={phase} reason={reason} />
        {phase === "draft" && (
          <DistillDraft
            name={name}
            existing={existing}
            warnings={warnings}
            draft={draft}
            onRefine={() => void refine()}
            onDraftChange={setDraft}
            onSave={(force) => void save(force)}
            onClose={props.onClose}
          />
        )}
        {(phase === "skipped" || phase === "saved") && <CloseActions onClose={props.onClose} />}
      </div>
    </div>
  );
}
