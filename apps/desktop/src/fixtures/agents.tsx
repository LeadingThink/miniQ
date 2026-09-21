import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AgentPanel } from "../components/AgentPanel";
import type { AgentSummary } from "../components/AgentSummary";
import type { RpcClient } from "../rpc";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/experience.css";

const initial: AgentSummary[] = [
  { agentId: "research", parentId: null, name: "资料研究", description: "核对三份参考资料的来源与时间。", status: "running", model: "gemini-3.8-flash", createdAt: new Date().toISOString(), queuedMessages: 0, error: null, progress: { phase: "receiving_model", modelStep: 4, startedAt: new Date().toISOString() } },
  { agentId: "review", parentId: null, name: "代码审阅", description: "检查修改是否保持兼容，并复核测试证据。", status: "running", model: "gpt-5.6-sol", createdAt: new Date().toISOString(), queuedMessages: 0, error: null, progress: { phase: "requesting_model", modelStep: 2, startedAt: new Date().toISOString() } },
  { agentId: "images", parentId: null, name: "素材整理", description: "输出已经核实的图片素材索引。", status: "completed", model: "gpt-5.6-sol", createdAt: new Date().toISOString(), queuedMessages: 0, error: null, result: "素材索引已完成，4 个文件均可读取。", elapsedMs: 12000 },
  { agentId: "checks", parentId: "review", name: "移动端验收", description: "在窄屏中检查远程预览。", status: "interrupted", model: "claude-opus", createdAt: new Date().toISOString(), queuedMessages: 0, error: "验收连接中断；已保留检查结果。", elapsedMs: 7000, timingComplete: false },
];

function Fixture() {
  const [agents, setAgents] = useState(initial);
  const [session, setSession] = useState("sample");
  const [notice, setNotice] = useState("所有数据均为样例，不连接真实会话或模型。");
  const current = useRef(agents);
  current.current = agents;
  const failOnce = useRef(false);
  const listeners = useRef(new Set<(connected: boolean) => void>());
  const client = useMemo(() => ({
    call: async (method: string, params: { sessionId: string; agentId?: string }) => {
      if (method === "agent.list") {
        if (failOnce.current) { failOnce.current = false; throw new Error("样例：连接暂时中断"); }
        return { agents: params.sessionId === "sample" ? current.current : [] };
      }
      if (method === "agent.output") return current.current.find((agent) => agent.agentId === params.agentId);
      if (method === "agent.stop") {
        setAgents((items) => items.map((agent) => agent.agentId === params.agentId ? { ...agent, status: "cancelled", progress: null } : agent));
        return {};
      }
      if (method === "session.history") return { toolCalls: [], messages: [], nextCursor: null };
      if (method === "agent.history") return { entries: [], nextCursor: null };
      if (method === "session.modelCalls") return { calls: [], nextCursor: null };
      if (method === "session.executionEvents") return { events: [], nextCursor: null };
      throw new Error(`样例不支持 ${method}`);
    },
    onStatus: (listener: (connected: boolean) => void) => { listeners.current.add(listener); return () => listeners.current.delete(listener); },
  }) as unknown as RpcClient, []);
  const refresh = () => { for (const listener of listeners.current) listener(true); };
  return (
    <main style={{ maxWidth: 1040, margin: "32px auto", padding: 16 }}>
      <h1>子任务状态与恢复验收</h1>
      <p>{notice}</p>
      <nav style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        <button onClick={() => { setAgents(initial); setSession("sample"); setNotice("已恢复两项执行中、一项完成和一项异常。状态条代表实际数量，不是任务进度百分比。"); }}>恢复样例</button>
        <button onClick={() => { failOnce.current = true; refresh(); setNotice("本次刷新将失败；保留最近数据，5 秒后自动恢复。也可以点刷新立即恢复。"); }}>模拟临时断连</button>
        <button onClick={() => { refresh(); setNotice("已模拟重连，立即重新读取状态。"); }}>模拟重连</button>
        <button onClick={() => { setAgents((items) => items.map((agent) => ({ ...agent, status: "completed", progress: null, result: "已完成并保留结果。" }))); setNotice("全部完成；等待下一次轮询或点击模拟重连。"); }}>全部完成</button>
        <button onClick={() => setSession((value) => value === "sample" ? "empty" : "sample")}>{session === "sample" ? "切换到空会话" : "回到样例会话"}</button>
      </nav>
      <AgentPanel client={client} sessionId={session} busy={false} />
      <p style={{ color: "var(--text-dim)", marginTop: 20 }}>验收：折叠时可读数量与异常；展开后查看阶段/轮次；异常筛选；停止子任务；临时断连自动恢复；切换会话不混入旧状态。</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
