import { useEffect, useState } from "react";
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

export function DistillModal(props: {
  client: RpcClient;
  sessionId: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<"loading" | "skipped" | "draft" | "saved">(
    "loading",
  );
  const [reason, setReason] = useState("");
  const [draft, setDraft] = useState("");
  const [name, setName] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [existing, setExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    props.client
      .call<DistillResult>("skill.distill", { sessionId: props.sessionId })
      .then((res) => {
        if (res.skipped) {
          setReason(res.reason ?? "");
          setPhase("skipped");
        } else {
          setDraft(res.content ?? "");
          setName(res.name ?? "");
          setWarnings(res.warnings ?? []);
          setExisting(res.existingSkill ?? false);
          setPhase("draft");
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refine = async () => {
    setPhase("loading");
    setError(null);
    try {
      const res = await props.client.call<{
        kept: boolean;
        content?: string;
        warnings?: string[];
      }>("skill.refine", { sessionId: props.sessionId, name });
      if (res.kept) {
        setReason("现有技能已覆盖本次经验,无需更新。");
        setPhase("skipped");
      } else {
        setDraft(res.content ?? "");
        setWarnings(res.warnings ?? []);
        setExisting(false);
        setPhase("draft");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("draft");
    }
  };

  const save = async (force: boolean) => {
    setError(null);
    try {
      await props.client.call("skill.save", { content: draft, force });
      setPhase("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="settings-overlay" onClick={props.onClose}>
      <div
        className="settings-panel skills-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Save as skill</h2>
        {error && <div className="error-banner">{error}</div>}
        {phase === "loading" && (
          <div className="settings-status">Distilling this session into a skill...</div>
        )}
        {phase === "skipped" && (
          <div className="settings-status">Not saved: {reason}</div>
        )}
        {phase === "saved" && (
          <div className="settings-status">Skill saved. It will be available in new turns.</div>
        )}
        {phase === "draft" && (
          <>
            <div className="card-head">
              <span className="tool-name">{name}</span>
              {existing && <span className="badge medium">name exists</span>}
            </div>
            {existing && (
              <div className="settings-status">
                A skill with this name already exists —
                <button className="secondary" onClick={refine} style={{ marginLeft: 8 }}>
                  Update existing skill instead
                </button>
              </div>
            )}
            {warnings.length > 0 && (
              <div className="error-banner">
                Possible sensitive content: {warnings.join("; ")} — edit before saving.
              </div>
            )}
            <textarea
              className="distill-editor"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="approval-actions">
              <button onClick={() => save(warnings.length > 0)}>
                {warnings.length > 0 ? "Save anyway" : "Save skill"}
              </button>
              <button className="secondary" onClick={props.onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
        {(phase === "skipped" || phase === "saved") && (
          <div className="approval-actions">
            <button className="secondary" onClick={props.onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
