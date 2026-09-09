import type { ExecutionEventRecord } from "../modelDiagnostics";

function eventText(event: ExecutionEventRecord): [string, string] {
  switch (event.type) {
    case "context_compacted":
      return [
        "上下文压缩",
        `估算 tokens：${event.data.estimatedTokensBefore.toLocaleString()} → ${event.data.estimatedTokensAfter.toLocaleString()}`,
      ];
    case "model_retry": {
      const { retry, modelStep } = event.data.progress;
      return [
        "等待重试",
        `${modelStep == null ? "上下文压缩" : `步骤 ${modelStep}`} · ${retry ? `第 ${retry.attempt} / ${retry.maxAttempts} 次重试 · 等待 ${(retry.delayMs / 1000).toFixed(1)} 秒` : "未记录次数"}`,
      ];
    }
    case "queued_message_started":
      return [
        "排队消息已开始",
        `排队时间：${new Date(event.data.queuedAt).toLocaleString()}`,
      ];
    case "turn_outcome":
      return [
        "本轮结束",
        (
          {
            completed: "已完成",
            idle: "已完成",
            failed: "失败",
            cancelled: "已停止",
          } as Record<string, string>
        )[event.data.status] ?? event.data.status,
      ];
  }
}

export function ExecutionEvent({ event }: { event: ExecutionEventRecord }) {
  const [title, description] = eventText(event);
  const agentId = "agentId" in event.data ? event.data.agentId : null;
  return (
    <article className="model-call">
      <strong>{title}</strong>
      <div className="model-call-meta">
        <time dateTime={event.createdAt}>
          {new Date(event.createdAt).toLocaleString()}
        </time>
        <span>{agentId ? `子任务 ${agentId}` : "主任务"}</span>
      </div>
      <p>{description}</p>
      <details>
        <summary>事件详情</summary>
        <pre>{JSON.stringify(event, null, 2)}</pre>
      </details>
    </article>
  );
}
