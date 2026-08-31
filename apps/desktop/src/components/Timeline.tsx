import { FileText, FolderOpen } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Artifact, Message, PlanTask, Question, ToolCall } from "../types";
import type { PendingApproval } from "../App";
import {
  resolveWorkspacePath,
  revealLocalFile,
  type LocalFileTarget,
} from "../localFiles";
import { Md } from "./Md";

/** One-line human summary of a tool call's input. */
function summarize(call: ToolCall): string {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const s = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : null);
  return (
    s("path") ??
    s("command") ??
    s("url") ??
    s("query") ??
    s("pattern") ??
    s("name") ??
    s("prompt") ??
    ""
  );
}

const STATUS_ICON: Record<string, string> = {
  succeeded: "✓",
  failed: "✕",
  rejected: "⊘",
  cancelled: "⊘",
};

function ToolCallCard({
  call,
  onRollback,
}: {
  call: ToolCall;
  onRollback: (checkpointId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const running = call.status === "running" || call.status === "waiting_approval";
  const checkpointId =
    call.output && typeof call.output === "object"
      ? ((call.output as Record<string, unknown>).checkpointId as string | undefined)
      : undefined;
  const summary = summarize(call);

  return (
    <div className={`tool-line ${call.status}`}>
      <div className="tool-line-head" onClick={() => setOpen((v) => !v)}>
        {running ? (
          <span className="spinner" />
        ) : (
          <span className={`tool-status-icon ${call.status}`}>
            {STATUS_ICON[call.status] ?? "·"}
          </span>
        )}
        <span className="tool-name">{call.toolName}</span>
        {summary && <span className="tool-summary">{summary}</span>}
        <span style={{ flex: 1 }} />
        {checkpointId && call.status === "succeeded" && (
          <button
            className="ghost tool-rollback"
            onClick={(e) => {
              e.stopPropagation();
              onRollback(checkpointId);
            }}
          >
            回滚
          </button>
        )}
        <span className={`chevron ${open ? "open" : ""}`}>›</span>
      </div>
      {open && (
        <div className="tool-line-body">
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {call.output !== undefined && call.output !== null && (
            <pre>{JSON.stringify(call.output, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
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

function QuestionCard({
  question,
  onResolve,
}: {
  question: Question;
  onResolve: (questionId: string, answer: string) => void;
}) {
  const [custom, setCustom] = useState("");
  return (
    <div className="card approval-card">
      <div className="card-head">
        <span>miniQ 想确认</span>
      </div>
      <div style={{ marginTop: 6 }}>{question.prompt}</div>
      <div className="approval-actions" style={{ flexWrap: "wrap" }}>
        {question.options.map((opt) => (
          <button key={opt} onClick={() => onResolve(question.id, opt)}>
            {opt}
          </button>
        ))}
      </div>
      <div className="approval-actions">
        <input
          className="question-input"
          value={custom}
          placeholder="或者输入你的回答..."
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && custom.trim()) {
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

function PlanBar({ plan }: { plan: PlanTask[] }) {
  if (plan.length === 0) return null;
  const done = plan.filter((t) => t.status === "completed").length;
  return (
    <div className="plan-bar">
      <div className="plan-progress">
        任务计划 {done}/{plan.length}
      </div>
      {plan.map((task, i) => (
        <div key={i} className={`plan-task ${task.status}`}>
          <span className="plan-dot" />
          {task.content}
        </div>
      ))}
    </div>
  );
}

function ArtifactsBar(props: {
  artifacts: Artifact[];
  workspacePath?: string | null;
  onOpenFile: (target: LocalFileTarget) => void;
}) {
  const { artifacts, workspacePath, onOpenFile } = props;
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
                if (path) void revealLocalFile(path, workspacePath).catch(() => undefined);
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

type TimelineItem =
  | { kind: "message"; at: string; message: Message }
  | { kind: "tool"; at: string; call: ToolCall };

interface TimelineProps {
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  artifacts: Artifact[];
  workspacePath?: string | null;
  streamingText: string;
  busy: boolean;
  onResolveApproval: (approvalId: string, decision: string) => void;
  onResolveQuestion: (questionId: string, answer: string) => void;
  onRollback: (checkpointId: string) => void;
  onOpenFile: (target: LocalFileTarget) => void;
}

function createTimelineItems(messages: Message[], toolCalls: ToolCall[]): TimelineItem[] {
  return [
    ...messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        kind: "message" as const,
        at: message.createdAt,
        message,
      })),
    ...toolCalls.map((call) => ({ kind: "tool" as const, at: call.createdAt, call })),
  ].sort((left, right) => left.at.localeCompare(right.at));
}

function TimelineEntries(props: {
  items: TimelineItem[];
  approvals: PendingApproval[];
  questions: Question[];
  streamingText: string;
  thinking: boolean;
  onResolveApproval: TimelineProps["onResolveApproval"];
  onResolveQuestion: TimelineProps["onResolveQuestion"];
  onRollback: TimelineProps["onRollback"];
  onOpenFile: TimelineProps["onOpenFile"];
  workspacePath?: string | null;
}) {
  return (
    <div className="timeline-inner">
      {props.items.map((item) =>
        item.kind === "message" ? (
          item.message.role === "user" ? (
            <div key={item.message.id} className="bubble user">
              {!!item.message.images?.length && (
                <div className="message-images">
                  {item.message.images.map((image, index) => (
                    <img
                      key={`${item.message.id}-${index}`}
                      src={`data:${image.mediaType};base64,${image.data}`}
                      alt={`用户图片 ${index + 1}`}
                    />
                  ))}
                </div>
              )}
              {item.message.content && <div>{item.message.content}</div>}
            </div>
          ) : item.message.role === "tool" ? (
            <div key={item.message.id} className="bubble tool-transcript">
              <span>工具记录</span>
              <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile}>
                {item.message.content}
              </Md>
            </div>
          ) : (
            <div key={item.message.id} className="bubble assistant">
              <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile}>
                {item.message.content}
              </Md>
            </div>
          )
        ) : (
          <ToolCallCard key={item.call.id} call={item.call} onRollback={props.onRollback} />
        ),
      )}
      {props.approvals.map((approval) => (
        <ApprovalCard
          key={approval.approval.id}
          item={approval}
          onResolve={props.onResolveApproval}
        />
      ))}
      {props.questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          onResolve={props.onResolveQuestion}
        />
      ))}
      {props.streamingText && (
        <div className="bubble assistant">
          <Md workspacePath={props.workspacePath} onOpenFile={props.onOpenFile}>
            {props.streamingText}
          </Md>
          <span className="type-cursor" />
        </div>
      )}
      {props.thinking && (
        <div className="thinking">
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
        </div>
      )}
    </div>
  );
}

export function Timeline(props: TimelineProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  // Track whether the user is reading history (not pinned to bottom).
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  // Auto-follow only while pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [
    props.messages,
    props.toolCalls,
    props.approvals,
    props.questions,
    props.streamingText,
    props.busy,
  ]);

  const items = createTimelineItems(props.messages, props.toolCalls);
  const hasRunningTool = props.toolCalls.some(
    (t) => t.status === "running" || t.status === "waiting_approval",
  );
  const thinking =
    props.busy &&
    !props.streamingText &&
    !hasRunningTool &&
    props.approvals.length === 0 &&
    props.questions.length === 0;

  return (
    <>
      <PlanBar plan={props.plan} />
      <div className="timeline" ref={scrollRef} onScroll={onScroll}>
        <TimelineEntries
          items={items}
          approvals={props.approvals}
          questions={props.questions}
          streamingText={props.streamingText}
          thinking={thinking}
          onResolveApproval={props.onResolveApproval}
          onResolveQuestion={props.onResolveQuestion}
          onRollback={props.onRollback}
          onOpenFile={props.onOpenFile}
          workspacePath={props.workspacePath}
        />
      </div>
      <ArtifactsBar
        artifacts={props.artifacts}
        workspacePath={props.workspacePath}
        onOpenFile={props.onOpenFile}
      />
    </>
  );
}
