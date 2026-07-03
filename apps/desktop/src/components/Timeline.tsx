import { useEffect, useRef, useState } from "react";
import type { Artifact, Message, PlanTask, Question, ToolCall } from "../types";
import type { PendingApproval } from "../App";

function ToolCallCard({
  call,
  onRollback,
}: {
  call: ToolCall;
  onRollback: (checkpointId: string) => void;
}) {
  const checkpointId =
    call.output && typeof call.output === "object"
      ? ((call.output as Record<string, unknown>).checkpointId as string | undefined)
      : undefined;
  return (
    <div className="card">
      <div className="card-head">
        <span className="tool-name">{call.toolName}</span>
        <span className={`badge ${call.status}`}>{call.status}</span>
        {checkpointId && call.status === "succeeded" && (
          <button className="secondary" onClick={() => onRollback(checkpointId)}>
            Rollback
          </button>
        )}
      </div>
      <pre>{JSON.stringify(call.input, null, 2)}</pre>
      {call.output !== undefined && call.output !== null && (
        <pre>{JSON.stringify(call.output, null, 2)}</pre>
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
        <span>Approval required</span>
        <span className="tool-name">{item.toolName}</span>
        <span className={`badge ${item.approval.riskLevel}`}>
          {item.approval.riskLevel}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>{item.approval.reason}</div>
      <pre>{JSON.stringify(item.input, null, 2)}</pre>
      <div className="approval-actions">
        <button onClick={() => onResolve(item.approval.id, "approve")}>
          Allow once
        </button>
        <button
          className="secondary"
          onClick={() => onResolve(item.approval.id, "approve_for_session")}
        >
          Allow for this session
        </button>
        <button className="danger" onClick={() => onResolve(item.approval.id, "reject")}>
          Reject
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
        <span>miniQ asks</span>
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
          placeholder="Or type your own answer..."
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
          Answer
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
        Plan {done}/{plan.length}
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
      <div className="plan-progress">Deliverables</div>
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
  onResolveApproval: (approvalId: string, decision: string) => void;
  onResolveQuestion: (questionId: string, answer: string) => void;
  onRollback: (checkpointId: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [
    props.messages,
    props.toolCalls,
    props.approvals,
    props.questions,
    props.streamingText,
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

  return (
    <>
      <PlanBar plan={props.plan} />
      <div className="timeline">
        <div className="timeline-inner">
          {items.map((item) =>
            item.kind === "message" ? (
              <div key={item.message.id} className={`bubble ${item.message.role}`}>
                {item.message.content}
              </div>
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
            <div className="bubble assistant">{props.streamingText}</div>
          )}
          <div ref={endRef} />
        </div>
      </div>
      <ArtifactsBar artifacts={props.artifacts} />
    </>
  );
}
