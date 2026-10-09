import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "../components/Timeline";
import { Composer } from "../components/Composer";
import type { Message, PlanTask, ToolCall, TurnTiming } from "../types";
import type { RpcClient } from "../rpc";
import { applyTheme } from "../theme";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/experience.css";
import "../components/ConversationNavigationRail.css";

// Local UI fixture only. No daemon, network requests, credentials or model calls.
const now = Date.now();
const iso = (offset: number) => new Date(now + offset).toISOString();
const noop = () => undefined;
const asyncNoop = async () => undefined;
const message = (id: string, role: "user" | "assistant", content: string, offset: number, turnTiming?: TurnTiming): Message => ({
  id, sessionId: "time-demo", role, content, createdAt: iso(offset), turnTiming,
});
const history: Message[] = [
  message("yesterday", "user", "整理三份资料，给出可以直接使用的结论。", -86_400_000, {
    startedAt: iso(-86_400_000), completedAt: iso(-86_317_000), elapsedMs: 83_000, status: "completed",
  }),
  message("answer", "assistant", "资料已整理。\n\n- 完成三份资料的交叉检查\n- 标出了两个待确认的差异\n- 汇总了后续执行顺序", -86_317_000),
  message("stopped", "user", "先开始核查部署步骤。", -3_600_000, {
    startedAt: iso(-3_600_000), completedAt: iso(-3_574_000), elapsedMs: 26_000, status: "cancelled",
  }),
  message("partial", "assistant", "已完成环境检查，收到停止指令，现有结果已保留。", -3_574_000),
];
const plan: PlanTask[] = [
  { content: "确认接口与测试数据", status: "completed" },
  { content: "读取请求模型，确定压测接口", status: "in_progress" },
  { content: "执行并发与流式响应测试", status: "pending" },
  { content: "整理测试结果与运行说明", status: "pending" },
];
const calls: ToolCall[] = ["list_directory", "git_status", "file_read"].map((toolName, index) => ({
  id: `tool-${index}`, sessionId: "time-demo", toolName, input: {}, status: "succeeded", createdAt: iso(-80_000 + index * 1_000),
}));

function Fixture() {
  const [busy, setBusy] = useState(true);
  const [dark, setDark] = useState(false);
  const [remote, setRemote] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [ended, setEnded] = useState<TurnTiming | null>(null);
  const timing: TurnTiming = ended ?? { startedAt: iso(-90_000), status: "running" };
  const active = message("active", "user", "继续刚才的工作，核对两处差异并给出最终结果。", -90_000, timing);
  const messages = [...history, active, ...(busy ? [] : [message("final", "assistant", "核查已完成，两处差异都已说明。整轮计时已停止，可展开查看开始和结束时间。", Date.parse(ended!.completedAt!) - now)])];
  const complete = () => {
    setEnded({ ...timing, completedAt: new Date().toISOString(), elapsedMs: Date.now() - Date.parse(timing.startedAt), status: "completed" });
    setBusy(false);
  };
  return <main data-theme={dark ? "dark" : "light"} style={{ height: "100dvh", display: "flex", flexDirection: "column", background: "var(--bg)", color: "var(--text)" }}>
    <header style={{ padding: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
      <strong>时间与用时验收</strong>
      <button onClick={complete} disabled={!busy}>模拟完成</button>
      <button onClick={() => { setDark(!dark); applyTheme(dark ? "jade" : "night"); }}>切换主题</button>
      <button onClick={() => setRemote(!remote)}>{remote ? "本地显示" : "远程分页显示"}</button>
      <button onClick={() => setCompacting(!compacting)}>{compacting ? "模拟生成回复" : "模拟整理上下文"}</button>
    </header>
    <Timeline messages={messages} toolCalls={calls} approvals={[]} questions={[]} plan={plan} artifacts={[]} queue={[]}
      client={remote ? { mode: "remote" } as RpcClient : undefined}
      historyCursor={remote ? { id: "older", at: iso(-172_800_000) } : null} onLoadOlder={asyncNoop}
      latestTurnTiming={{ messageId: active.id, timing }}
      streamingText={busy ? "正在核对资料中的两处差异。阶段切换不会重置整轮用时。" : ""}
      turnProgress={busy ? { phase: compacting ? "compacting_context" : "receiving_model", modelStep: 3, startedAt: iso(-5_000) } : null} busy={busy}
      onResolveApproval={noop} onResolveQuestion={noop} onRollback={noop} onOpenFile={noop} onOpenUrl={noop}
      onSteerQueued={asyncNoop} onRemoveQueued={asyncNoop} onUpdateQueued={asyncNoop} onRewrite={async () => true} onError={noop} />
    <Composer busy={busy} chip="miniQ" onSend={noop} onCancel={complete} />
  </main>;
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
