import { useEffect, useRef } from "react";
import type { Message, ToolCall } from "../types";
import type { PendingApproval } from "../App";

function ToolCallCard({ call }: { call: ToolCall }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="tool-name">{call.toolName}</span>
        <span className={`badge ${call.status}`}>{call.status}</span>
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

export function Timeline(props: {
  messages: Message[];
  toolCalls: ToolCall[];
  approvals: PendingApproval[];
  streamingText: string;
  onResolveApproval: (approvalId: string, decision: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [props.messages, props.toolCalls, props.approvals, props.streamingText]);

  // Merge messages and tool calls chronologically.
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
    <div className="timeline">
      {items.map((item) =>
        item.kind === "message" ? (
          <div key={item.message.id} className={`bubble ${item.message.role}`}>
            {item.message.content}
          </div>
        ) : (
          <ToolCallCard key={item.call.id} call={item.call} />
        ),
      )}
      {props.approvals.map((a) => (
        <ApprovalCard
          key={a.approval.id}
          item={a}
          onResolve={props.onResolveApproval}
        />
      ))}
      {props.streamingText && (
        <div className="bubble assistant">{props.streamingText}</div>
      )}
      <div ref={endRef} />
    </div>
  );
}
