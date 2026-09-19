import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Timeline } from "../components/Timeline";
import type { Message } from "../types";
import "../styles/base.css";
import "../styles/themes.css";
import "../styles/conversation.css";
import "../styles/interactions.css";
import "../styles/experience.css";
import "../components/ConversationNavigationRail.css";

// Isolated pagination and streaming fixture; never connects to a daemon/provider.
const messages: Message[] = Array.from({ length: 120 }, (_, index) => ({
  id: `message-${index}`,
  sessionId: "history-fixture",
  role: index % 2 ? "assistant" : "user",
  content: index % 2
    ? `第 ${Math.floor(index / 2) + 1} 轮检查结果\n\n已检查任务、工具执行与交付产物。\n\n- 查看历史时保持当前阅读位置\n- 继续输出时不抢走滚动位置\n- 远程连接继续按页传输\n\n可以继续下一项验证。`
    : `第 ${Math.floor(index / 2) + 1} 个要求：检查长会话中的交互与连续加载。`,
  createdAt: new Date(Date.UTC(2026, 8, 20, 8, index)).toISOString(),
}));
const noop = () => undefined;
const asyncNoop = async () => undefined;

function Fixture() {
  const [start, setStart] = useState(100);
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState(0);
  const [failNext, setFailNext] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [notice, setNotice] = useState("");
  const [stream, setStream] = useState("");
  const pending = useRef(false);
  const loadOlder = async () => {
    if (pending.current || start === 0) return;
    pending.current = true;
    setLoading(true);
    setRequests((value) => value + 1);
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (failNext) {
      setNotice("模拟失败：应停止自动重试，点击顶部按钮可再次加载。");
      setFailNext(false);
    } else {
      setStart((value) => Math.max(0, value - 20));
      setNotice("");
    }
    setLoading(false);
    pending.current = false;
  };
  return (
    <main style={{ height: "100dvh", display: "flex", flexDirection: "column", padding: "12px 20px", boxSizing: "border-box" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", paddingBottom: 12 }}>
        <strong>连续会话验收</strong>
        <output data-testid="page-status">已加载 {120 - start}/120 条 · 请求 {requests} 次</output>
        <button onClick={() => setFailNext(true)}>下一页模拟失败</button>
        <button onClick={() => setStream((value) => `${value}\n\n最新任务仍在输出，历史阅读位置应保持稳定。`)}>追加流式输出</button>
        <button onClick={() => setNarrow((value) => !value)}>切换窄聊天区域</button>
      </header>
      {notice && <div role="status">{notice}</div>}
      <section style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, width: narrow ? "min(100%, 700px)" : "100%", margin: "0 auto" }}>
        <Timeline
          sessionId="history-fixture"
          messages={messages.slice(start)}
          toolCalls={[]}
          historyCursor={start ? { at: messages[start].createdAt, id: messages[start].id } : null}
          loadingOlder={loading}
          onLoadOlder={loadOlder}
          approvals={[]}
          questions={[]}
          plan={[]}
          artifacts={[]}
          queue={[]}
          streamingText={stream}
          turnProgress={null}
          busy={Boolean(stream)}
          onResolveApproval={noop}
          onResolveQuestion={noop}
          onRollback={noop}
          onOpenFile={noop}
          onOpenUrl={noop}
          onSteerQueued={asyncNoop}
          onRemoveQueued={asyncNoop}
          onUpdateQueued={asyncNoop}
          onRewrite={async () => true}
          onError={setNotice}
        />
      </section>
    </main>
  );
}

if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
