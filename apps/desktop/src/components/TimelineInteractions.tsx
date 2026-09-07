import { FileText, FolderOpen, X, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import type { Artifact, Question, QueuedMessage } from "../types";
import type { PendingApproval } from "../App";
import { resolveWorkspacePath, revealLocalFile, type LocalFileTarget } from "../localFiles";

export function ApprovalCard({
  item,
  onResolve,
}: {
  item: PendingApproval;
  onResolve: (approvalId: string, decision: string) => void;
}) {
  return (
    <div className="card approval-card">
      <div className="card-head">
        <span>需要审批</span>
        <span className="tool-name">{item.toolName}</span>
        <span className={`badge ${item.approval.riskLevel}`}>
          {item.approval.riskLevel}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>{item.approval.reason}</div>
      <pre>{JSON.stringify(item.input, null, 2)}</pre>
      <div className="approval-actions">
        <button onClick={() => onResolve(item.approval.id, "approve")}>允许一次</button>
        <button
          className="secondary"
          onClick={() => onResolve(item.approval.id, "approve_for_session")}
        >
          本会话允许
        </button>
        <button className="danger" onClick={() => onResolve(item.approval.id, "reject")}>
          拒绝
        </button>
      </div>
    </div>
  );
}

export function QuestionCard({
  question,
  onResolve,
}: {
  question: Question;
  onResolve: (questionId: string, answer: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);
  useEffect(() => {
    if (!question.autoContinueAfterSeconds) {
      setRemainingSeconds(null);
      return;
    }
    const deadline =
      new Date(question.createdAt).getTime() + question.autoContinueAfterSeconds * 1_000;
    const update = () =>
      setRemainingSeconds(Math.max(0, Math.ceil((deadline - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [question.autoContinueAfterSeconds, question.createdAt]);

  useEffect(() => {
    setCustom("");
    setSelected([]);
  }, [question.id]);

  const countdown =
    remainingSeconds === null
      ? null
      : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  return (
    <div className="card approval-card">
      <div className="card-head">
        <span>{question.header || "miniQ 想确认"}</span>
      </div>
      <div style={{ marginTop: 6 }}>{question.prompt}</div>
      {countdown && (
        <div className="question-timeout">
          完全访问模式: {countdown} 后将采用
          {question.defaultAnswer ? `“${question.defaultAnswer}”` : "默认方案"}继续
        </div>
      )}
      <div className="approval-actions" style={{ flexWrap: "wrap" }}>
        {question.options.map((opt) => {
          const active = selected.includes(opt);
          return (
            <button
              key={opt}
              className={active ? "question-option-selected" : undefined}
              aria-pressed={question.multiSelect ? active : undefined}
              title={question.optionDescriptions?.[opt]}
              onClick={() => {
                if (!question.multiSelect) {
                  onResolve(question.id, opt);
                  return;
                }
                setSelected((current) =>
                  current.includes(opt)
                    ? current.filter((value) => value !== opt)
                    : [...current, opt],
                );
              }}
            >
              <span>{opt}</span>
              {question.optionDescriptions?.[opt] && (
                <small>{question.optionDescriptions[opt]}</small>
              )}
            </button>
          );
        })}
        {question.multiSelect && (
          <button
            className="secondary"
            disabled={selected.length === 0}
            onClick={() => onResolve(question.id, selected.join(", "))}
          >
            确认选择
          </button>
        )}
      </div>
      <div className="approval-actions">
        <input
          className="question-input"
          value={custom}
          placeholder="或者输入你的回答..."
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229 && custom.trim()) {
              onResolve(question.id, custom.trim());
            }
          }}
        />
        <button
          className="secondary"
          disabled={!custom.trim()}
          onClick={() => onResolve(question.id, custom.trim())}
        >
          回答
        </button>
      </div>
    </div>
  );
}

export function QueueBar(props: {
  queue: QueuedMessage[];
  onSteer: (queuedMessageId: string) => void;
  onRemove: (queuedMessageId: string) => void;
}) {
  if (props.queue.length === 0) return null;
  return (
    <div className="queue-bar">
      <div className="queue-title">已排队 {props.queue.length} 条，当前任务结束后依次执行</div>
      {props.queue.map((item) => (
        <div key={item.id} className="queue-item">
          <span className="queue-content" title={item.content}>
            {item.content}
          </span>
          <button
            className="ghost queue-steer"
            title="调整方向：打断当前任务，立即执行这条消息"
            onClick={() => props.onSteer(item.id)}
          >
            <Zap size={13} /> 调整方向
          </button>
          <button
            className="ghost queue-remove"
            title="从队列移除"
            onClick={() => props.onRemove(item.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function ArtifactsBar(props: {
  workspacePaths?: readonly string[];
  artifacts: Artifact[];
  workspacePath?: string | null;
  onOpenFile: (target: LocalFileTarget) => void;
  onError: (message: string) => void;
}) {
  const { artifacts, workspacePath, onOpenFile, onError } = props;
  if (artifacts.length === 0) return null;
  return (
    <div className="artifacts-bar">
      <div className="plan-progress">交付产物</div>
      {artifacts.map((artifact) => {
        const path = resolveWorkspacePath(artifact.path, workspacePath);
        return (
          <div key={artifact.id} className="artifact-item" title={path ?? artifact.path}>
            <FileText size={18} aria-hidden="true" />
            <button
              type="button"
              className="artifact-open"
              disabled={!path}
              onClick={() => {
                if (path) onOpenFile({ path, line: null, column: null });
              }}
            >
              <span className="artifact-title">{artifact.title}</span>
              <span className="sub">{artifact.path}</span>
            </button>
            <span className="badge">{artifact.kind}</span>
            <button
              type="button"
              className="icon-button"
              aria-label={`在文件夹中显示 ${artifact.title}`}
              title="在文件夹中显示"
              disabled={!path}
              onClick={() => {
                if (path) void revealLocalFile(path, workspacePath, props.workspacePaths).catch((cause) => {
                  onError(`无法在文件夹中显示：${cause instanceof Error ? cause.message : String(cause)}`);
                });
              }}
            >
              <FolderOpen size={16} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
