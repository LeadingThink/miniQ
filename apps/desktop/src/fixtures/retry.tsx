import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ExecutionPrelude } from "../components/ExecutionActivity";
import type { TurnProgress } from "../types";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/experience.css";

function Fixture() {
  const [phase, setPhase] = useState<TurnProgress["phase"]>("compacting_context");
  const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
  const progress: TurnProgress = {
    phase, startedAt,
    retry: { attempt: 3, maxAttempts: 10, delayMs: phase === "waiting_retry" ? 30_000 : 0 },
  };
  return <main style={{ maxWidth: 760, margin: "40px auto", padding: 16 }}>
    <select aria-label="请求阶段" value={phase} onChange={(event) => {
      setPhase(event.target.value as TurnProgress["phase"]);
      setStartedAt(new Date().toISOString());
    }}>
      <option value="waiting_retry">等待重试</option>
      <option value="requesting_model">请求模型</option>
      <option value="receiving_model">接收响应</option>
      <option value="compacting_context">压缩上下文</option>
    </select>
    <ExecutionPrelude plan={[]} progress={progress} />
  </main>;
}

if (import.meta.env.DEV) {
  const root = createRoot(document.getElementById("root")!);
  root.render(<Fixture />);
  import.meta.hot?.dispose(() => root.unmount());
}
