import { useEffect, useRef, useState } from "react";
import type { Artifact, Message, PlanTask, Question, ToolCall } from "../types";
import type { PendingApproval } from "../App";
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

function ArtifactsBar({ artifacts }: { artifacts: Artifact[] }) {
  if (artifacts.length === 0) return null;
  return (
    <div className="artifacts-bar">
      <div className="plan-progress">交付产物</div>
      {artifacts.map((a) => (
        <div key={a.id} className="artifact-item" title={a.path}>
          <span className="badge">{a.kind}</span>
          <span className="artifact-title">{a.title}</span>
          <span className="sub">{a.path}</span>
        </div>
      ))}
    </div>
  );
}

export function Timeline(props: {
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  questions: Question[];
  plan: PlanTask[];
  artifacts: Artifact[];
  streamingText: string;
  busy: boolean;
  onResolveApproval: (approvalId: string, decision: string) => void;
  onResolveQuestion: (questionId: string, answer: string) => void;
  onRollback: (checkpointId: string) => void;
}) {
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

  const items: Array<
    | { kind: "message"; at: string; message: Message }
    | { kind: "tool"; at: string; call: ToolCall }
  > = [
    ...props.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...props.toolCalls.map((t) => ({ kind: "tool" as const, at: t.createdAt, call: t })),
  ].sort((a, b) => a.at.localeCompare(b.at));

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
        <div className="timeline-inner">
          {items.map((item) =>
            item.kind === "message" ? (
              item.message.role === "user" ? (
                <div key={item.message.id} className="bubble user">
                  {item.message.content}
                </div>
              ) : (
                <div key={item.message.id} className="bubble assistant">
                  <Md>{item.message.content}</Md>
                </div>
              )
            ) : (
              <ToolCallCard
                key={item.call.id}
                call={item.call}
                onRollback={props.onRollback}
              />
            ),
          )}
          {props.approvals.map((a) => (
            <ApprovalCard
              key={a.approval.id}
              item={a}
              onResolve={props.onResolveApproval}
            />
          ))}
          {props.questions.map((q) => (
            <QuestionCard key={q.id} question={q} onResolve={props.onResolveQuestion} />
          ))}
          {props.streamingText && (
            <div className="bubble assistant">
              <Md>{props.streamingText}</Md>
              <span className="type-cursor" />
            </div>
          )}
          {thinking && (
            <div className="thinking">
              <span className="thinking-dot" />
              <span className="thinking-dot" />
              <span className="thinking-dot" />
            </div>
          )}
        </div>
      </div>
      <ArtifactsBar artifacts={props.artifacts} />
    </>
  );
}
