import { FileText, FolderOpen, X, Zap } from "lucide-react";
import type { Artifact, QueuedMessage } from "../types";
import type { PendingApproval } from "../App";
import { ToolPayload } from "./ToolPayload";
import {
  resolveWorkspacePath,
  revealLocalFile,
  type LocalFileTarget,
} from "../localFiles";

export function ApprovalCard({
  item,
  onResolve,
  pending = false,
}: {
  item: PendingApproval;
  onResolve: (approvalId: string, decision: string) => void;
  pending?: boolean;
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
      <ToolPayload label="待审批参数" value={item.input} />
      <div className="approval-actions">
        <button
          disabled={pending}
          onClick={() => onResolve(item.approval.id, "approve")}
        >
          允许一次
        </button>
        <button
          className="secondary"
          disabled={pending}
          onClick={() => onResolve(item.approval.id, "approve_for_session")}
        >
          本会话允许
        </button>
        <button
          disabled={pending}
          className="danger"
          onClick={() => onResolve(item.approval.id, "reject")}
        >
          拒绝
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
      <div className="queue-title">
        已排队 {props.queue.length} 条，当前任务结束后依次执行
      </div>
      {props.queue.map((item) => {
        const attachmentNames =
          item.attachments?.map((attachment) => attachment.name) ?? [];
        const summary = item.content || attachmentNames.join("、");
        return (
          <div key={item.id} className="queue-item">
            <span className="queue-content" title={summary}>
              {summary}
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
        );
      })}
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
          <div
            key={artifact.id}
            className="artifact-item"
            title={path ?? artifact.path}
          >
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
                if (path)
                  void revealLocalFile(
                    path,
                    workspacePath,
                    props.workspacePaths,
                  ).catch((cause) => {
                    onError(
                      `无法在文件夹中显示：${cause instanceof Error ? cause.message : String(cause)}`,
                    );
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
